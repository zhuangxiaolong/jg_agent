import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { discoverGrokRuntime, GrokSettingsService } from '../apps/desktop/src/main/grok-settings';
import { SettingsService } from '../apps/desktop/src/main/settings';
import type { CredentialStore } from '../apps/desktop/src/main/credentials';
import type { ProviderProfile } from '../packages/domain/src';
import { LocalStore } from '../packages/storage/src';
import { normalizeGrokBaseUrl, type GrokCompatibilityResult } from '../packages/domain/src/grok';

const providerId = '00000000-0000-4000-8000-000000000001';
const baseUrl = 'https://relay.example.invalid/v1';
const modelId = 'grok-test';
const passed: GrokCompatibilityResult = { level: 'agent', status: 'passed', checkedAt: '2026-11-12T00:00:00Z', detail: '合成协议测试通过' };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-grok-settings-'));
  const filename = path.join(root, 'agent.db'); const store = await LocalStore.open(filename);
  const secrets = new Map<string, { key: string; scope?: string }>();
  const writes: Array<{ id: string; scope?: string }> = [];
  const settings = new GrokSettingsService(store, root, () => undefined);
  const credential = (id: string) => ({
    get hasKey() { return secrets.has(id); },
    read: (scope?: string) => { const record = secrets.get(id); if (record && scope && record.scope !== scope) throw new Error('凭据与服务不匹配'); return record?.key; },
    save: (key: string, scope?: string) => { secrets.set(id, { key, scope }); writes.push({ id, scope }); },
    delete: () => { secrets.delete(id); },
  }) as CredentialStore;
  t.mock.method(settings, 'credential', credential);
  const seed = (patch: Partial<ProviderProfile> = {}, key = 'synthetic-shared-key') => {
    const provider: ProviderProfile = { id: providerId, name: '共享模型中转站', baseUrl, models: [modelId], modelCatalog: [{ id: modelId, name: 'Grok 测试模型' }], hasKey: false, ...patch };
    store.saveModelProvider(provider);
    if (key) secrets.set(provider.id, { key, scope: provider.baseUrl });
    return provider;
  };
  return { root, filename, store, settings, secrets, writes, credential, seed, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('Grok 地址规范化只补根路径 /v1，拒绝凭据/查询参数与非法代理', () => {
  assert.equal(normalizeGrokBaseUrl(' https://relay.example.invalid/ '), baseUrl);
  assert.equal(normalizeGrokBaseUrl('https://relay.example.invalid/v1///'), baseUrl);
  assert.equal(normalizeGrokBaseUrl('https://relay.example.invalid/custom/api/'), 'https://relay.example.invalid/custom/api');
  for (const url of ['http://relay.invalid', 'https://user:pass@relay.invalid', 'https://relay.invalid?token=x', 'https://relay.invalid#x']) assert.throws(() => normalizeGrokBaseUrl(url));
});

test('Grok 直接映射模型中转站和凭据，默认 Chat Completions，不要求重复保存密钥', async t => {
  const f = await fixture(t);
  try {
    f.store.saveRuntimeKind('claude_agent_sdk');
    f.seed({ models: [modelId, 'other-model'] });
    const before = await readFile(f.filename);
    const profile = f.settings.profiles()[0];
    assert.equal(profile.id, providerId); assert.equal(profile.name, '共享模型中转站');
    assert.equal(profile.baseUrl, baseUrl); assert.equal(profile.hasKey, true); assert.equal(profile.enabled, true);
    assert.deepEqual(profile.models, [
      { id: modelId, name: 'Grok 测试模型', enabled: true, apiBackend: 'chat_completions' },
      { id: 'other-model', name: 'other-model', enabled: true, apiBackend: 'chat_completions' },
    ]);
    assert.equal(profile.models[0].compatibility, undefined);
    assert.equal(f.settings.apiKey(providerId), 'synthetic-shared-key');
    assert.equal(JSON.stringify(f.settings.snapshot()).includes('synthetic-shared-key'), false);
    assert.equal((await readFile(f.filename)).includes(Buffer.from('synthetic-shared-key')), false);
    assert.deepEqual(await readFile(f.filename), before); assert.deepEqual(f.writes, []);
    assert.deepEqual(f.store.listGrokProviders(), []);
    assert.equal(f.store.getRuntimeKind(), 'claude_agent_sdk'); assert.equal(f.store.getGrokRuntime().enabled, false);
  } finally { await f.close(); }
});

test('Grok 与通用设置读取同一 DPAPI 文件，兼容 legacy-default 原凭据作用域', async t => {
  const f = await fixture(t);
  try {
    const grok = new GrokSettingsService(f.store, f.root, () => undefined);
    const shared = new SettingsService(f.store, f.root, () => undefined);
    const filename = (value: CredentialStore) => (value as unknown as { filename: string }).filename;
    for (const id of [providerId, 'legacy-default']) assert.equal(filename(grok.credential(id)), filename(shared.credential(id)));
    assert.equal(filename(grok.credential(providerId)), path.join(f.root, 'config/secrets', `${providerId}.dpapi`));
    assert.equal(filename(grok.credential('legacy-default')), path.join(f.root, 'config/model-key.dpapi'));
    f.seed({ id: 'legacy-default', baseUrl: 'https://relay.example.invalid' });
    const profile = f.settings.profiles()[0];
    assert.equal(profile.id, 'legacy-default'); assert.equal(profile.baseUrl, baseUrl); assert.equal(profile.hasKey, true);
    assert.equal(f.settings.apiKey('legacy-default'), 'synthetic-shared-key');
    assert.throws(() => f.settings.credential(profile.id).read(baseUrl), /不匹配/);
    assert.equal(f.settings.saveModels('legacy-default', [{ id: modelId, apiBackend: 'responses' }]).models[0].apiBackend, 'responses');
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('共享中转站新增、模型与名称修改、凭据删除及中转站删除立即反映到 Grok', async t => {
  const f = await fixture(t);
  try {
    assert.deepEqual(f.settings.profiles(), []);
    const provider = f.seed();
    assert.equal(f.settings.profiles().length, 1);
    f.store.saveModelProvider({ ...provider, name: '共享改名', models: [modelId, 'added-model'], modelCatalog: [{ id: modelId, name: '新模型名' }] });
    assert.equal(f.settings.profiles()[0].name, '共享改名');
    assert.deepEqual(f.settings.profiles()[0].models.map(model => [model.id, model.name]), [[modelId, '新模型名'], ['added-model', 'added-model']]);
    f.secrets.delete(providerId); assert.equal(f.settings.profiles()[0].hasKey, false);
    f.store.deleteModelProvider(providerId); assert.deepEqual(f.settings.profiles(), []);
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('Grok 只保存共享模型的协议且重开保留，不修改共享中转站或凭据', async t => {
  const f = await fixture(t); let reopened: LocalStore | undefined;
  try {
    const provider = f.seed({ models: [modelId, 'other-model'] });
    const saved = f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'responses' }, { id: 'other-model', apiBackend: 'messages' }]);
    assert.deepEqual(saved.models.map(model => [model.id, model.apiBackend]), [[modelId, 'responses'], ['other-model', 'messages']]);
    assert.equal(JSON.stringify(f.settings.snapshot()).includes('sharedIdentity'), false);
    assert.deepEqual(f.store.listProviders(), [provider]); assert.deepEqual(f.writes, []);
    f.store.close(); reopened = await LocalStore.open(f.filename);
    const service = new GrokSettingsService(reopened, f.root, () => undefined); t.mock.method(service, 'credential', f.credential);
    assert.deepEqual(service.profiles()[0].models.map(model => [model.id, model.apiBackend]), [[modelId, 'responses'], ['other-model', 'messages']]);
    assert.equal(service.profiles()[0].hasKey, true);
    assert.equal((await readFile(f.filename)).includes(Buffer.from('synthetic-shared-key')), false);
  } finally { reopened?.close(); await f.close(); }
});

test('Grok 兼容性按共享地址、密钥、模型和协议失效，显示名称修改保留，客户端不能伪造通过', async t => {
  const f = await fixture(t);
  try {
    const provider = f.seed();
    f.settings.saveCompatibility(providerId, modelId, passed);
    assert.equal(f.settings.profiles()[0].models[0].compatibility?.level, 'agent');
    f.store.saveModelProvider({ ...provider, name: '新名称', modelCatalog: [{ id: modelId, name: '模型新名称' }] });
    assert.equal(f.settings.profiles()[0].models[0].compatibility?.level, 'agent');
    f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'responses', compatibility: passed }]);
    assert.equal(f.settings.profiles()[0].models[0].compatibility, undefined);
    f.settings.saveCompatibility(providerId, modelId, passed);
    f.secrets.set(providerId, { key: 'synthetic-new-key', scope: baseUrl });
    assert.equal(f.settings.profiles()[0].models[0].compatibility, undefined);
    assert.equal(f.settings.profiles()[0].models[0].apiBackend, 'responses');
    f.settings.saveCompatibility(providerId, modelId, passed);
    f.store.saveModelProvider({ ...provider, baseUrl: 'https://other.invalid/v1' });
    assert.equal(f.settings.profiles()[0].hasKey, false);
    assert.equal(f.settings.profiles()[0].models[0].compatibility, undefined);
    f.secrets.set(providerId, { key: 'synthetic-new-key', scope: 'https://other.invalid/v1' });
    assert.equal(f.settings.profiles()[0].models[0].compatibility, undefined);
    f.settings.saveCompatibility(providerId, modelId, passed);
    f.store.saveModelProvider({ ...provider, baseUrl: 'https://other.invalid/v1', models: ['new-model'] });
    assert.equal(f.settings.profiles()[0].models[0].compatibility, undefined);
    assert.throws(() => f.settings.saveCompatibility(providerId, modelId, passed), /不存在|无效/);
  } finally { await f.close(); }
});

test('Grok 连接测试期间共享地址、密钥或协议变化时，旧结论不能覆盖当前配置的测试结果', async t => {
  for (const changed of ['baseUrl', 'key', 'backend'] as const) {
    await t.test(changed, async t => {
      const f = await fixture(t);
      try {
        const provider = f.seed();
        f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'responses' }]);
        const originalIdentity = f.settings.configurationIdentity(providerId, modelId);
        if (changed === 'baseUrl') {
          f.store.saveModelProvider({ ...provider, baseUrl: 'https://changed.invalid/v1' });
          f.secrets.set(providerId, { key: 'synthetic-shared-key', scope: 'https://changed.invalid/v1' });
        } else if (changed === 'key') f.secrets.set(providerId, { key: 'synthetic-changed-key', scope: baseUrl });
        else f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'messages' }]);
        const currentIdentity = f.settings.configurationIdentity(providerId, modelId);
        assert.notEqual(currentIdentity, originalIdentity);
        const currentResult: GrokCompatibilityResult = { ...passed, status: 'failed', level: 'text', detail: '当前配置合成失败结论' };
        f.settings.saveCompatibility(providerId, modelId, currentResult, currentIdentity);
        const before = await readFile(f.filename);
        assert.throws(() => f.settings.saveCompatibility(providerId, modelId, passed, originalIdentity), /变化|重新测试/);
        assert.deepEqual(f.settings.profiles()[0].models[0].compatibility, currentResult);
        assert.deepEqual(await readFile(f.filename), before); assert.deepEqual(f.writes, []);
      } finally { await f.close(); }
    });
  }
});

test('Grok 配置和测试结论使用共享密钥脱敏，不能把密钥写入 Runtime 元数据', async t => {
  const f = await fixture(t);
  try {
    f.seed({}, 'synthetic-shared-secret');
    const result = f.settings.saveCompatibility(providerId, modelId, { ...passed, detail: '回显 synthetic-shared-secret\n已脱敏' });
    assert.equal(result.detail, '回显 [已脱敏] 已脱敏');
    assert.equal(f.settings.redact('凭据 synthetic-shared-secret'), '凭据 [已脱敏]');
    assert.equal((await readFile(f.filename)).includes(Buffer.from('synthetic-shared-secret')), false);
    assert.throws(() => f.settings.saveRuntime({ enabled: true, executablePath: path.join(f.root, 'synthetic-shared-secret') }), /API Key|凭据/);
  } finally { await f.close(); }
});

test('Grok 协议配置拒绝未知共享中转站、模型、重复模型和无效 backend，不创建中转站', async t => {
  const f = await fixture(t);
  try {
    f.seed(); const before = await readFile(f.filename);
    assert.throws(() => f.settings.saveModels('00000000-0000-4000-8000-000000000099', [{ id: modelId, apiBackend: 'responses' }]), /不存在|无效/);
    assert.throws(() => f.settings.saveModels(providerId, [{ id: 'missing', apiBackend: 'responses' }]), /不存在|无效/);
    assert.throws(() => f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'responses' }, { id: modelId, apiBackend: 'messages' }]), /重复|无效/);
    assert.throws(() => f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'invalid' }]), /invalid|无效|chat_completions/);
    assert.deepEqual(await readFile(f.filename), before); assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('Grok 协议写盘失败保留共享配置、原协议和密钥，不进行额外凭据写入', async t => {
  const f = await fixture(t);
  try {
    const provider = f.seed();
    f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'chat_completions' }]);
    const before = await readFile(f.filename);
    t.mock.method(f.store, 'saveGrokProvider', () => { throw new Error('合成写盘失败'); });
    assert.throws(() => f.settings.saveModels(providerId, [{ id: modelId, apiBackend: 'responses' }]), /写盘失败/);
    assert.equal(f.settings.profiles()[0].models[0].apiBackend, 'chat_completions');
    assert.deepEqual(f.store.listProviders(), [provider]); assert.deepEqual(await readFile(f.filename), before);
    assert.deepEqual(f.secrets.get(providerId), { key: 'synthetic-shared-key', scope: baseUrl }); assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('旧独立 Grok 中转站和上游环境凭据不作为共享配置回退', async t => {
  const f = await fixture(t);
  try {
    f.store.saveGrokProvider({ id: providerId, name: '旧 Grok 专用配置', baseUrl, enabled: true, hasKey: false, models: [{ id: modelId, name: '旧模型', apiBackend: 'responses', enabled: true }] });
    f.secrets.set(providerId, { key: 'synthetic-legacy-key', scope: baseUrl });
    const original = process.env.XAI_API_KEY;
    try {
      process.env.XAI_API_KEY = 'synthetic-xai-key';
      assert.deepEqual(f.settings.profiles(), []);
      f.seed({}, ''); f.secrets.delete(providerId);
      assert.equal(f.settings.profiles()[0].hasKey, false);
      assert.equal(f.settings.profiles()[0].models[0].apiBackend, 'chat_completions');
    } finally { if (original === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = original; }
    assert.deepEqual(f.writes, []);
  } finally { await f.close(); }
});

test('Grok Runtime 与协议修改遵循运行锁，不改变共享默认 Runtime 或凭据', async t => {
  const f = await fixture(t);
  try {
    f.seed(); f.store.saveRuntimeKind('codex');
    f.settings.saveRuntime({ enabled: true, executablePath: path.join(f.root, 'grok.exe'), proxyUrl: 'http://127.0.0.1:7897' });
    assert.deepEqual(f.store.getGrokRuntime(), { enabled: true, executablePath: path.join(f.root, 'grok.exe'), proxyUrl: 'http://127.0.0.1:7897' });
    assert.equal(f.store.getRuntimeKind(), 'codex');
    for (const proxyUrl of ['http://user:pass@127.0.0.1:7897', 'socks5://127.0.0.1:7897', 'http://127.0.0.1:7897/path', 'http://127.0.0.1:7897?x=y']) assert.throws(() => f.settings.saveRuntime({ enabled: false, executablePath: '', proxyUrl }));
    const locked = new GrokSettingsService(f.store, f.root, () => { throw new Error('当前会话运行中'); });
    assert.throws(() => locked.saveRuntime({}), /运行中/); assert.throws(() => locked.saveModels(providerId, []), /运行中/);
    assert.deepEqual(f.writes, []); assert.equal(f.secrets.get(providerId)?.key, 'synthetic-shared-key');
  } finally { await f.close(); }
});

test('Grok 自动发现本机 Runtime，无需启用或绑定模型，历史失效路径可回退已安装组件', () => {
  const installed = path.resolve('installed', 'grok.exe');
  const configured = path.resolve('custom', 'grok.exe');
  const empty = { enabled: false, executablePath: '' };
  assert.deepEqual(discoverGrokRuntime(empty, installed, filename => filename === installed), { enabled: true, executablePath: installed });
  assert.deepEqual(discoverGrokRuntime({ enabled: false, executablePath: configured }, installed, filename => filename === installed), { enabled: true, executablePath: installed });
  assert.deepEqual(discoverGrokRuntime({ enabled: false, executablePath: configured, proxyUrl: 'http://127.0.0.1:7897' }, installed, () => true), { enabled: true, executablePath: installed, proxyUrl: 'http://127.0.0.1:7897' });
  assert.deepEqual(discoverGrokRuntime({ enabled: false, executablePath: configured }, installed, filename => filename === configured), { enabled: true, executablePath: configured });
  assert.deepEqual(discoverGrokRuntime(empty, installed, () => false), { enabled: false, executablePath: installed });
});

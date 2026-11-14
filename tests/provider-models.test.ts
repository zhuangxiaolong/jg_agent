import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsService } from '../apps/desktop/src/main/settings';
import type { CredentialStore } from '../apps/desktop/src/main/credentials';
import { modelProfileSchema, providerModelsSchema } from '../apps/desktop/src/main/security';
import { LocalStore } from '../packages/storage/src';

const providerId = '00000000-0000-4000-8000-000000000001';
const baseUrl = 'https://relay.example.invalid/v1';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-provider-models-'));
  const database = path.join(root, 'agent.db');
  const store = await LocalStore.open(database);
  const settings = new SettingsService(store, root, () => undefined);
  return { root, database, store, settings, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('模型发现接受未保存的 URL 和 Key，并保持 HTTPS、ID 与凭据格式边界', () => {
  assert.deepEqual(providerModelsSchema.parse({ baseUrl, apiKey: ' draft-key ' }), { baseUrl, apiKey: 'draft-key' });
  assert.equal(providerModelsSchema.parse(providerId), providerId);
  for (const value of [
    { baseUrl: 'http://relay.example.invalid', apiKey: 'draft-key' },
    { baseUrl: 'https://user:pass@relay.example.invalid', apiKey: 'draft-key' },
    { baseUrl: `${baseUrl}?token=abc`, apiKey: 'draft-key' },
    { baseUrl: `${baseUrl}#secret`, apiKey: 'draft-key' },
    { baseUrl, apiKey: ' ' }, { baseUrl, apiKey: 'key\r\nheader' },
    { baseUrl, apiKey: 'key\0value' }, { baseUrl, apiKey: 'a'.repeat(8193) },
    { baseUrl, apiKey: 'draft-key', id: '../config' },
    { baseUrl, apiKey: 'draft-key', models: ['unrequested'] },
  ]) assert.equal(providerModelsSchema.safeParse(value).success, false);
});

test('未保存中转站可直接鉴权获取模型，名称和模型 ID 不是前置条件，配置与密钥均不落盘', async t => {
  const state = await fixture();
  try {
    const before = await readFile(state.database);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(init?.redirect, 'error');
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') });
      return Response.json({ data: [{ id: 'model-1', name: '模型一' }, { id: 'model-2', owned_by: '提供方' }, { id: 'model-1', name: '模型一（更新）' }, { id: 'invalid model' }] });
    });
    const models = await state.settings.fetchProviderModels({ baseUrl: `${baseUrl}/`, apiKey: 'draft-key' });
    assert.deepEqual(models, [{ id: 'model-1', name: '模型一（更新）' }, { id: 'model-2', name: '提供方' }]);
    assert.deepEqual(requests, [{ url: `${baseUrl}/models`, authorization: 'Bearer draft-key' }]);
    assert.deepEqual(state.store.listProviders(), []);
    assert.deepEqual(await readFile(state.database), before);
    assert.equal((await readdir(state.root)).includes('config'), false);
  } finally { await state.close(); }
});

test('保留已保存 ID 调用与同地址凭据复用，更换地址必须提供新密钥且不会修改已保存配置', async t => {
  const state = await fixture();
  try {
    const saved = { id: providerId, name: '已保存中转站', baseUrl, models: ['saved-model'], hasKey: true };
    state.store.saveModelProvider(saved);
    const reads: Array<{ id: string; scope?: string }> = [];
    t.mock.method(state.settings, 'credential', (id: string) => ({ hasKey: id === providerId, read: (scope?: string) => { reads.push({ id, scope }); return id === providerId ? 'saved-key' : undefined; } }) as CredentialStore);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('Authorization') });
      return Response.json({ data: [{ id: 'discovered-model' }] });
    });
    await state.settings.fetchProviderModels(providerId);
    await state.settings.fetchProviderModels({ id: providerId, baseUrl: `${baseUrl}/` });
    await assert.rejects(() => state.settings.fetchProviderModels({ id: providerId, baseUrl: 'https://other.example.invalid/v1' }), /重新输入/);
    assert.equal(requests.length, 2);
    await state.settings.fetchProviderModels({ id: providerId, baseUrl: 'https://other.example.invalid/v1', apiKey: 'replacement-key' });
    assert.deepEqual(requests, [
      { url: `${baseUrl}/models`, authorization: 'Bearer saved-key' },
      { url: `${baseUrl}/models`, authorization: 'Bearer saved-key' },
      { url: 'https://other.example.invalid/v1/models', authorization: 'Bearer replacement-key' },
    ]);
    assert.equal(reads.filter(read => read.scope === baseUrl).length, 2);
    assert.deepEqual(state.store.listProviders(), [saved]);
    assert.equal((await readdir(state.root)).includes('config'), false);
  } finally { await state.close(); }
});

test('无凭据、非法地址和未知中转站不会发出模型请求', async t => {
  const state = await fixture();
  try {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl }), /API Key/);
    await assert.rejects(() => state.settings.fetchProviderModels({ id: providerId, baseUrl, apiKey: 'draft-key' }), /不存在/);
    await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl: 'http://relay.example.invalid', apiKey: 'draft-key' }));
    await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl, apiKey: 'key\r\nheader' }));
    await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl: `${baseUrl}/draft-key`, apiKey: 'draft-key' }), /地址不能包含/);
    assert.equal(request.mock.callCount(), 0);
  } finally { await state.close(); }
});

test('临时密钥不会从远端模型名称、模型 ID 或网络错误返回给界面', async t => {
  const state = await fixture();
  try {
    const key = 'synthetic-transient-key';
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ id: 'model-1', name: `远端回显 ${key}` }, { id: key }] }));
    const models = await state.settings.fetchProviderModels({ baseUrl, apiKey: key });
    assert.deepEqual(models, [{ id: 'model-1', name: '远端回显 [已脱敏]' }]);
    request.mock.mockImplementation(async () => { throw new Error(`network failure ${key}`); });
    await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl, apiKey: key }), error => error instanceof Error && error.message === 'network failure [已脱敏]' && !error.message.includes(key));
    assert.deepEqual(state.store.listProviders(), []);
  } finally { await state.close(); }
});

test('中转站密钥与协议、域名或模型标识局部重合时，获取和保存均不误判', async t => {
  const state = await fixture();
  try {
    const secrets = new Map<string, string>();
    t.mock.method(state.settings, 'credential', (id: string) => ({ get hasKey() { return secrets.has(id); }, read: () => secrets.get(id), save: (key: string) => { secrets.set(id, key); } }) as CredentialStore);
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Headers(init?.headers).get('Authorization')!);
      return Response.json({ data: [{ id: 'gpt-4.1-mini', name: '标准模型' }] });
    });
    for (const key of ['https', 'relay', 'mini', 'gpt']) {
      const models = await state.settings.fetchProviderModels({ baseUrl, apiKey: key });
      assert.equal(models[0]?.id, 'gpt-4.1-mini');
      const profile = state.settings.saveProfile({ ...(state.store.listProviders()[0] ? { id: state.store.listProviders()[0].id } : {}), name: '模型中转站', baseUrl, models: models.map(item => item.id), apiKey: key });
      assert.equal(profile.baseUrl, baseUrl);
      assert.equal((await state.settings.fetchProviderModels(profile.id))[0]?.id, 'gpt-4.1-mini');
      state.settings.saveProfile({ id: profile.id, name: '模型中转站', baseUrl, models: ['gpt-4.1-mini'] });
    }
    assert.deepEqual(requests, ['https', 'relay', 'mini', 'gpt'].flatMap(key => [`Bearer ${key}`, `Bearer ${key}`]));
  } finally { await state.close(); }
});

test('保存和获取共用密钥格式校验，误填网址明确提示且不发送或保存', async t => {
  const state = await fixture();
  try {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    const input = { name: '模型中转站', baseUrl, models: ['model-1'] };
    for (const key of [baseUrl, ` ${baseUrl} `]) {
      assert.throws(() => state.settings.saveProfile({ ...input, apiKey: key }), /API Key.*网址/);
      await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl, apiKey: key }), /API Key.*网址/);
    }
    for (const key of ['key\r\nheader', 'key\0value', ' ']) assert.equal(modelProfileSchema.safeParse({ ...input, apiKey: key }).success, false);
    assert.equal(modelProfileSchema.parse({ ...input, apiKey: ' synthetic-independent-key ' }).apiKey, 'synthetic-independent-key');
    assert.equal(request.mock.callCount(), 0);
    assert.deepEqual(state.store.listProviders(), []);
    assert.equal((await readdir(state.root)).includes('config'), false);
  } finally { await state.close(); }
});

test('独立完整密钥可用于正常地址，元数据或路径携带真实凭据仍拦截', async t => {
  const state = await fixture();
  try {
    const key = 'synthetic-complete-provider-key';
    const url = 'https://modelflare.dev/v1';
    const secrets = new Map<string, string>();
    t.mock.method(state.settings, 'credential', (id: string) => ({ get hasKey() { return secrets.has(id); }, read: () => secrets.get(id), save: (value: string) => { secrets.set(id, value); } }) as CredentialStore);
    const request = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), url + '/models');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${key}`);
      return Response.json({ data: [{ id: 'grok-4.7' }] });
    });
    const models = await state.settings.fetchProviderModels({ baseUrl: url, apiKey: key });
    const input = { name: 'model_grok', baseUrl: url, models: models.map(item => item.id), apiKey: key };
    const profile = state.settings.saveProfile(input);
    assert.equal((await state.settings.fetchProviderModels(profile.id))[0]?.id, 'grok-4.7');
    const before = state.store.listProviders();
    for (const changes of [{ name: `意外写入 ${key}` }, { models: [`model-${key}`] }, { baseUrl: `${url}/${key}` }, { baseUrl: `${url}/${key.split('').map(char => '%' + char.charCodeAt(0).toString(16)).join('')}` }]) {
      assert.throws(() => state.settings.saveProfile({ ...input, id: profile.id, ...changes }), /不能包含/);
    }
    for (const secret of [key, 'draft-key']) {
      await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl: `${url}/${secret}`, apiKey: secret }), /地址不能包含/);
      await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl: `${url}/${secret.split('').map(char => '%' + char.charCodeAt(0).toString(16)).join('')}`, apiKey: secret }), /地址不能包含/);
    }
    assert.throws(() => state.settings.saveProfile({ ...input, id: profile.id, name: key, apiKey: 'other-independent-key' }), /不能包含/);
    assert.deepEqual(state.store.listProviders(), before);
    assert.equal(request.mock.callCount(), 2);
    secrets.set(profile.id, 'https');
    assert.throws(() => state.settings.assertCleanText('https 正常正文'), /连接凭据/);
  } finally { await state.close(); }
});

test('局部重合例外不放宽其他连接密码，自由文本和无效编码路径不泄漏密钥', async t => {
  const state = await fixture();
  try {
    t.mock.method(state.settings, 'jiraCredential', () => ({ hasKey: true, read: () => 'jiraPass9' }) as CredentialStore);
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    const input = { name: '模型中转站', baseUrl, models: ['gpt-4.1-mini'], apiKey: 'short-key' };
    assert.throws(() => state.settings.saveProfile({ ...input, name: 'relay-jiraPass9-prod' }), /不能包含/);
    for (const name of ['API Key:short-key', '密钥：short-key', '误粘贴，short-key']) assert.throws(() => state.settings.saveProfile({ ...input, name }), /不能包含/);
    const encoded = input.apiKey.split('').map(char => '%' + char.charCodeAt(0).toString(16)).join('');
    await assert.rejects(() => state.settings.fetchProviderModels({ baseUrl: `${baseUrl}/${encoded}/%`, apiKey: input.apiKey }), /无效.*编码/);
    assert.throws(() => state.settings.saveProfile({ ...input, baseUrl: `${baseUrl}/${encoded}/%` }), /无效.*编码/);
    assert.equal(request.mock.callCount(), 0);
    assert.deepEqual(state.store.listProviders(), []);
  } finally { await state.close(); }
});

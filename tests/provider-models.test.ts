import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsService } from '../apps/desktop/src/main/settings';
import type { CredentialStore } from '../apps/desktop/src/main/credentials';
import { providerModelsSchema } from '../apps/desktop/src/main/security';
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

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsService } from '../apps/desktop/src/main/settings';
import type { CredentialStore } from '../apps/desktop/src/main/credentials';
import { LocalStore } from '../packages/storage/src';

const baseUrl = 'https://jira.example.invalid/context';
const account = 'synthetic-jira-user';
const syntheticPassword = 'synthetic-jira-password-only-for-test';

async function fixture(t: TestContext, secret: string | null = syntheticPassword, allowSave = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-jira-password-'));
  const filename = path.join(root, 'agent.db');
  const store = await LocalStore.open(filename);
  store.saveJira({ baseUrl, account, hasPassword: secret !== null, projectKey: 'FIXTURE', dateFieldId: '11116' });
  store.saveRuntimeKind('codex');
  const scopes: Array<string | undefined> = [];
  const writes: string[] = [];
  let savedSecret = secret;
  let savedScope: string | undefined;
  let failure: Error | undefined;
  const vault = {
    get hasKey() { return savedSecret !== null; },
    read(scope?: string) { scopes.push(scope); if (failure) throw failure; return savedSecret ?? undefined; },
    save(value: string, scope?: string) { if (!allowSave) { writes.push('save'); throw new Error('查看密码不应写入凭据'); } savedSecret = value; savedScope = scope; writes.push('save'); },
    delete() { writes.push('delete'); throw new Error('查看密码不应删除凭据'); },
  } as unknown as CredentialStore;
  const settings = new SettingsService(store, root, () => { throw new Error('只读查看不应请求修改设置'); });
  t.mock.method(settings, 'jiraCredential', () => vault);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { filename, store, settings, scopes, writes, fail: (error: Error) => { failure = error; }, saved: () => ({ secret: savedSecret, scope: savedScope }) };
}

test('常规设置快照仅返回 Jira 凭据状态，明确查看前不解密密码', async t => {
  const f = await fixture(t);
  const before = await readFile(f.filename);
  for (let index = 0; index < 3; index++) {
    const snapshot = f.settings.snapshot();
    assert.equal(snapshot.jira.hasPassword, true);
    assert.equal(Object.hasOwn(snapshot.jira, 'password'), false);
    assert.ok(!JSON.stringify(snapshot).includes(syntheticPassword));
  }
  assert.deepEqual(f.scopes, []);
  assert.deepEqual(f.writes, []);
  assert.equal((await readFile(f.filename)).equals(before), true);
});

test('明确查看仅使用已保存地址和账号组成的精确凭据 scope', async t => {
  const f = await fixture(t);
  assert.equal(f.settings.revealJiraPassword({ baseUrl: `${baseUrl}/`, account: ` ${account} ` }), syntheticPassword);
  assert.deepEqual(f.scopes, [`${baseUrl}\n${account}`]);
  assert.deepEqual(f.writes, []);
});

test('Jira 地址或账号与已保存配置不一致时拒绝且不读取凭据', async t => {
  const f = await fixture(t);
  const before = f.store.getJira();
  for (const input of [
    { baseUrl: 'https://other.example.invalid/context', account },
    { baseUrl: 'https://jira.example.invalid/other-context', account },
    { baseUrl: 'http://jira.example.invalid/context', account },
    { baseUrl, account: 'other-synthetic-user' },
    { baseUrl, account: account.toUpperCase() },
  ]) assert.throws(() => f.settings.revealJiraPassword(input), /地址或账号已修改/);
  assert.deepEqual(f.scopes, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.store.getJira(), before);
});

test('非法查看参数在访问 Jira vault 之前拒绝，不接纳附加密码或配置字段', async t => {
  const f = await fixture(t);
  for (const input of [
    undefined, null, [], {}, { baseUrl }, { account },
    { baseUrl: '', account }, { baseUrl, account: '' },
    { baseUrl: 'file:///C:/synthetic', account },
    { baseUrl: 'https://synthetic:password@jira.example.invalid', account },
    { baseUrl, account: 'user:password' },
    { baseUrl, account: 'user\nother' },
    { baseUrl, account: 'x'.repeat(321) },
    { baseUrl: `https://jira.example.invalid/${'x'.repeat(2000)}`, account },
    { baseUrl, account, password: syntheticPassword },
    { baseUrl, account, projectKey: 'OTHER' },
  ]) assert.throws(() => f.settings.revealJiraPassword(input));
  assert.deepEqual(f.scopes, []);
  assert.deepEqual(f.writes, []);
});

test('没有已保存 Jira 密码时明确失败，不生成或写入新凭据', async t => {
  const f = await fixture(t, null);
  const before = await readFile(f.filename);
  assert.throws(() => f.settings.revealJiraPassword({ baseUrl, account }), /尚未保存 Jira 密码/);
  assert.deepEqual(f.scopes, [`${baseUrl}\n${account}`]);
  assert.deepEqual(f.writes, []);
  assert.equal((await readFile(f.filename)).equals(before), true);
});

test('Jira vault 读取失败向调用方报告错误，查看不修改数据库或凭据', async t => {
  const f = await fixture(t);
  const before = await readFile(f.filename);
  f.fail(new Error('合成 Jira vault 不可用'));
  assert.throws(() => f.settings.revealJiraPassword({ baseUrl, account }), /合成 Jira vault 不可用/);
  assert.deepEqual(f.scopes, [`${baseUrl}\n${account}`]);
  assert.deepEqual(f.writes, []);
  assert.equal((await readFile(f.filename)).equals(before), true);
});

test('查看 Jira 密码不把明文写入 SQLite、配置元数据或后续设置快照', async t => {
  const f = await fixture(t);
  const before = await readFile(f.filename);
  const metadata = f.store.getJira();
  assert.equal(f.settings.revealJiraPassword({ baseUrl, account }), syntheticPassword);
  assert.equal(f.settings.revealJiraPassword({ baseUrl, account }), syntheticPassword);
  assert.deepEqual(f.store.getJira(), metadata);
  assert.equal(Object.hasOwn(f.store.getJira(), 'password'), false);
  assert.ok(!JSON.stringify(f.settings.snapshot()).includes(syntheticPassword));
  const after = await readFile(f.filename);
  assert.equal(after.equals(before), true);
  assert.equal(after.includes(Buffer.from(syntheticPassword)), false);
  assert.deepEqual(f.writes, []);
});

test('Jira 忙碌会话仍可保存账号和密码，账号变更缺少新密码时拒绝', async t => {
  const f = await fixture(t, syntheticPassword, true);
  const nextAccount = 'new-synthetic-jira-user';
  const nextPassword = 'new-synthetic-jira-password';
  const result = f.settings.saveJira({ baseUrl: `${baseUrl}/`, account: nextAccount, password: nextPassword, projectKey: 'FIXTURE', dateFieldId: '11116' });
  assert.deepEqual(result, { baseUrl, account: nextAccount, hasPassword: true, projectKey: 'FIXTURE', dateFieldId: '11116' });
  assert.deepEqual(f.saved(), { secret: nextPassword, scope: `${baseUrl}\n${nextAccount}` });
  assert.deepEqual(f.store.getJira(), result);
  assert.throws(() => f.settings.saveJira({ baseUrl, account: 'another-synthetic-user', projectKey: 'FIXTURE', dateFieldId: '11116' }), /更换 Jira 地址或账号时请重新输入密码/);
});

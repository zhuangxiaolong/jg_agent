import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { LocalStore } from '../packages/storage/src';
import type { Session } from '../packages/domain/src';

const session: Session = { id: 'defaults-session', title: '合成会话', workspacePath: 'C:/synthetic/session', createdAt: '2026-11-13T00:00:00Z', status: 'idle', runtimeKind: 'jinggong', providerId: 'provider-a', model: 'model-a', reasoningEffort: 'high' };

test('成功保存的模型偏好与会话同事务持久化，普通写入和 Runtime 默认互不覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-session-defaults-'));
  const filename = join(root, 'test.db');
  let store = await LocalStore.open(filename);
  try {
    store.saveRuntimeKind('codex');
    assert.equal(store.getSessionModelDefaults(), undefined);
    store.saveSession(session);
    assert.equal(store.getSessionModelDefaults(), undefined);
    store.saveSession(session, { rememberModelDefaults: true });
    assert.deepEqual(store.getSessionModelDefaults(), { providerId: 'provider-a', model: 'model-a', reasoningEffort: 'high' });
    store.saveSession({ ...session, status: 'completed', model: 'model-b', runtimeKind: 'claude_agent_sdk' });
    assert.deepEqual(store.getSessionModelDefaults(), { providerId: 'provider-a', model: 'model-a', reasoningEffort: 'high' });
    assert.equal(store.getRuntimeKind(), 'codex');
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getSessionModelDefaults(), { providerId: 'provider-a', model: 'model-a', reasoningEffort: 'high' });
    store.saveSession({ ...session, reasoningEffort: undefined }, { rememberModelDefaults: true });
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getSessionModelDefaults(), { providerId: 'provider-a', model: 'model-a' });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('校验或数据库写入失败不改会话及上次模型默认值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-session-default-failure-'));
  const filename = join(root, 'test.db');
  let store = await LocalStore.open(filename);
  try {
    store.saveSession(session, { rememberModelDefaults: true });
    const before = store.getSessionModelDefaults();
    assert.throws(() => store.saveSession({ ...session, model: 'invalid model' }, { rememberModelDefaults: true }), /默认模型配置无效/);
    assert.throws(() => store.saveSession({ ...session, projectId: 'not-registered', model: 'model-b', reasoningEffort: 'low' }, { rememberModelDefaults: true }), /FOREIGN KEY/);
    assert.deepEqual(store.getSession(session.id), session);
    assert.deepEqual(store.getSessionModelDefaults(), before);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getSessionModelDefaults(), before);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('旧库不推断未保存偏好，损坏的模型默认值保守忽略', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-session-default-legacy-'));
  const filename = join(root, 'test.db');
  let store = await LocalStore.open(filename);
  try {
    store.saveSession(session); store.close();
    const SQL = await initSqlJs();
    const database = new SQL.Database(await readFile(filename));
    database.run('INSERT INTO settings(key,value) VALUES (?,?)', ['session-model-defaults', JSON.stringify({ providerId: 'provider-a', model: 'model-a', reasoningEffort: 'invalid' })]);
    await writeFile(filename, database.export()); database.close();
    store = await LocalStore.open(filename);
    assert.equal(store.getSessionModelDefaults(), undefined);
    assert.deepEqual(store.getSession(session.id), session);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

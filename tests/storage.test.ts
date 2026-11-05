import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { LocalStore } from '../packages/storage/src/index';
import type { AgentEvent, Project, Session } from '../packages/domain/src/index';

test('SQLite 项目、会话、事件与模型元数据落盘，重启恢复中断状态并可备份', async () => {
  const root = await mkdtemp(join(tmpdir(), '精工 SQLite '));
  const path = join(root, '数据库', 'agent.db');
  const backup = join(root, '备份.db');
  const project: Project = { id: 'project-1', path: 'D:\\中文 项目', name: 'MES 测试', branch: 'main' };
  const session: Session = { id: 'session-1', projectId: project.id, title: '分析事务', workspacePath: 'D:\\workspace', branch: 'agent/session-1', status: 'running', createdAt: '2026-11-04T01:00:00.000Z', model: 'test-model', runtimeThreadId: 'thread-1' };
  const event: AgentEvent = { id: 'event-1', sessionId: session.id, type: 'delta', text: '真实 SQLite 持久化验证', createdAt: '2026-11-04T01:00:01.000Z' };
  let store: LocalStore | undefined;
  try {
    store = await LocalStore.open(path);
    assert.deepEqual(store.listProjects(), []);
    store.saveProject(project);
    store.saveSession(session);
    store.appendEvent(event);
    store.saveProvider({ baseUrl: 'https://model.example.invalid/v1', model: 'test-model', hasKey: true, apiKey: 'SYNTHETIC_CREDENTIAL_MUST_NOT_PERSIST' } as never);
    assert.throws(() => store!.appendEvent(event), /UNIQUE/);
    assert.equal(store.events(session.id).length, 1);
    store.close();
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
    assert.equal(bytes.includes(Buffer.from('SYNTHETIC_CREDENTIAL_MUST_NOT_PERSIST')), false);
    store = await LocalStore.open(path);
    assert.deepEqual(store.listProjects(), [project]);
    assert.equal(store.getSession(session.id)?.status, 'interrupted');
    assert.equal(store.getSession(session.id)?.runtimeThreadId, 'thread-1');
    assert.deepEqual(store.events(session.id)[0], event);
    assert.match(store.events(session.id)[1].text, /中断/);
    assert.equal(store.getProvider().model, 'test-model');
    assert.equal(store.getSession('missing'), undefined);
    store.backup(backup);
    assert.throws(() => store!.backup(path), /不能覆盖/);
    const restored = await LocalStore.open(backup);
    try { assert.equal(restored.events(session.id).length, 2); assert.equal(restored.listSessions().length, 1); } finally { restored.close(); }
    store.close();
    store = await LocalStore.open(path);
    assert.equal(store.events(session.id).length, 2, '再次启动不重复添加中断事件');
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

test('外键失败和磁盘写入失败不会造成内存、磁盘状态分叉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-storage-fail-'));
  const path = join(root, 'agent.db');
  const store = await LocalStore.open(path);
  try {
    assert.throws(() => store.saveSession({ id: 'bad', projectId: 'missing', title: '', workspacePath: '', branch: '', status: 'idle', createdAt: '', model: '' }), /FOREIGN KEY/);
    assert.equal(store.listSessions().length, 0);
    const project = { id: 'good', path: 'D:\\test', name: '测试', branch: 'main' };
    store.saveProject(project);
    await rm(path);
    await mkdir(path);
    assert.throws(() => store.saveProject({ ...project, name: '不应提交' }));
    assert.equal(store.listProjects()[0].name, '测试');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('损坏、无版本与更高版本数据库保留原文件并拒绝覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-storage-version-'));
  const path = join(root, 'agent.db');
  try {
    const corrupted = Buffer.from('not a sqlite database');
    await writeFile(path, corrupted);
    await assert.rejects(LocalStore.open(path), /损坏/);
    assert.deepEqual(await readFile(path), corrupted);
    const sql = await initSqlJs();
    const db = new sql.Database();
    db.run('CREATE TABLE other(value TEXT)');
    await writeFile(path, db.export());
    const unversioned = await readFile(path);
    await assert.rejects(LocalStore.open(path), /版本信息/);
    assert.deepEqual(await readFile(path), unversioned);
    db.run('PRAGMA user_version = 999');
    await writeFile(path, db.export());
    const newer = await readFile(path);
    await assert.rejects(LocalStore.open(path), /版本较新/);
    assert.deepEqual(await readFile(path), newer);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

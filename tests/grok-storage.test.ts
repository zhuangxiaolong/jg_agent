import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { LocalStore } from '../packages/storage/src';
import type { GrokProviderProfile } from '../packages/domain/src/grok';

const providerId = '00000000-0000-4000-8000-000000000001';
const profile: GrokProviderProfile = { id: providerId, name: '测试 Grok 中转站', baseUrl: 'https://relay.example.invalid', enabled: true, hasKey: true, models: [{ id: 'grok-test', name: 'Grok 测试模型', apiBackend: 'chat_completions', enabled: true }] };

test('Grok 关系表真实持久化协议/模型与默认关闭配置，不存凭据且删除不改历史会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-grok-storage-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  try {
    assert.deepEqual(store.getGrokRuntime(), { enabled: false, executablePath: '' });
    store.saveRuntimeKind('claude_agent_sdk');
    store.saveGrokRuntime({ enabled: true, executablePath: join(root, 'grok.exe'), proxyUrl: 'http://127.0.0.1:7897' });
    store.saveGrokProvider({ ...profile, apiKey: 'SYNTHETIC_GROK_SECRET_MUST_NOT_PERSIST' } as GrokProviderProfile);
    store.saveSession({ id: 'grok-session', title: 'Grok 会话', status: 'idle', runtimeKind: 'grok_build_acp', providerId, model: 'grok-test', grokBinding: 'a'.repeat(64), workspacePath: join(root, 'workspace'), createdAt: '2026-11-12T00:00:00Z' });
    store.close(); store = await LocalStore.open(filename);
    const saved = store.listGrokProviders()[0];
    assert.equal(saved.baseUrl, 'https://relay.example.invalid/v1');
    assert.equal(saved.hasKey, false);
    assert.equal(saved.models[0].apiBackend, 'chat_completions');
    assert.equal(store.getRuntimeKind(), 'claude_agent_sdk');
    assert.equal(store.getSession('grok-session')?.grokBinding, 'a'.repeat(64));
    assert.equal((await readFile(filename)).includes(Buffer.from('SYNTHETIC_GROK_SECRET_MUST_NOT_PERSIST')), false);
    store.deleteGrokProvider(providerId);
    assert.deepEqual(store.listGrokProviders(), []);
    assert.equal(store.getSession('grok-session')?.providerId, providerId);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.listGrokProviders(), []);
    assert.equal(store.getGrokRuntime().proxyUrl, 'http://127.0.0.1:7897');
    const sql = await initSqlJs(); const db = new sql.Database(await readFile(filename));
    try { assert.equal(db.exec('SELECT count(*) FROM grok_model_profiles')[0].values[0][0], 0); assert.equal(db.exec('PRAGMA user_version')[0].values[0][0], 11); } finally { db.close(); }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('v10 增量升级 v11 保留项目/会话/默认 Runtime 与旧 Provider，并生成迁移前备份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-grok-migration-'));
  const filename = join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    store.saveRuntimeKind('jinggong');
    store.saveProject({ id: 'project', name: '旧项目', branch: 'main', path: join(root, 'source') });
    store.saveSession({ id: 'old', projectId: 'project', title: '旧会话', status: 'completed', runtimeKind: 'codex', model: 'old-model', workspacePath: join(root, 'worktree'), createdAt: '2026-11-11T00:00:00Z' });
    store.saveModelProvider({ id: 'legacy-default', name: '原模型服务', baseUrl: 'https://old.example.invalid/v1', models: ['old-model'], hasKey: false });
    store.close();
    const sql = await initSqlJs(); const old = new sql.Database(await readFile(filename));
    old.run('DROP TABLE grok_model_profiles; DROP TABLE grok_provider_profiles; PRAGMA user_version = 10');
    const before = old.export(); old.close(); await writeFile(filename, before);
    store = await LocalStore.open(filename);
    assert.equal(store.getRuntimeKind(), 'jinggong'); assert.equal(store.listProjects()[0].name, '旧项目'); assert.equal(store.getSession('old')?.model, 'old-model'); assert.equal(store.listProviders()[0].name, '原模型服务');
    assert.deepEqual(store.listGrokProviders(), []);
    const backups = (await readdir(root)).filter(name => name.includes('.pre-v11-from-v10-'));
    assert.equal(backups.length, 1); assert.deepEqual(await readFile(join(root, backups[0])), Buffer.from(before));
    store.close(); store = await LocalStore.open(filename); assert.equal((await readdir(root)).filter(name => name.includes('.pre-v11-from-v10-')).length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Grok 存储拒绝未脱敏元数据、重复模型、非法地址/绑定并限制容量', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-grok-invalid-')); const store = await LocalStore.open(join(root, 'agent.db'));
  try {
    for (const baseUrl of ['http://relay.invalid', 'https://user:pass@relay.invalid', 'https://relay.invalid?key=abc', 'https://relay.invalid#secret']) assert.throws(() => store.saveGrokProvider({ ...profile, baseUrl }));
    assert.throws(() => store.saveGrokProvider({ ...profile, name: 'sk-SYNTHETIC_123456789' }), /凭据/);
    assert.throws(() => store.saveGrokProvider({ ...profile, models: [profile.models[0], profile.models[0]] }), /重复/);
    assert.throws(() => store.saveGrokProvider({ ...profile, models: Array.from({ length: 101 }, (_, i) => ({ ...profile.models[0], id: `model-${i}` })) }), /配置无效/);
    assert.throws(() => store.saveGrokRuntime({ enabled: true, executablePath: 'grok.exe' }), /绝对路径/);
    assert.throws(() => store.saveGrokRuntime({ enabled: true, executablePath: '' }), /填写/);
    assert.throws(() => store.saveSession({ id: 'bad', title: '错误绑定', runtimeKind: 'grok_build_acp', status: 'idle', model: 'grok-test', grokBinding: 'bad', workspacePath: root, createdAt: '2026-11-12T00:00:00Z' }), /配置绑定无效/);
    assert.deepEqual(store.listGrokProviders(), []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Grok Provider 写盘失败回滚整组模型，不留下部分协议或配置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-grok-rollback-')); const filename = join(root, 'agent.db'); const store = await LocalStore.open(filename);
  try {
    store.saveGrokProvider(profile);
    const before = store.listGrokProviders();
    await rm(filename); await mkdir(filename);
    assert.throws(() => store.saveGrokProvider({ ...profile, models: [{ ...profile.models[0], apiBackend: 'responses' }] }));
    assert.deepEqual(store.listGrokProviders(), before);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('审批事件只持久化受控摘要，不写入工具命令、文件内容或标题原文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-grok-approval-')); const filename = join(root, 'agent.db'); const store = await LocalStore.open(filename);
  const sessionId = 'approval-session';
  const raw = JSON.stringify({ command: 'cat SUPER_PRIVATE_COMMAND', content: '用户文件原文 SECRET_FILE_CONTENT', path: 'D:/private/secret.txt' });
  try {
    store.saveSession({ id: sessionId, title: '审批会话', status: 'idle', runtimeKind: 'grok_build_acp', model: 'grok-test', workspacePath: root, createdAt: '2026-11-12T00:00:00Z' });
    store.appendEvent({ id: 'approval-event', sessionId, type: 'approval', text: '执行工具', createdAt: '2026-11-12T00:00:01Z', approval: { requestId: 'approval-request', title: '运行 cat SUPER_PRIVATE_COMMAND', toolName: 'run_terminal_command', input: raw, state: 'pending' } });
    const saved = store.events(sessionId)[0].approval;
    assert.equal(saved?.title, 'run_terminal_command');
    assert.deepEqual(JSON.parse(saved?.input ?? '{}'), { redacted: true, fields: ['command', 'content', 'path'], bytes: Buffer.byteLength(raw, 'utf8') });
    const database = (await readFile(filename)).toString('utf8');
    assert.equal(database.includes('SUPER_PRIVATE_COMMAND'), false);
    assert.equal(database.includes('SECRET_FILE_CONTENT'), false);
    assert.equal(database.includes('D:/private/secret.txt'), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

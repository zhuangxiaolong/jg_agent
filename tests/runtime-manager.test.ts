import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeManager } from '../packages/agent-runtime/src/manager';
import type { RuntimeAdapter } from '../packages/agent-runtime/src/manager';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src';

test('显式选择 Jinggong 且未就绪时明确失败，不回退到 Codex', async () => {
  const manager = new RuntimeManager();
  const health = await manager.checkRuntime('jinggong');
  assert.equal(health.kind, 'jinggong');
  assert.equal(health.compatible, false);
  assert.match(health.detail, /Jinggong Runtime 尚未就绪/);
  await assert.rejects(manager.get('jinggong').startSession('D:\\fixture'), /Jinggong Runtime 尚未就绪/);
});

test('RuntimeManager 按 kind 固定路由并保留 adapter 事件协议', async () => {
  const events: string[] = [];
  const adapter: RuntimeAdapter = {
    kind: 'codex', version: 'fixture', capabilitiesVersion: 1,
    onEvent(listener) { listener({ type: 'status', text: 'completed', threadId: 'thread' }); return () => undefined; },
    async checkRuntime() { return { kind: 'codex', available: true, compatible: true, version: 'fixture', detail: 'fixture' }; },
    async start() {}, async startSession() { return 'thread'; }, async resumeSession() { return 'thread'; },
    async sendTurn() {}, async cancelRun() {}, async close() {}
  };
  const manager = new RuntimeManager({ codex: adapter });
  const selected = manager.get('codex');
  selected.onEvent(event => events.push(event.text));
  assert.equal(selected, adapter);
  assert.equal((await manager.checkRuntime('codex')).version, 'fixture');
  assert.deepEqual(events, ['completed']);
  assert.equal(manager.get('jinggong').kind, 'jinggong');
});

test('Claude Runtime 必须显式配置，缺失时明确不可用且不回退', async () => {
  const manager = new RuntimeManager();
  const health = await manager.checkRuntime('claude_agent_sdk');
  assert.equal(health.kind, 'claude_agent_sdk');
  assert.equal(health.available, false);
  assert.match(health.detail, /Claude Agent SDK Runtime 尚未配置/);
  await assert.rejects(manager.get('claude_agent_sdk').startSession('D:\\fixture'), /Claude Agent SDK Runtime 尚未配置/);
});

test('RuntimeManager 可按 Claude kind 路由并返回对应健康状态', async () => {
  const adapter: RuntimeAdapter = {
    kind: 'claude_agent_sdk', version: 'claude-fixture', capabilitiesVersion: 1,
    onEvent() { return () => undefined; },
    async checkRuntime() { return { kind: 'claude_agent_sdk', available: true, compatible: true, version: 'claude-fixture', detail: 'ready' }; },
    async start() {}, async startSession() { return 'claude-thread'; }, async resumeSession() { return 'claude-thread'; },
    async sendTurn() {}, async cancelRun() {}, async close() {},
  };
  const manager = new RuntimeManager({ claude_agent_sdk: () => adapter });
  assert.equal(manager.get('claude_agent_sdk'), adapter);
  assert.deepEqual(await manager.checkRuntime('claude_agent_sdk'), { kind: 'claude_agent_sdk', available: true, compatible: true, version: 'claude-fixture', detail: 'ready' });
});

test('Runtime 默认迁移为 Codex，会话可按会话切换 Runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-runtime-setting-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  try {
    assert.equal(store.getRuntimeKind(), 'codex');
    assert.equal(store.saveRuntimeKind('claude_agent_sdk'), 'claude_agent_sdk');
    assert.equal(store.getRuntimeKind(), 'claude_agent_sdk');
    assert.equal(store.saveRuntimeKind('codex'), 'codex');
    const project = { id: 'project', path: 'D:\\project', name: '测试项目', branch: 'main' };
    store.saveProject(project);
    store.saveSession({ id: 'session', projectId: project.id, title: '测试', workspacePath: 'D:\\workspace', branch: 'agent/session', status: 'idle', createdAt: new Date().toISOString(), model: 'fixture', runtimeKind: 'codex' });
    assert.equal(store.getSession('session')?.runtimeKind, 'codex');
    store.saveSession({ ...store.getSession('session')!, runtimeKind: 'jinggong' });
    assert.equal(store.getSession('session')?.runtimeKind, 'jinggong');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

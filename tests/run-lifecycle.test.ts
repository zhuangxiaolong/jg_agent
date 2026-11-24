import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { assertAgentRunTransition, canTransitionAgentRun, type AgentRunRecord, type Project, type Session } from '../packages/domain/src';
import { LocalStore } from '../packages/storage/src';

test('主运行状态转移拒绝越级终态并保留恢复入口', () => {
  assert.equal(canTransitionAgentRun('queued', 'preparing'), true);
  assert.equal(canTransitionAgentRun('completed', 'running'), false);
  assert.throws(() => assertAgentRunTransition('completed', 'running'), /不能从/);
  assert.equal(canTransitionAgentRun('interrupted', 'preparing'), true);
});

test('主运行记录、追加事件和启动恢复可持久化且事件幂等', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-run-lifecycle-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const project: Project = { id: 'run-project', path: root, name: '运行项目', branch: 'main' };
  const session: Session = { id: 'run-session', projectId: project.id, title: '运行测试', workspacePath: root, branch: 'main', status: 'running', createdAt: '2026-11-23T00:00:00.000Z', model: 'test-model', runtimeKind: 'codex' };
  const run: AgentRunRecord = { id: 'run-1', sessionId: session.id, projectId: project.id, runtimeKind: 'codex', modelId: session.model, status: 'running', createdAt: session.createdAt, startedAt: session.createdAt, heartbeatAt: session.createdAt, workspacePath: root, branch: 'main', retryCount: 0, maxRetries: 2, updatedAt: session.createdAt };
  try {
    store.saveProject(project); store.saveSession(session); store.createAgentRun(run);
    const event = { id: 'run-event-1', runId: run.id, sessionId: session.id, type: 'heartbeat' as const, status: 'running' as const, createdAt: session.createdAt, summary: '心跳' };
    const firstSeq = store.appendAgentRunEvent(event); const secondSeq = store.appendAgentRunEvent(event);
    assert.equal(firstSeq, secondSeq); assert.equal(store.listAgentRunEvents(run.id).length, 1);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getAgentRun(run.id)?.status, 'interrupted');
    assert.match(store.getAgentRun(run.id)?.recoveryReason ?? '', /未自动重放/);
    assert.equal(store.listAgentRunEvents(run.id).some(item => item.type === 'interrupted'), true);
    const recovered = store.getAgentRun(run.id)!;
    const checkpoint = { id: 'run-checkpoint-1', runId: run.id, sessionId: session.id, schemaVersion: 1 as const, createdAt: session.createdAt, goal: '完成可靠性升级', plan: ['实现记录'], completed: [], pending: ['测试'], workspacePath: root, branch: 'main', validation: ['未执行'], knownRisks: ['需要人工复核'] };
    store.saveAgentRunCheckpoint(checkpoint); assert.equal(store.listAgentRunCheckpoints(run.id)[0]?.goal, checkpoint.goal);
    assert.throws(() => store.saveAgentRunCheckpoint({ ...checkpoint, id: 'run-checkpoint-foreign', sessionId: 'other-session' }), /运行检查点绑定/);
    assert.equal(recovered.status, 'interrupted');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

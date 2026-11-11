import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTask, assertTaskGraph, nextRunnableTasks, reconcileTaskStates, schedulableAgentTasks, terminalTaskStatus, transitionAgentTask } from '../packages/agent-orchestrator/src';
import type { AgentTask } from '../packages/domain/src';

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return createAgentTask({ id, sessionId: 'session', projectId: 'project', name: id, role: 'custom', description: `${id} task`, ...overrides });
}

test('任务图按依赖关系给出等待、阻塞和可运行任务', () => {
  const a = task('a');
  const b = task('b', { dependencyIds: ['a'] });
  const c = task('c', { dependencyIds: ['a'] });
  const waiting = reconcileTaskStates([a, b, c]);
  assert.deepEqual(waiting.map(item => item.status), ['PENDING', 'WAITING', 'WAITING']);
  assert.deepEqual(nextRunnableTasks(waiting).map(item => item.id), ['a']);
  const completedA = transitionAgentTask(a, { status: 'RUNNING', now: '2026-11-10T00:00:00.000Z' });
  const doneA = transitionAgentTask(completedA, { status: 'COMPLETED', now: '2026-11-10T00:01:00.000Z' });
  const ready = reconcileTaskStates([doneA, b, c]);
  assert.deepEqual(nextRunnableTasks(ready, 1).map(item => item.id), ['b']);
  const failedA = transitionAgentTask(completedA, { status: 'FAILED', error: '失败', now: '2026-11-10T00:01:00.000Z' });
  assert.equal(reconcileTaskStates([failedA, b, c])[1].status, 'BLOCKED');
});

test('任务图拒绝循环和跨会话依赖，并限制失败重试次数', () => {
  const a = task('a', { dependencyIds: ['b'] });
  const b = task('b', { dependencyIds: ['a'] });
  assert.throws(() => assertTaskGraph([a, b]), /循环/);
  const root = task('root');
  const other = task('other', { sessionId: 'other-session', dependencyIds: ['root'] });
  assert.throws(() => assertTaskGraph([root, other]), /同一会话/);
  const parent = task('parent');
  const foreignChild = task('child', { parentTaskId: 'parent', projectId: 'another-project' });
  assert.throws(() => assertTaskGraph([parent, foreignChild]), /父任务必须属于同一会话和项目/);
  const retryable = task('retryable', { maxAttempts: 1 });
  const running = transitionAgentTask(retryable, { status: 'RUNNING' });
  const failed = transitionAgentTask(running, { status: 'FAILED' });
  assert.throws(() => transitionAgentTask(failed, { status: 'PENDING' }), /最大重试/);
});

test('依赖状态转换必须依据完整任务图，链式失败会传递阻塞', () => {
  const a = task('a');
  const b = task('b', { dependencyIds: ['a'] });
  const c = task('c', { dependencyIds: ['b'] });
  assert.throws(() => transitionAgentTask(b, { status: 'PENDING' }), /必须提供完整任务图/);
  assert.throws(() => transitionAgentTask(b, { status: 'PENDING' }, [a, b, c]), /尚未全部完成/);
  const doneA = transitionAgentTask(transitionAgentTask(a, { status: 'RUNNING' }), { status: 'COMPLETED' });
  const readyB = reconcileTaskStates([doneA, b, c])[1];
  assert.throws(() => transitionAgentTask(readyB, { status: 'RUNNING' }), /必须提供完整任务图/);
  assert.equal(transitionAgentTask(readyB, { status: 'RUNNING' }, [doneA, readyB, c]).status, 'RUNNING');
  const failedA = transitionAgentTask(transitionAgentTask(a, { status: 'RUNNING' }), { status: 'FAILED' });
  const reconciled = reconcileTaskStates([failedA, b, c]);
  assert.deepEqual(reconciled.map(item => item.status), ['FAILED', 'BLOCKED', 'BLOCKED']);
});

test('写入型任务必须绑定项目，最多同时调度并发槽位', () => {
  assert.throws(() => task('write', { workspaceMode: 'worktree', projectId: undefined } as Partial<AgentTask>), /绑定项目/);
  const tasks = ['a', 'b', 'c', 'd'].map(id => task(id));
  const running = transitionAgentTask(tasks[0], { status: 'RUNNING' });
  assert.deepEqual(nextRunnableTasks([running, ...tasks.slice(1)], 3).map(item => item.id), ['b', 'c']);
});

test('Runtime 非预期中断标记失败，用户取消与超时保留平台请求的终态', () => {
  assert.equal(terminalTaskStatus('completed'), 'COMPLETED');
  assert.equal(terminalTaskStatus('completed', 'CANCELLED'), 'CANCELLED');
  assert.equal(terminalTaskStatus('completed', 'FAILED'), 'FAILED');
  assert.equal(terminalTaskStatus('interrupted'), 'FAILED');
  assert.equal(terminalTaskStatus('interrupted', 'CANCELLED'), 'CANCELLED');
  assert.equal(terminalTaskStatus('interrupted', 'FAILED'), 'FAILED');
  assert.equal(terminalTaskStatus('running'), undefined);
});

test('调度器跳过主任务占用或正在级联取消的会话', () => {
  const busy = task('busy', { sessionId: 'busy-session' });
  const cancelling = task('cancelling', { sessionId: 'cancelling-session' });
  const ready = task('ready', { sessionId: 'ready-session' });
  assert.deepEqual(schedulableAgentTasks([busy, cancelling, ready], new Set(['busy-session', 'cancelling-session'])), [ready]);
  assert.deepEqual(schedulableAgentTasks([busy, cancelling, ready], new Set()), [busy, cancelling, ready]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTasksForSession, mergeAgentTaskEvents, selectedAgentTask } from '../apps/desktop/src/renderer/agent-task-state';
import { createAgentTask } from '../packages/agent-orchestrator/src';
import type { AgentTaskEvent } from '../packages/domain/src';

const task = createAgentTask({ id: 'old-task', sessionId: 'old-session', name: '历史任务', role: 'testing', description: '任务只属于原会话' });
function event(id: string, overrides: Partial<AgentTaskEvent> = {}): AgentTaskEvent {
  return { id, sessionId: 'old-session', taskId: task.id, type: 'message', text: id, createdAt: '2026-11-11T00:00:00.000Z', ...overrides };
}

test('新会话和空会话不能沿用上一会话的任务 ID', () => {
  assert.deepEqual(agentTasksForSession([task], 'new-session'), []);
  assert.equal(selectedAgentTask([task], 'new-session', task.id), undefined);
  assert.equal(selectedAgentTask([], 'new-session', task.id), undefined);
  assert.equal(selectedAgentTask([task], task.sessionId, task.id), task);
});

test('历史日志请求期间收到的实时输出保留，其他会话与任务事件被隔离', () => {
  const old = event('old');
  const live = event('live', { createdAt: '2026-11-11T00:00:01.000Z' });
  const merged = mergeAgentTaskEvents([old], [old, live, event('foreign', { sessionId: 'new-session' }), event('another', { taskId: 'another-task' })], task.sessionId, task.id);
  assert.deepEqual(merged.map(row => row.id), ['old', 'live']);
});

test('日志缓冲仅保留最近 500 条，并按真实时间排序', () => {
  const rows = Array.from({ length: 520 }, (_, index) => event(`event-${index}`, { createdAt: new Date(Date.parse('2026-11-11T00:00:00.000Z') + index).toISOString() }));
  const merged = mergeAgentTaskEvents([...rows].reverse(), [], task.sessionId, task.id);
  assert.equal(merged.length, 500);
  assert.equal(merged[0].id, 'event-20');
  assert.equal(merged.at(-1)?.id, 'event-519');
});

import type { AgentTask, AgentTaskEvent } from '../../../../packages/domain/src';

/** 会话切换后旧任务不能作为新会话的事件查询目标。 */
export function agentTasksForSession(tasks: readonly AgentTask[], sessionId: string): AgentTask[] {
  return tasks.filter(task => task.sessionId === sessionId);
}

export function selectedAgentTask(tasks: readonly AgentTask[], sessionId: string, taskId: string): AgentTask | undefined {
  return tasks.find(task => task.sessionId === sessionId && task.id === taskId);
}

/** 拉取历史日志时保留请求期间到达的实时事件，并丢弃其它任务事件。 */
export function mergeAgentTaskEvents(history: readonly AgentTaskEvent[], live: readonly AgentTaskEvent[], sessionId: string, taskId: string): AgentTaskEvent[] {
  const rows = new Map<string, AgentTaskEvent>();
  for (const event of [...history, ...live]) if (event.sessionId === sessionId && event.taskId === taskId) rows.set(event.id, event);
  return [...rows.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-500);
}

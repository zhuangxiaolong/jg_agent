import { randomUUID } from 'node:crypto';
import type { Memory, Session } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';

/** 自动记忆只保存当前轮的任务和结果摘录，不把模型结论升级为已核实事实。 */
export function rememberCompletedSession(store: LocalStore, session: Session, assertClean: (text: string) => void): Memory | undefined {
  if (session.status !== 'completed') return;
  const events = store.events(session.id);
  let end = -1, start = -1;
  for (let index = events.length - 1; index >= 0; index--) if (events[index].type === 'status' && events[index].text === 'completed') { end = index; break; }
  for (let index = end - 1; index >= 0; index--) if (events[index].type === 'user') { start = index; break; }
  if (end < 0 || start < 0) return;
  const turn = events.slice(start + 1, end);
  const result = turn.filter(item => item.type === 'message').map(item => item.text).join('\n\n') || turn.filter(item => item.type === 'delta').map(item => item.text).join('');
  if (!result.trim()) return;
  const existing = store.listMemories().find(item => item.source === 'session' && item.sessionId === session.id);
  if (existing?.sourceEventId === events[end].id) return existing;
  const task = events[start].text;
  assertClean(task + '\n' + result);
  const excerpt = (value: string, size: number) => value.length > size ? value.slice(0, size) + '\n（仅保留摘录，完整内容见来源会话）' : value;
  const memory: Memory = {
    id: existing?.id ?? randomUUID(), title: `会话：${session.alias || session.title}`.slice(0, 120),
    content: `自动会话摘录，模型结果未经独立核实；继续开发前应检查当前代码和规范。\n\n任务：\n${excerpt(task, 1200)}\n\n结果：\n${excerpt(result.trim(), 3600)}`,
    createdAt: events[end].createdAt, source: 'session', sessionId: session.id, projectId: session.projectId, sourceEventId: events[end].id
  };
  store.saveMemory(memory); return memory;
}

export function sessionMemories(memories: Memory[], projectId?: string): Memory[] {
  const manual = memories.filter(item => item.source !== 'session');
  const automatic = memories.filter(item => item.source === 'session' && (projectId ? item.projectId === projectId : item.projectId === undefined)).slice(0, 4);
  return [...manual, ...automatic];
}

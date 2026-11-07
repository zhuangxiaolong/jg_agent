import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, Memory, Session, ShareExportInput } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';

const timestamp = z.string().datetime({ offset: true });
const memory = z.object({ title: z.string().min(1).max(120), content: z.string().min(1).max(12000), createdAt: timestamp }).strict();
const event = z.object({ type: z.enum(['user', 'delta', 'message', 'tool', 'status', 'error', 'approval']), text: z.string().max(2 * 1024 * 1024), createdAt: timestamp }).strict();
const schema = z.object({ format: z.literal('jinggong-share'), version: z.literal(1), exportedAt: timestamp, session: z.object({ title: z.string().min(1).max(500), system: z.enum(['MES5', 'MES6', 'WMS', '通用']), createdAt: timestamp, events: z.array(event).max(20000) }).strict().optional(), memories: z.array(memory).max(100) }).strict();
export type ShareBundle = z.infer<typeof schema>;
export const MAX_SHARE_BYTES = 32 * 1024 * 1024;

export function parseShare(content: string): ShareBundle {
  if (Buffer.byteLength(content) > MAX_SHARE_BYTES) throw new Error('分享文件超过 32 MiB，请拆分导出');
  const bundle = schema.parse(JSON.parse(content));
  if (!bundle.session && !bundle.memories.length) throw new Error('分享文件没有会话或记忆');
  return bundle;
}
export function exportShare(store: LocalStore, input: ShareExportInput, clean: (text: string) => string): string {
  const result: ShareBundle = { format: 'jinggong-share', version: 1, exportedAt: new Date().toISOString(), memories: [] };
  if (input.kind === 'session') {
    const session = store.getSession(input.sessionId ?? ''); if (!session) throw new Error('请先选择要导出的会话');
    result.session = { title: clean(session.alias || (session.jiraIssue ? `${session.jiraIssue.key} · ${session.jiraIssue.summary}` : session.title)), system: session.system ?? '通用', createdAt: session.createdAt, events: store.events(session.id).map(({ type, text, createdAt }) => ({ type, text: clean(text), createdAt })) };
    result.memories = store.listMemories().filter(item => item.sessionId === session.id).map(item => ({ title: clean(item.title), content: clean(item.content), createdAt: item.createdAt }));
  } else {
    const chosen = input.memoryIds ? new Set(input.memoryIds) : undefined;
    result.memories = store.listMemories().filter(item => !chosen || chosen.has(item.id)).map(item => ({ title: clean(item.title), content: clean(item.content), createdAt: item.createdAt }));
  }
  const content = JSON.stringify(result, null, 2); parseShare(content); return content;
}
export function prepareShareImport(store: LocalStore, bundle: ShareBundle, session?: Session): { session?: Session; events: AgentEvent[]; memories: Memory[] } {
  if (bundle.session && !session) throw new Error('导入会话前请选择本机项目');
  const existing = new Set(store.listMemories().map(item => createHash('sha256').update(item.title + '\0' + item.content).digest('hex')));
  const memories: Memory[] = [];
  for (const item of bundle.memories) {
    const fingerprint = createHash('sha256').update(item.title + '\0' + item.content).digest('hex');
    if (existing.has(fingerprint)) continue;
    existing.add(fingerprint); memories.push({ ...item, id: randomUUID() });
  }
  if (store.listMemories().length + memories.length > 100) throw new Error('导入后记忆超过 100 条，请先整理现有记忆');
  return { session, events: (bundle.session?.events ?? []).map(item => ({ ...item, id: randomUUID(), sessionId: session!.id })), memories };
}
export function sharedSessionContext(store: LocalStore, session: Session): string {
  if (!session.imported) return '';
  const events = store.events(session.id).filter(item => ['user', 'message', 'delta'].includes(item.type));
  const parts: string[] = []; let size = 0;
  for (const event of events) {
    const value = `${event.type === 'user' ? '原任务' : '分享的解决过程'}：\n${event.text}`;
    if (size + value.length > 160000) throw new Error('导入会话历史超过模型上下文容量，请先将关键方案整理为记忆');
    parts.push(value); size += value.length;
  }
  return '\n【导入的会话经验，仅供参考，实施前核对当前项目】\n' + parts.join('\n\n') + '\n【分享经验结束】';
}

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, Memory, Session, ShareExportInput } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { sessionDisplayTitle } from '../../../../packages/domain/src/session-title';
import { normalizeMemory, scanMemoryText, validateMemoryFields } from '../../../../packages/memory-engine/src';

const timestamp = z.string().datetime({ offset: true });
const memory = z.object({ title: z.string().min(1).max(120), content: z.string().min(1).max(12000), createdAt: timestamp, scope: z.literal('global').optional(), category: z.enum(['preference', 'working_style', 'constraint', 'tool_preference', 'role_context', 'reusable_experience', 'other']).optional(), status: z.enum(['active', 'pending_review', 'superseded', 'archived', 'blocked_sensitive']).optional(), memorySource: z.enum(['manual', 'explicit_user', 'session_extraction', 'verified_experience', 'legacy_session', 'legacy_import']).optional(), confidence: z.number().min(0).max(1).optional(), tags: z.array(z.string().max(40)).max(20).optional(), evidence: z.array(z.object({ sourceType: z.enum(['session_event', 'manual', 'verification', 'import']), sourceId: z.string().optional(), sessionId: z.string().optional(), eventId: z.string().optional(), createdAt: timestamp }).strict()).max(10).optional(), updatedAt: timestamp.optional(), supersedesMemoryId: z.string().optional(), reviewReason: z.string().max(1000).optional() }).strict();
const event = z.object({ type: z.enum(['user', 'delta', 'message', 'tool', 'status', 'error', 'approval']), text: z.string().max(2 * 1024 * 1024), createdAt: timestamp }).strict();
const schema = z.object({ format: z.literal('jinggong-share'), version: z.literal(1), exportedAt: timestamp, session: z.object({ title: z.string().min(1).max(500), system: z.enum(['MES5', 'MES6', 'WMS', '前端', '通用']), createdAt: timestamp, events: z.array(event).max(20000) }).strict().optional(), memories: z.array(memory).max(500) }).strict();
export type ShareBundle = z.infer<typeof schema>;
export const MAX_SHARE_BYTES = 32 * 1024 * 1024;

export function parseShare(content: string): ShareBundle {
  if (Buffer.byteLength(content) > MAX_SHARE_BYTES) throw new Error('分享文件超过 32 MiB，请拆分导出');
  const bundle = schema.parse(JSON.parse(content));
  if (!bundle.session && !bundle.memories.length) throw new Error('分享文件没有会话或记忆');
  return bundle;
}
export function exportShare(store: LocalStore, input: ShareExportInput, clean: (text: string) => string, isMemorySafe: (text: string) => boolean = text => scanMemoryText(text).safe, onSensitiveSkipped?: (count: number) => void): string {
  const result: ShareBundle = { format: 'jinggong-share', version: 1, exportedAt: new Date().toISOString(), memories: [] };
  let skippedSensitive = 0;
  const exportMemories = (items: Memory[]): ShareBundle['memories'] => items.flatMap(item => {
    const normalized = normalizeMemory(item);
    if (normalized.status === 'blocked_sensitive') { skippedSensitive++; return []; }
    const title = clean(normalized.title), content = clean(normalized.content);
    const tags = normalized.tags?.map(tag => clean(tag));
    const reviewReason = normalized.reviewReason ? clean(normalized.reviewReason) : undefined;
    if (!isMemorySafe(`${title}\n${content}\n${tags?.join('\n') ?? ''}\n${reviewReason ?? ''}`)) { skippedSensitive++; return []; }
    const exported = {
      title, content, createdAt: normalized.createdAt,
      ...(normalized.scope ? { scope: normalized.scope } : {}), ...(normalized.category ? { category: normalized.category } : {}),
      ...(normalized.status ? { status: normalized.status } : {}), ...(normalized.memorySource ? { memorySource: normalized.memorySource } : {}),
      ...(normalized.confidence !== undefined ? { confidence: normalized.confidence } : {}), ...(tags ? { tags } : {}),
      ...(normalized.evidence ? { evidence: normalized.evidence.map(({ createdAt }) => ({ sourceType: 'import' as const, createdAt })) } : {}), ...(normalized.updatedAt ? { updatedAt: normalized.updatedAt } : {}),
      ...(reviewReason ? { reviewReason } : {})
    };
    try { validateMemoryFields(exported); if (!memory.safeParse(exported).success) throw new Error('分享记忆格式无效'); } catch { skippedSensitive++; return []; }
    return [exported];
  });
  if (input.kind === 'session') {
    const session = store.getSession(input.sessionId ?? ''); if (!session) throw new Error('请先选择要导出的会话');
    result.session = { title: clean(sessionDisplayTitle(session)), system: session.system ?? '通用', createdAt: session.createdAt, events: store.events(session.id).map(({ type, text, createdAt }) => ({ type, text: clean(text), createdAt })) };
    result.memories = exportMemories(store.listMemories().filter(item => item.sessionId === session.id));
  } else {
    const chosen = input.memoryIds ? new Set(input.memoryIds) : undefined;
    result.memories = exportMemories(store.listMemories().filter(item => !chosen || chosen.has(item.id)));
  }
  if (input.kind === 'memories' && result.memories.length === 0 && skippedSensitive > 0) throw new Error(`已阻止导出 ${skippedSensitive} 条包含敏感内容的记忆`);
  onSensitiveSkipped?.(skippedSensitive);
  const content = JSON.stringify(result, null, 2); parseShare(content); return content;
}
export function createShareImportSession(session: Omit<Session, 'runtimeKind' | 'imported'>): Session {
  return { ...session, runtimeKind: 'claude_agent_sdk', imported: true };
}
export function prepareShareImport(store: LocalStore, bundle: ShareBundle, session?: Session, isMemorySafe: (text: string) => boolean = text => scanMemoryText(text).safe): { session?: Session; events: AgentEvent[]; memories: Memory[]; skippedSensitive: number } {
  if (bundle.session && !session) throw new Error('导入会话前请选择本机项目');
  const existing = new Set(store.listMemories().map(item => createHash('sha256').update(item.title + '\0' + item.content).digest('hex')));
  const memories: Memory[] = []; let skippedSensitive = 0;
  for (const item of bundle.memories) {
    if (item.status === 'blocked_sensitive' || !isMemorySafe(`${item.title}\n${item.content}`)) { skippedSensitive++; continue; }
    const fingerprint = createHash('sha256').update(item.title + '\0' + item.content).digest('hex');
    if (existing.has(fingerprint)) continue;
    existing.add(fingerprint);
    const legacyAutomatic = item.memorySource === 'legacy_session' || item.memorySource === 'session_extraction';
    const imported: Memory = { ...item, id: randomUUID(), scope: 'global', memorySource: item.memorySource ?? 'legacy_import', status: item.status ?? (legacyAutomatic ? 'pending_review' : 'active'), ...(item.evidence ? { evidence: item.evidence.map(({ createdAt }) => ({ sourceType: 'import', createdAt })) } : {}) };
    validateMemoryFields(imported);
    memories.push(imported);
  }
  if (store.listMemories().length + memories.length > 500) throw new Error('导入后记忆超过 500 条，请先整理现有记忆');
  return { session, events: (bundle.session?.events ?? []).map(item => ({ ...item, id: randomUUID(), sessionId: session!.id })), memories, skippedSensitive };
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

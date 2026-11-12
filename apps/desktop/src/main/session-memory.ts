import { randomUUID } from 'node:crypto';
import type { Memory, Session } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';

const MEMORY_HEADER = '自动筛选的长期记忆，来自用户明确表述；使用前核对当前项目和适用范围。';
const MAX_ENTRIES = 12;
type MemoryEntry = { kind: '偏好' | '约束' | '决策' | '经验'; text: string };

/** 只提取可复用的用户表述，不把普通任务、引用资料或模型结论写成事实。 */
export function usefulMemoryEntries(prompt: string): MemoryEntry[] {
  const text = prompt.split(/\r?\n?【本轮上传附件】/, 1)[0]
    .replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '');
  const entries: MemoryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:>|["“「])/.test(line)) continue;
    for (const part of line.split(/(?<=[。！？!?])\s*/)) {
      const value = part.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s*)+/, '').replace(/\*\*|__/g, '').trim();
      if (value.length < 6 || value.length > 360 || /[?？]$/.test(value)) continue;
      if (/(?:是否|能否|要不要|是不是|建议|或许|可能|如果|假如|例如|比如|示例|假设|待确认|待验证|未验证)/.test(value)) continue;
      if (/(?:本次|这次|今天|明天|昨天|刚才|稍后|暂时|当前轮|这一轮|这轮|本轮)/.test(value)) continue;
      if (/(?:不要|不用|无需|不必|别|禁止)(?:自动)?(?:记住|记忆|保存为记忆|记录为记忆)/.test(value)) continue;
      if (/^(?:请)?(?:帮我|帮我们|检查|查看|分析|查询|解释|说明|修改|修复|实现|新增|添加|删除|调整|优化|生成|整理|测试|验证|运行|执行|搜索|审阅|设计|展示|对比|总结|为什么|如何|怎么)/.test(value)
        && !/(?:以后|今后|后续|始终|每次|长期|团队约定|项目约定)/.test(value)) continue;
      const durable = /(?:以后|今后|后续|始终|一直|每次|一律|统一|默认|长期|固定|团队约定|项目约定|开发约定|发布约定)/.test(value);
      const preference = /(?:我|我们)(?:的|更|比较|通常|一般)?(?:喜欢|偏好|习惯|倾向)|(?:回复|回答|沟通|汇报|报告|注释|提交信息).*(?:中文|英文|简洁|详细|先.*结论)|(?:中文|英文|简洁|详细).*(?:回复|回答|沟通|汇报|报告|注释|提交信息)/.test(value);
      const decision = /(?:已(?:经)?(?:决定|确认|确定)|最终(?:决定|确认|确定)|确认(?:采用|使用|选择|保留|取消)|决定(?:采用|使用|选择|保留|取消))/.test(value);
      const lesson = /^(?:经验|教训|已验证的经验|确认的经验)[:：]/.test(value)
        && /(?:因为|导致|所以|避免|优先|应当|不要|不能|必须)/.test(value);
      const rule = /(?:必须|禁止|不得|不要|不能|需要|只能|先|优先|保持|保留|采用|使用|执行|回复|回答|输出|(?:统一|默认|以后|今后|后续|始终)(?:都)?(?:用|按|以|不|先))/.test(value);
      const explicit = /^(?:请)?(?:记住|记忆|长期记住)[:：，,\s]/.test(value);
      if (!lesson && !decision && !(preference && (durable || /(?:我|我们).*(?:喜欢|偏好|习惯|倾向)/.test(value))) && !(durable && rule) && !(explicit && rule)) continue;
      const content = value.replace(/^(?:请)?(?:记住|记忆|长期记住)[:：，,\s]+/, '').trim();
      if (/^(?:确认|已决定|决定)(?:采用|使用)?(?:这个|该|上述|前面)(?:方案|做法|方式)[。！!]*$/.test(content)) continue;
      entries.push({ kind: lesson ? '经验' : decision ? '决策' : preference ? '偏好' : '约束', text: content });
    }
  }
  return uniqueEntries(entries).slice(-MAX_ENTRIES);
}

function entryKey(value: string): string { return value.normalize('NFKC').replace(/\s+/g, ' ').replace(/[。！!]+$/, '').trim(); }
function uniqueEntries(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  return entries.filter(entry => { const key = entryKey(entry.text); if (seen.has(key)) return false; seen.add(key); return true; });
}
function savedEntries(memory: Memory): MemoryEntry[] {
  if (!memory.content.startsWith(MEMORY_HEADER + '\n')) return [];
  return memory.content.split('\n').flatMap(line => {
    const match = /^- (偏好|约束|决策|经验)：(.+)$/.exec(line);
    return match ? [{ kind: match[1] as MemoryEntry['kind'], text: match[2] }] : [];
  });
}

export function rememberCompletedSession(store: LocalStore, session: Session, assertClean: (text: string) => void): Memory | undefined {
  if (session.status !== 'completed') return;
  const events = store.events(session.id);
  let end = -1, previousEnd = -1;
  for (let index = events.length - 1; index >= 0; index--) if (events[index].type === 'status' && events[index].text === 'completed') { end = index; break; }
  if (end < 0) return;
  for (let index = end - 1; index >= 0; index--) if (events[index].type === 'status' && ['completed', 'failed', 'interrupted'].includes(events[index].text)) { previousEnd = index; break; }
  const queuedStarts = new Map<number | string, number>();
  for (let index = previousEnd + 1; index < end; index++) {
    const event = events[index];
    if (event.type === 'status' && event.requestId !== undefined && event.text === '开始执行排队补充任务。') queuedStarts.set(event.requestId, index);
  }
  const users = events.slice(0, end).flatMap((event, index) => {
    if (event.type !== 'user') return [];
    const effectiveStart = typeof event.requestId === 'string' && event.requestId.startsWith('queued-turn:') ? queuedStarts.get(event.requestId) ?? -1 : index;
    return effectiveStart > previousEnd ? [{ text: event.text, start: effectiveStart }] : [];
  });
  if (!users.length) return;
  const turn = events.slice(Math.min(...users.map(item => item.start)) + 1, end);
  const result = turn.filter(item => item.type === 'message').map(item => item.text).join('\n\n') || turn.filter(item => item.type === 'delta').map(item => item.text).join('');
  if (!result.trim()) return;
  const memories = store.listMemories();
  const existing = memories.find(item => item.source === 'session' && item.sessionId === session.id);
  if (existing?.sourceEventId === events[end].id) return existing;
  const task = users.map(item => item.text).join('\n');
  const previous = existing ? savedEntries(existing) : [];
  const known = new Set(memories.filter(item => item.id !== existing?.id && (item.source !== 'session' || item.projectId === session.projectId))
    .flatMap(item => item.source === 'session' ? savedEntries(item).map(entry => entryKey(entry.text)) : [entryKey(item.content)]));
  const selected = usefulMemoryEntries(task).filter(entry => !known.has(entryKey(entry.text)) && !previous.some(item => entryKey(item.text) === entryKey(entry.text)));
  if (!selected.length || (!existing && memories.length >= 100)) return;
  const entries = uniqueEntries([...previous, ...selected]).slice(-MAX_ENTRIES);
  const content = MEMORY_HEADER + '\n\n' + entries.map(entry => `- ${entry.kind}：${entry.text}`).join('\n');
  assertClean(content);
  const memory: Memory = {
    id: existing?.id ?? randomUUID(), title: `偏好与经验：${session.alias || session.title}`.slice(0, 120), content,
    createdAt: events[end].createdAt, source: 'session', sessionId: session.id, projectId: session.projectId, sourceEventId: events[end].id
  };
  store.saveMemory(memory); return memory;
}

export function sessionMemories(memories: Memory[], projectId?: string): Memory[] {
  const manual = memories.filter(item => item.source !== 'session');
  const automatic = memories.filter(item => item.source === 'session' && savedEntries(item).length && (projectId ? item.projectId === projectId : item.projectId === undefined)).slice(0, 4);
  return [...manual, ...automatic];
}

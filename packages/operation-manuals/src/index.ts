import { createHash } from 'node:crypto';

export type ManualSystem = 'MES5' | 'MES6' | 'WMS';
export type ManualStatus = 'draft' | 'review' | 'published' | 'archived';
export interface ManualSource { fileName: string; digest: string; locator: string; text: string }
export interface ManualBlock { id: string; heading?: string; text: string; order: number; source: ManualSource; needsConfirmation?: boolean }
export interface OperationManualRevision { id: string; manualId: string; version: number; title: string; system: ManualSystem; status: ManualStatus; blocks: ManualBlock[]; createdAt: string; createdBy: 'import' | 'agent' | 'user'; digest: string }
export interface OperationManual { id: string; system: ManualSystem; title: string; status: ManualStatus; activeRevisionId?: string; revisions: OperationManualRevision[]; createdAt: string; updatedAt: string }
export interface ManualSearchHit { manualId: string; revisionId: string; blockId: string; title: string; system: ManualSystem; text: string; locator: string; score: number; needsConfirmation?: boolean }

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalize(value: string): string { return value.trim().toLocaleLowerCase('zh-CN'); }

export function createManualRevision(input: Omit<OperationManualRevision, 'digest'>): OperationManualRevision {
  if (!input.title.trim() || !input.blocks.length) throw new Error('操作手册修订必须包含标题和内容块');
  const payload = JSON.stringify({ ...input, blocks: input.blocks.map(block => ({ ...block, text: block.text.trim() })) });
  return { ...input, digest: digest(payload) };
}

/** 关键词检索只在当前系统、已发布或草稿范围内运行，并返回来源锚点。 */
export function searchManuals(manuals: OperationManual[], system: ManualSystem, query: string, limit = 20): ManualSearchHit[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: ManualSearchHit[] = [];
  for (const manual of manuals) {
    if (manual.system !== system || manual.status === 'archived') continue;
    const revision = manual.revisions.find(item => item.id === manual.activeRevisionId) ?? manual.revisions.at(-1);
    if (!revision || revision.status === 'archived') continue;
    for (const block of revision.blocks) {
      const haystack = normalize(`${revision.title} ${block.heading ?? ''} ${block.text}`);
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      if (score) hits.push({ manualId: manual.id, revisionId: revision.id, blockId: block.id, title: revision.title, system, text: block.text, locator: block.source.locator, score, needsConfirmation: block.needsConfirmation });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN')).slice(0, Math.max(1, Math.min(limit, 100)));
}

export function exportManualMarkdown(revision: OperationManualRevision): string {
  const lines = [`# ${revision.title}`, '', `> 系统：${revision.system}；版本：${revision.version}；状态：${revision.status}`, ''];
  for (const block of [...revision.blocks].sort((a, b) => a.order - b.order)) {
    if (block.heading) lines.push(`## ${block.heading}`, '');
    lines.push(block.text, '', `来源：${block.source.fileName} · ${block.source.locator}${block.needsConfirmation ? ' · 待确认' : ''}`, '');
  }
  return lines.join('\n');
}

import { createHash } from 'node:crypto';
import type { ManagedDocument, Memory, MemorySettings } from '../../../../packages/domain/src';
import { normalizeMemory, scanMemoryText } from '../../../../packages/memory-engine/src';
import type { ContextCandidate } from '../../../../packages/performance/src';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function memoryContextCandidates(input: { selected: Memory[]; all: Memory[]; projectId?: string; settings: MemorySettings; knownSecrets?: string[] }): ContextCandidate[] {
  const secrets = input.knownSecrets ?? [];
  const selectedIds = new Set(input.selected.map(memory => memory.id));
  const records = [...input.selected.map(memory => ({ memory, scope: memory.projectId ? 'project' as const : 'global' as const })), ...(input.settings.projectInjectionEnabled && input.projectId ? input.all.filter(memory => memory.projectId === input.projectId && !selectedIds.has(memory.id)).map(memory => ({ memory, scope: 'project' as const })) : [])];
  return records.flatMap(({ memory, scope }) => {
    const normalized = normalizeMemory(memory, secrets);
    if (normalized.status !== 'active' || !scanMemoryText(`${normalized.title}\n${normalized.content}`, secrets).safe) return [];
    const value = `${normalized.title}\n${normalized.content}`;
    const digest = hash(value);
    return [{ id: `memory:${normalized.id}`, sourceType: 'memory', sourceId: normalized.id, scope, ...(scope === 'project' ? { projectId: normalized.projectId } : {}), contentHash: digest, updatedAt: normalized.updatedAt ?? normalized.createdAt, trust: 'user_memory', status: 'active', title: normalized.title, text: value, reasons: [`${normalized.category ?? 'other'} 类记忆`, normalized.memorySource === 'verified_experience' ? '经验证经验' : '用户记忆'] }];
  });
}

export function dictionaryContextCandidates(documents: ManagedDocument[], query: string): ContextCandidate[] {
  const terms = [...new Set(query.normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9_./$-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [])].slice(0, 20);
  if (!terms.length) return [];
  return documents.filter(document => document.enabled && document.kind === 'dictionary').flatMap(document => {
    const content = document.content;
    const normalized = content.toLocaleLowerCase();
    const snippets: string[] = [];
    for (const term of terms) {
      const index = normalized.indexOf(term);
      if (index < 0) continue;
      const start = Math.max(0, index - 180), end = Math.min(content.length, index + term.length + 260);
      snippets.push(content.slice(start, end).replace(/\s+/g, ' ').trim());
      if (snippets.length >= 5) break;
    }
    const text = [...new Set(snippets)].join('\n…\n').slice(0, 1600);
    if (!text) return [];
    return [{ id: `dictionary:${document.id}`, sourceType: 'dictionary', sourceId: document.id, scope: 'global', contentHash: document.digest || hash(content), updatedAt: document.createdAt, trust: 'untrusted_project_data', status: 'active', systemType: document.system === '通用' ? '通用' : document.system, title: `${document.system} · ${document.name}`, text, reasons: ['按当前任务关键词检索字典片段'] }];
  });
}

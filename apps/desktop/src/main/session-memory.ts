import { randomUUID } from 'node:crypto';
import type { Memory, MemorySettings, Session } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { extractMemoryCandidates, memoriesConflict, normalizeMemory, normalizeMemorySettings, retrieveMemories, scanMemoryText, validateMemoryFields } from '../../../../packages/memory-engine/src';

export interface MemoryCaptureOptions { enabled?: boolean; knownSecrets?: string[] }

let latestDiagnostics: ReturnType<typeof retrieveMemories>['diagnostics'] | undefined;

export function getLatestMemoryDiagnostics() { return latestDiagnostics; }

export function rememberCompletedSession(store: LocalStore, session: Session, options: MemoryCaptureOptions = {}): Memory[] {
  if (session.status !== 'completed' || options.enabled === false) return [];
  const events = store.events(session.id);
  let end = -1, previousEnd = -1;
  for (let index = events.length - 1; index >= 0; index--) if (events[index].type === 'status' && events[index].text === 'completed') { end = index; break; }
  if (end < 0) return [];
  for (let index = end - 1; index >= 0; index--) if (events[index].type === 'status' && ['completed', 'failed', 'interrupted'].includes(events[index].text)) { previousEnd = index; break; }
  const queuedStarts = new Map<number | string, number>();
  for (let index = previousEnd + 1; index < end; index++) {
    const event = events[index];
    if (event.type === 'status' && event.requestId !== undefined && event.text === '开始执行排队补充任务。') queuedStarts.set(event.requestId, index);
  }
  const users = events.slice(0, end).flatMap((event, index) => {
    if (event.type !== 'user') return [];
    const effectiveStart = typeof event.requestId === 'string' && event.requestId.startsWith('queued-turn:') ? queuedStarts.get(event.requestId) ?? -1 : index;
    return effectiveStart > previousEnd ? [{ text: event.text, eventId: event.id, createdAt: event.createdAt, start: effectiveStart }] : [];
  });
  if (!users.length) return [];
  const knownSecrets = options.knownSecrets ?? [];
  const candidates = extractMemoryCandidates(users.map(({ text, eventId, createdAt }) => ({ text, eventId, createdAt })), session.id, knownSecrets);
  if (!candidates.length) return [];
  const existing = store.listMemories();
  const saved: Memory[] = [];
  for (const candidate of candidates) {
    const same = existing.find(memory => {
      const normalized = normalizeMemory(memory, knownSecrets);
      return normalized.category === candidate.category && normalized.content.normalize('NFKC').replace(/\s+/g, ' ').replace(/[。！!]+$/, '').toLocaleLowerCase() === candidate.content.normalize('NFKC').replace(/\s+/g, ' ').replace(/[。！!]+$/, '').toLocaleLowerCase();
    });
    if (same) {
      const evidence = [...(same.evidence ?? []), ...candidate.evidence].filter((item, index, all) => all.findIndex(other => (other.eventId ?? other.sourceId ?? `${other.sourceType}:${other.createdAt}`) === (item.eventId ?? item.sourceId ?? `${item.sourceType}:${item.createdAt}`)) === index).slice(-10);
      const updated: Memory = { ...same, evidence, updatedAt: candidate.evidence.at(-1)?.createdAt };
      validateMemoryFields(updated);
      store.saveMemory(updated); saved.push(updated);
      continue;
    }
    if (existing.length + saved.length >= 500) break;
    const conflicted = memoriesConflict(candidate, existing);
    const created: Memory = {
      id: randomUUID(), title: candidate.title, content: candidate.content,
      createdAt: candidate.evidence[0]?.createdAt ?? new Date().toISOString(), updatedAt: candidate.evidence.at(-1)?.createdAt,
      scope: 'global', category: candidate.category, status: conflicted ? 'pending_review' : candidate.status,
      memorySource: candidate.confidence >= 0.98 ? 'explicit_user' : 'session_extraction',
      confidence: candidate.confidence, tags: candidate.tags, evidence: candidate.evidence,
      ...(conflicted ? { reviewReason: '可能与现有记忆冲突，需人工确认' } : {})
    };
    validateMemoryFields(created);
    if (!scanMemoryText(`${created.title}\n${created.content}`, knownSecrets).safe) continue;
    store.saveMemory(created); saved.push(created);
  }
  return saved;
}

export function sessionMemories(memories: Memory[], projectId?: string, task = '', settings?: MemorySettings, knownSecrets: string[] = []): Memory[] {
  const normalizedSettings = normalizeMemorySettings(settings);
  if (!normalizedSettings.globalInjectionEnabled) {
    latestDiagnostics = retrieveMemories({ memories: [], task, settings: normalizedSettings }).diagnostics;
    return [];
  }
  const result = retrieveMemories({ memories, task, settings: normalizedSettings, knownSecrets });
  latestDiagnostics = result.diagnostics;
  return result.memories;
}

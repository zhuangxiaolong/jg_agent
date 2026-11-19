import type { ContextCandidate, ContextSourceType, PerformanceSettings } from './types';

export interface ContextRetrievalRequest { sessionId: string; projectId?: string; workspaceId: string; systemType?: string; query: string }
export interface ContextRetrievalResult { candidates: ContextCandidate[]; excluded: Array<{ sourceType: ContextSourceType; sourceId: string; title: string; reason: string }> }

const sourcePriority: Record<ContextSourceType, number> = { skill_body: 100, project_fact: 90, project_decision: 85, memory: 70, skill_metadata: 65, dictionary: 60, project_resource: 55, workspace_code: 50, task_evidence: 40 };
const trustPriority = { platform_required: 100, user_confirmed: 60, managed_skill: 40, user_memory: 30, untrusted_project_data: 10 } as const;
const maximums: Record<ContextSourceType, number> = { skill_body: 3, skill_metadata: 3, memory: 20, project_fact: 10, project_decision: 10, dictionary: 4, project_resource: 4, workspace_code: 8, task_evidence: 4 };

function tokens(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const result = new Set(normalized.match(/[a-z0-9_./$-]{2,}|[\u3400-\u9fff]{2,}/g) ?? []);
  for (const match of normalized.matchAll(/[\u3400-\u9fff]{2,}/g)) for (let index = 0; index < match[0].length - 1; index++) result.add(match[0].slice(index, index + 2));
  return result;
}

function reasonFor(candidate: ContextCandidate, request: ContextRetrievalRequest, matches: number): string[] {
  const reasons = [...(candidate.reasons ?? [])];
  if (candidate.explicit) reasons.unshift('用户显式选择');
  else if (candidate.scope === 'global') reasons.push('全局来源可跨项目使用');
  else reasons.push(candidate.scope === 'project' ? '当前项目范围匹配' : candidate.scope === 'workspace' ? '当前工作区匹配' : '当前会话范围匹配');
  if (candidate.systemType && request.systemType && candidate.systemType === request.systemType) reasons.push(`系统类型匹配：${request.systemType}`);
  if (matches > 0) reasons.push(`命中 ${matches} 个任务关键词`);
  if (candidate.status === 'confirmed') reasons.push('来源状态已确认');
  return [...new Set(reasons)].slice(0, 6);
}

function score(candidate: ContextCandidate, request: ContextRetrievalRequest, matches: number): number {
  const scope = candidate.scope === 'global' ? 8 : 24;
  const system = candidate.systemType && request.systemType && candidate.systemType === request.systemType ? 18 : candidate.systemType ? -20 : 0;
  const freshness = candidate.updatedAt ? Math.max(0, 8 - Math.floor(Math.max(0, Date.now() - Date.parse(candidate.updatedAt)) / (30 * 86400000))) : 0;
  const explicit = candidate.explicit ? 100000 : 0;
  return explicit + (candidate.relevanceScore ?? 0) + scope + system + trustPriority[candidate.trust] / 5 + sourcePriority[candidate.sourceType] / 10 + matches * 16 + freshness;
}

function maxCount(candidate: ContextCandidate, settings: PerformanceSettings): number {
  if (candidate.sourceType === 'memory') return settings.maxMemoryItems;
  if (candidate.sourceType === 'skill_metadata' || candidate.sourceType === 'skill_body') return settings.maxSkillContexts;
  if (candidate.sourceType === 'project_fact' || candidate.sourceType === 'project_decision') return settings.maxProjectAssertions;
  return maximums[candidate.sourceType];
}

export class ContextRetrievalPlanner {
  plan(request: ContextRetrievalRequest, candidates: ContextCandidate[], settings: PerformanceSettings): ContextRetrievalResult {
    const queryTokens = tokens(request.query);
    const rejected: ContextRetrievalResult['excluded'] = [];
    const ranked: Array<{ candidate: ContextCandidate; score: number; reasons: string[] }> = [];
    for (const candidate of candidates) {
      const reject = (reason: string) => rejected.push({ sourceType: candidate.sourceType, sourceId: candidate.sourceId, title: candidate.title.slice(0, 120), reason });
      if (!settings.contextSources[candidate.sourceType]) { reject('此类上下文来源已关闭'); continue; }
      if (!['active', 'confirmed'].includes(candidate.status)) { reject(`来源状态不可用：${candidate.status}`); continue; }
      if (candidate.scope === 'project' && (!request.projectId || candidate.projectId !== request.projectId)) { reject('项目范围不匹配'); continue; }
      if (candidate.scope === 'workspace' && candidate.workspaceId !== request.workspaceId) { reject('工作区范围不匹配'); continue; }
      if (candidate.scope === 'session' && candidate.sessionId !== request.sessionId) { reject('会话范围不匹配'); continue; }
      if (candidate.projectId && candidate.projectId !== request.projectId && candidate.scope !== 'global') { reject('禁止跨项目注入'); continue; }
      if (candidate.systemType && request.systemType && !['GENERAL', '通用', request.systemType].includes(candidate.systemType)) { reject(`系统类型不匹配：${candidate.systemType}`); continue; }
      const contentTokens = tokens(`${candidate.title} ${candidate.text}`);
      const matches = [...queryTokens].filter(token => contentTokens.has(token)).length;
      if (queryTokens.size > 0 && matches === 0 && (candidate.relevanceScore ?? 0) <= 0 && !candidate.explicit) { reject('与当前任务无关键词匹配'); continue; }
      const reasons = reasonFor(candidate, request, matches);
      ranked.push({ candidate, score: score(candidate, request, matches), reasons });
    }
    ranked.sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
    const selected: ContextCandidate[] = [];
    const counts = new Map<ContextSourceType, number>();
    const seen = new Set<string>();
    let projectAssertionCount = 0;
    for (const item of ranked) {
      const candidate = item.candidate;
      const count = counts.get(candidate.sourceType) ?? 0;
      if ((candidate.sourceType === 'project_fact' || candidate.sourceType === 'project_decision') && projectAssertionCount >= settings.maxProjectAssertions) { rejected.push({ sourceType: candidate.sourceType, sourceId: candidate.sourceId, title: candidate.title.slice(0, 120), reason: '项目事实与决策达到共同条数上限' }); continue; }
      if (count >= maxCount(candidate, settings)) { rejected.push({ sourceType: candidate.sourceType, sourceId: candidate.sourceId, title: candidate.title.slice(0, 120), reason: '达到该来源最大条数' }); continue; }
      const identity = `${candidate.scope}:${candidate.projectId ?? ''}:${candidate.sourceType}:${candidate.sourceId}:${candidate.contentHash}`;
      if (seen.has(identity)) { rejected.push({ sourceType: candidate.sourceType, sourceId: candidate.sourceId, title: candidate.title.slice(0, 120), reason: '同一来源与内容 Hash 已去重' }); continue; }
      seen.add(identity); counts.set(candidate.sourceType, count + 1); if (candidate.sourceType === 'project_fact' || candidate.sourceType === 'project_decision') projectAssertionCount++; selected.push({ ...candidate, relevanceScore: item.score, reasons: item.reasons });
    }
    return { candidates: selected, excluded: rejected.slice(0, 120) };
  }
}

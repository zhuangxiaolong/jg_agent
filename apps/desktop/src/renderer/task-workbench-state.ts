import type { RequirementTaskType, Session, SessionStatus } from '../../../../packages/domain/src';
import type { KnowledgeSource } from '../../../../packages/domain/src/knowledge';
import type { ExpertProfile, ExpertUsage } from '../../../../packages/domain/src/expert';

export type WorkbenchStatusFilter = SessionStatus | 'all';
export type WorkbenchTaskTypeFilter = RequirementTaskType | 'all';
export type WorkbenchTimeFilter = 'all' | '7d' | '30d' | '90d';

export interface WorkbenchFilters {
  projectId: string;
  status: WorkbenchStatusFilter;
  taskType: WorkbenchTaskTypeFilter;
  time: WorkbenchTimeFilter;
}

export function filterWorkbenchSessions(
  sessions: readonly Session[],
  statuses: Readonly<Record<string, SessionStatus>>,
  filters: WorkbenchFilters,
  now = Date.now(),
): Session[] {
  const days = filters.time === 'all' ? undefined : Number.parseInt(filters.time, 10);
  const cutoff = days === undefined ? undefined : now - days * 24 * 60 * 60 * 1000;
  return sessions
    .filter(session => filters.projectId === 'all' || session.projectId === filters.projectId)
    .filter(session => filters.status === 'all' || (statuses[session.id] ?? session.status) === filters.status)
    .filter(session => filters.taskType === 'all' || (session.requirementAdmission?.taskType ?? 'unknown') === filters.taskType)
    .filter(session => {
      if (cutoff === undefined) return true;
      const createdAt = Date.parse(session.createdAt);
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function summarizeWorkbenchSessions(sessions: readonly Session[], statuses: Readonly<Record<string, SessionStatus>>, now = Date.now()) {
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  let active = 0;
  let needsAttention = 0;
  let createdThisWeek = 0;
  for (const session of sessions) {
    const status = statuses[session.id] ?? session.status;
    if (status === 'running' || status === 'waiting-approval') active += 1;
    if (status === 'failed' || status === 'interrupted') needsAttention += 1;
    const createdAt = Date.parse(session.createdAt);
    if (Number.isFinite(createdAt) && createdAt >= sevenDaysAgo) createdThisWeek += 1;
  }
  return { total: sessions.length, active, needsAttention, createdThisWeek };
}

export function selectWorkbenchKnowledgeSources(sources: readonly KnowledgeSource[], projectId: string): KnowledgeSource[] {
  return sources
    .filter(source => !source.projectId || projectId === 'all' || source.projectId === projectId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 5);
}

export function selectWorkbenchExperts(profiles: readonly ExpertProfile[], usage: readonly ExpertUsage[]) {
  const enabledProfiles = new Map(profiles.filter(profile => profile.enabled).map(profile => [profile.id, profile]));
  const frequentlyUsed = usage
    .map(item => ({ profile: enabledProfiles.get(item.profileId), usageCount: item.usageCount, lastUsedAt: item.lastUsedAt }))
    .filter((item): item is { profile: ExpertProfile; usageCount: number; lastUsedAt: string } => !!item.profile)
    .slice(0, 4);
  if (frequentlyUsed.length) return frequentlyUsed;
  const defaultProfile = profiles.find(profile => profile.enabled && profile.isDefault);
  return defaultProfile ? [{ profile: defaultProfile, usageCount: 0, lastUsedAt: '' }] : [];
}

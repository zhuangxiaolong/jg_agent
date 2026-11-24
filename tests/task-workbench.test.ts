import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, SessionStatus } from '../packages/domain/src';
import type { KnowledgeSource } from '../packages/domain/src/knowledge';
import type { ExpertProfile, ExpertUsage } from '../packages/domain/src/expert';
import { filterWorkbenchSessions, selectWorkbenchExperts, selectWorkbenchKnowledgeSources, summarizeWorkbenchSessions } from '../apps/desktop/src/renderer/task-workbench-state';

function session(id: string, createdAt: string, patch: Partial<Session> = {}): Session {
  return { id, title: id, workspacePath: 'C:/repo', status: 'idle', createdAt, model: 'fixture-model', ...patch };
}

const now = Date.parse('2026-11-24T00:00:00.000Z');
const sessions = [
  session('bug', '2026-11-23T00:00:00.000Z', { projectId: 'p1', requirementAdmission: { taskType: 'bug' } as Session['requirementAdmission'] }),
  session('feature', '2026-11-12T00:00:00.000Z', { projectId: 'p2', requirementAdmission: { taskType: 'feature' } as Session['requirementAdmission'] }),
  session('unknown', '2026-09-01T00:00:00.000Z'),
];

test('工作台按项目、状态、需求类型和创建时间筛选会话', () => {
  const statuses: Record<string, SessionStatus> = { bug: 'running', feature: 'completed' };
  assert.deepEqual(filterWorkbenchSessions(sessions, statuses, { projectId: 'p1', status: 'running', taskType: 'bug', time: '7d' }, now).map(item => item.id), ['bug']);
  assert.deepEqual(filterWorkbenchSessions(sessions, statuses, { projectId: 'all', status: 'all', taskType: 'unknown', time: 'all' }, now).map(item => item.id), ['unknown']);
  assert.deepEqual(filterWorkbenchSessions(sessions, statuses, { projectId: 'all', status: 'completed', taskType: 'all', time: '30d' }, now).map(item => item.id), ['feature']);
});

test('工作台统计使用实时会话状态并只把新增计入本周', () => {
  const summary = summarizeWorkbenchSessions(sessions, { bug: 'running', feature: 'failed', unknown: 'interrupted' }, now);
  assert.deepEqual(summary, { total: 3, active: 1, needsAttention: 2, createdThisWeek: 1 });
});

test('工作台知识更新按当前项目范围和更新时间展示', () => {
  const sources: KnowledgeSource[] = [
    { id: 'shared', kind: 'managed_document', name: '共享规范', status: 'active', trust: 'user_confirmed', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' },
    { id: 'p1-old', kind: 'project_memory', name: '项目旧记录', projectId: 'p1', status: 'active', trust: 'user_confirmed', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' },
    { id: 'p1-new', kind: 'code_index', name: '项目新索引', projectId: 'p1', status: 'active', trust: 'untrusted_project_data', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-23T00:00:00Z' },
    { id: 'p2', kind: 'project_memory', name: '其他项目记录', projectId: 'p2', status: 'active', trust: 'user_confirmed', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-24T00:00:00Z' },
  ];
  assert.deepEqual(selectWorkbenchKnowledgeSources(sources, 'p1').map(item => item.id), ['p1-new', 'shared', 'p1-old']);
  assert.deepEqual(selectWorkbenchKnowledgeSources(sources, 'all').map(item => item.id), ['p2', 'p1-new', 'shared', 'p1-old']);
});

test('常用专家按真实调用次数排序并排除已停用档案', () => {
  const profile = (id: string, patch: Partial<ExpertProfile> = {}): ExpertProfile => ({
    id, name: id, familyId: 'engineering', builtin: true, version: 1, contentHash: 'hash', enabled: true, isDefault: false,
    workflowId: id, steps: [], sources: [], skillTags: [], output: '', checks: '', ...patch,
  });
  const profiles = [profile('popular'), profile('default', { isDefault: true }), profile('disabled', { enabled: false })];
  const usage: ExpertUsage[] = [
    { profileId: 'disabled', usageCount: 9, lastUsedAt: '2026-11-24T00:00:00Z' },
    { profileId: 'popular', usageCount: 4, lastUsedAt: '2026-11-23T00:00:00Z' },
  ];
  assert.deepEqual(selectWorkbenchExperts(profiles, usage).map(item => [item.profile.id, item.usageCount]), [['popular', 4]]);
  assert.deepEqual(selectWorkbenchExperts(profiles, []).map(item => [item.profile.id, item.usageCount]), [['default', 0]]);
});

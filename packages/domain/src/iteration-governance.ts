import { createHash, randomUUID } from 'node:crypto';

/** 第二迭代任务计划、影响分析、审查与交付记录模型。 */
export type TaskPlanStatus = 'draft' | 'review' | 'confirmed' | 'executing' | 'completed' | 'superseded';
export type TaskPlanStepStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'blocked' | 'invalidated';
export interface TaskPlan { id: string; taskId: string; revision: number; projectId?: string; goal: string; assumptions: string[]; acceptanceCriteria: string[]; status: TaskPlanStatus; createdAt: string; confirmedAt?: string }
export interface TaskPlanStep { id: string; planId: string; stepKey: string; title: string; description: string; order: number; dependsOn: string[]; status: TaskPlanStepStatus; required: boolean; startedAt?: string; completedAt?: string; outputSummary?: string; evidenceRefs: string[] }
export type RecoveryStatus = 'safe_to_resume' | 'resume_with_revalidation' | 'manual_reconciliation_required' | 'cannot_resume' | 'not_checked';
export interface TaskCheckpoint { id: string; taskId: string; planId: string; stepId: string; projectId?: string; repoId?: string; branch?: string; headSha?: string; worktreeFingerprint?: string; fileManifestJson: string; contextSnapshotId?: string; runtimeId?: string; runtimeSessionId?: string; checkpointSummary: string; completedActionsJson: string; pendingActionsJson: string; evidenceRefsJson: string; recoveryStatus: RecoveryStatus; createdAt: string }

export interface ImpactReport { id: string; taskId: string; projectId?: string; diffFingerprint?: string; findings: Array<{ path: string; status: string; reason: string; evidence: 'observed' | 'inferred' | 'suggested' }>; recommendedSuites: string[]; status: 'completed' | 'failed' | 'stale'; createdAt: string }
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ReviewConfidence = 'verified' | 'likely' | 'suggestion' | 'unknown';
export interface ReviewFinding { id: string; reviewRunId: string; fingerprint: string; severity: ReviewSeverity; confidence: ReviewConfidence; filePath?: string; startLine?: number; endLine?: number; title: string; description: string; evidenceRefs: string[]; status: 'open' | 'confirmed' | 'ignored' | 'false_positive' | 'fixed' | 'stale' }
export interface ReviewRun { id: string; taskId: string; projectId?: string; diffFingerprint: string; runtimeId?: string; modelId?: string; status: 'completed' | 'failed' | 'stale'; findings: ReviewFinding[]; createdAt: string }
export interface DeliveryPackageRecord { id: string; taskId: string; jiraKey?: string; projectId?: string; revision: number; sourceSnapshot: Record<string, unknown>; outputPath: string; outputSha256: string; status: 'building' | 'success' | 'failed'; createdAt: string }
export interface JiraWritebackRecord { id: string; jiraKey: string; operation: 'comment' | 'attachment' | 'status_transition'; preview: Record<string, unknown>; requestHash: string; resultStatus: 'pending_confirmation' | 'success' | 'failed' | 'cancelled'; responseId?: string; errorMessage?: string; createdAt: string }

export function nowIso(): string { return new Date().toISOString(); }
export function stableHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function newIterationId(prefix: string): string { return `${prefix}-${randomUUID()}`; }

export function assertTaskPlanSteps(steps: TaskPlanStep[]): void {
  const keys = new Set<string>(); const ids = new Set<string>();
  for (const step of steps) {
    if (!step.stepKey.trim() || keys.has(step.stepKey)) throw new Error('任务计划步骤标识必须唯一');
    if (ids.has(step.id)) throw new Error('任务计划步骤 ID 必须唯一');
    keys.add(step.stepKey); ids.add(step.id);
  }
  const graph = new Map(steps.map(step => [step.stepKey, step.dependsOn]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (key: string) => { if (visiting.has(key)) throw new Error('任务计划步骤存在依赖环'); if (visited.has(key)) return; visiting.add(key); for (const dependency of graph.get(key) ?? []) { if (!graph.has(dependency)) throw new Error(`任务计划依赖不存在：${dependency}`); visit(dependency); } visiting.delete(key); visited.add(key); };
  for (const key of graph.keys()) visit(key);
}

export function nextStepStatus(current: TaskPlanStepStatus, next: TaskPlanStepStatus): boolean {
  const allowed: Record<TaskPlanStepStatus, TaskPlanStepStatus[]> = { pending: ['ready', 'skipped', 'blocked', 'invalidated'], ready: ['running', 'blocked', 'skipped', 'invalidated'], running: ['succeeded', 'failed', 'blocked'], succeeded: ['invalidated'], failed: ['ready', 'invalidated'], skipped: ['ready', 'invalidated'], blocked: ['ready', 'invalidated'], invalidated: ['ready'] };
  return allowed[current].includes(next);
}

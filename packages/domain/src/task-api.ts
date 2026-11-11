import type { AgentTask } from './index';
import type { TaskBudgetPolicy, TaskContractRecord, TaskEvidenceRecord, TaskLifecycleEvent } from './engineering';

export interface TaskGovernanceSummary {
  capabilities: Record<string, { supported: boolean | 'partial'; enforcementLayer: string; notes: string }>;
  budget?: { policy: TaskBudgetPolicy; sources: Partial<Record<keyof TaskBudgetPolicy, readonly string[]>> };
  platformModelTurns: number;
  platformToolCalls: number;
  nativeModelRequests: 'unknown';
  nativeToolCalls: 'unknown';
  tokenUsage: 'unknown';
  costUsage: 'unknown';
  unresolvedToolCalls: number;
  recoveryNotes: string[];
}

export interface TaskEngineeringDetail {
  task: AgentTask;
  contracts: TaskContractRecord[];
  events: TaskLifecycleEvent[];
  evidence: TaskEvidenceRecord[];
  governance?: TaskGovernanceSummary;
  evidenceFreshness?: { status: 'not_checked' | 'current' | 'stale' | 'unavailable'; checkedAt?: string; reason?: string };
}

export interface TaskWorkspaceDetail {
  stateVersion?: number;
  workspace?: { path: string; branch: string; baseCommit: string; retained: boolean };
  stable?: boolean;
  changes?: Array<{ path: string; status: string; layer: string; diff: string; truncated: boolean; binary: boolean; contentHash: string }>;
  integration?: { ready: boolean; requiresApproval: true; autoIntegration: false; checkedAt: string; fingerprint: string; approvalReason: string; blockers: Array<{ code: string; message: string; paths?: string[] }>; source: { branch: string; head: string | null; dirty: boolean | null; fingerprint: string | null }; target: { branch: string; head: string | null; dirty: boolean | null; fingerprint: string | null }; limitations: string[] };
}

/** 结果和状态只能由主进程校验后生成，前端不能提交任意 PASSED 或证据 JSON。 */
export interface TaskEngineeringApi {
  detail(sessionId: string, taskId: string): Promise<TaskEngineeringDetail>;
  revise(input: { sessionId: string; taskId: string; expectedContractVersion: number; goal: string; outputExpectations: string[]; acceptanceCriteria: string[] }): Promise<TaskEngineeringDetail>;
  linkVerification(input: { sessionId: string; taskId: string; runId: string; expectedStateVersion: number }): Promise<TaskEngineeringDetail>;
  submitAcceptance(input: { sessionId: string; taskId: string; expectedStateVersion: number }): Promise<TaskEngineeringDetail>;
  resolveAcceptance(input: { sessionId: string; taskId: string; expectedStateVersion: number; decision: 'accept' | 'reject'; comment: string }): Promise<TaskEngineeringDetail>;
  resume(input: { sessionId: string; taskId: string; expectedStateVersion: number }): Promise<TaskEngineeringDetail>;
  workspace?(sessionId: string, taskId: string): Promise<TaskWorkspaceDetail>;
  createWorkspace?(input: { sessionId: string; taskId: string; expectedStateVersion: number }): Promise<TaskWorkspaceDetail>;
  prepareIntegration?(input: { sessionId: string; taskId: string; expectedStateVersion: number }): Promise<TaskWorkspaceDetail>;
}

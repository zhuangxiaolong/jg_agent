import type { RuntimeKind } from './index';

export type TaskExecutionStatus = 'PENDING' | 'READY' | 'RUNNING' | 'PAUSED' | 'BLOCKED' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export type TaskVerificationStatus = 'NOT_REQUIRED' | 'NOT_STARTED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'PARTIAL' | 'INCONCLUSIVE';
export type TaskAcceptanceStatus = 'NOT_SUBMITTED' | 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'NOT_REQUIRED';
export type TaskPermission = 'read_project' | 'write_workspace' | 'execute_command' | 'access_network' | 'install_dependency' | 'read_secrets' | 'database_read' | 'database_write' | 'git_commit' | 'git_push' | 'git_merge' | 'delete_files';
export type TaskWorkspacePolicy = 'shared_readonly' | 'isolated_worktree' | 'no_workspace';
export type TaskDependencyCondition = 'completed' | 'verified' | 'accepted';
export interface TaskBudgetPolicy {
  maxConcurrentAgents: number; maxAgentDepth: number; maxTotalAgentsPerTask: number;
  maxRuntimeMinutes: number; maxModelRequests: number; maxToolCalls: number; maxRetriesPerTask: number;
  maxInputTokens?: number; maxOutputTokens?: number; maxCostAmount?: number; currency?: string;
}
export interface TaskContract {
  taskId: string; sessionId: string; projectId?: string; runtimeKind: RuntimeKind; parentTaskId?: string;
  contractVersion: number; title: string; goal: string; description: string;
  taskType: 'analysis' | 'design' | 'implementation' | 'review' | 'test' | 'documentation' | 'integration' | 'other';
  inputRefs: Array<{ type: string; ref: string }>; outputExpectations: string[]; acceptanceCriteria: string[];
  allowedTools: string[]; permissions: TaskPermission[]; permissionProfile: string;
  allowedPaths: string[]; deniedPaths: string[];
  dependencies: Array<{ taskId: string; condition: TaskDependencyCondition }>;
  workspacePolicy: TaskWorkspacePolicy;
  modelPolicy: { kind: 'inherit' | 'specified'; model?: string; providerRef?: string };
  budgetPolicy: TaskBudgetPolicy; createdBy: string; createdAt: string;
}
export interface TaskContractRecord { taskId: string; sessionId: string; version: number; contract: TaskContract; contentHash: string; createdBy: string; createdAt: string }
export interface TaskLifecycleEvent {
  id: string; taskId: string; sessionId: string; projectId?: string; runtimeKind?: RuntimeKind;
  eventType: string; aggregateVersion: number; actor: string; createdAt: string;
  correlationId: string; payload: Record<string, unknown>; previousHash: string; contentHash: string;
}
export interface TaskEvidenceRecord {
  id: string; taskId: string; sessionId: string; projectId?: string;
  contractVersion?: number;
  evidenceType: 'build' | 'test' | 'typecheck' | 'lint' | 'git' | 'manual' | 'other';
  source: 'runtime' | 'process' | 'test_runner' | 'git' | 'user' | 'platform';
  status: 'passed' | 'failed' | 'inconclusive'; command?: string; workingDirectory: string;
  runtimeVersion?: string; startedAt: string; finishedAt: string; durationMs: number; exitCode: number | null;
  logRef?: string; artifactRef?: string; manifestRef?: string; commitSha?: string; diffRef?: string;
  codeFingerprint?: string; contentHash: string; createdAt: string; integrityVerified: boolean;
  testCount?: number; reportRef?: string; limitations?: string[];
}
export interface TaskAcceptanceRecord { reviewer: string; comment: string; codeRef: string; evidenceIds: string[]; contractVersion: number; reviewedAt: string }
export interface VerificationExecutionRecord { runId: string; sessionId: string; projectId?: string; recordHash: string; manifestHash: string; createdAt: string }
export interface TaskAuditAppend { eventType: string; actor: string; payload: Record<string, unknown>; correlationId?: string }
export interface TaskAuditSnapshot {
  taskId: string; sessionId: string; contractVersion: number; stateVersion: number;
  events: TaskLifecycleEvent[]; toolEvents: TaskLifecycleEvent[]; pendingToolCalls: TaskLifecycleEvent[];
  approvals: TaskLifecycleEvent[]; budgetEvents: TaskLifecycleEvent[];
}
export interface TaskLifecycleTransition {
  sessionId: string; taskId: string; dimension: 'execution' | 'verification' | 'acceptance';
  to: TaskExecutionStatus | TaskVerificationStatus | TaskAcceptanceStatus; expectedStateVersion: number;
  actor: string; reason?: string; evidenceIds?: string[]; acceptance?: TaskAcceptanceRecord;
}

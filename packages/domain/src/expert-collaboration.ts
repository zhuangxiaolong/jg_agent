import type { AgentTask, AgentTaskRole, ProductSystem } from './index';
import type { ExpertProfile, ExpertScope } from './expert';

export type ExpertCollaborationPlanStatus = 'review' | 'confirmed' | 'executing' | 'completed' | 'partial' | 'conflicted' | 'rejected' | 'cancelled' | 'failed';
export type ExpertCollaborationMode = 'simple' | 'sequential' | 'parallel';
export type ExpertPermissionTier = 'read_only' | 'workspace_write' | 'command_execute' | 'external_access' | 'high_risk';

export interface ExpertTaskSpec {
  taskKey: string;
  expertId: string;
  expertName: string;
  role: AgentTaskRole;
  objective: string;
  sessionId: string;
  projectId?: string;
  system?: ProductSystem;
  scope: ExpertScope[];
  constraints: string[];
  expectedOutput: string[];
  acceptanceCriteria: string[];
  dependencyKeys: string[];
  permissionTier: ExpertPermissionTier;
  workspaceMode: 'read' | 'worktree';
  agentTaskId?: string;
}

export interface ExpertCollaborationTaskResult {
  taskKey: string;
  agentTaskId?: string;
  expertId: string;
  expertName: string;
  status: AgentTask['status'];
  summary?: string;
  findings: Array<{ title: string; detail: string; evidence: Array<{ path: string; sha256: string; lineStart?: number; lineEnd?: number }> }>;
  error?: string;
}

export interface ExpertCollaborationConflict {
  kind: 'evidence_hash' | 'finding_detail';
  subject: string;
  taskKeys: string[];
  details: string[];
}

export interface ExpertCollaborationAggregate {
  planId: string;
  status: 'pending' | 'partial' | 'completed' | 'conflicted';
  summary: string;
  results: ExpertCollaborationTaskResult[];
  conflicts: ExpertCollaborationConflict[];
  evidence: Array<{ path: string; sha256: string; taskKeys: string[] }>;
  createdAt: string;
}

export interface ExpertCollaborationPlan {
  id: string;
  sessionId: string;
  projectId?: string;
  prompt: string;
  classification: ExpertCollaborationMode;
  reason: string;
  status: ExpertCollaborationPlanStatus;
  maxConcurrency: number;
  tasks: ExpertTaskSpec[];
  aggregate?: ExpertCollaborationAggregate;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  rejectedReason?: string;
}

export interface ExpertCollaborationApi {
  preview(sessionId: string, prompt: string): Promise<ExpertCollaborationPlan>;
  list(sessionId: string): Promise<ExpertCollaborationPlan[]>;
  edit(sessionId: string, planId: string, tasks: ExpertTaskSpec[]): Promise<ExpertCollaborationPlan>;
  confirm(sessionId: string, planId: string): Promise<ExpertCollaborationPlan>;
  reject(sessionId: string, planId: string, reason?: string): Promise<ExpertCollaborationPlan>;
  cancel(sessionId: string, planId: string): Promise<ExpertCollaborationPlan>;
  aggregate(sessionId: string, planId: string): Promise<ExpertCollaborationAggregate>;
}

export type ExpertPlannerContext = Pick<ExpertProfile, 'id' | 'name' | 'role' | 'enabled'> & { familyId: string };

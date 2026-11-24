import type { RuntimeKind } from './index';

export type AgentRunStatus = 'queued' | 'preparing' | 'running' | 'waiting_tool' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'recovery_required';
export type AgentRunEventType = 'created' | 'preparing' | 'runtime_started' | 'turn_started' | 'tool_started' | 'tool_completed' | 'checkpoint' | 'heartbeat' | 'stopping' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'recovery_required';
export type AgentRunFailureClass = 'transient' | 'network' | 'service' | 'timeout' | 'cancellation' | 'policy' | 'authentication' | 'context' | 'workspace' | 'unknown';
export type AgentRunRecoveryDecision = 'continue' | 'open_workspace' | 'abandon';

export interface AgentRunFailure {
  class: AgentRunFailureClass;
  message: string;
  recoverable: boolean;
  retryCount: number;
  maxRetries: number;
}

export interface AgentRunRecord {
  id: string;
  sessionId: string;
  projectId?: string;
  runtimeKind: RuntimeKind;
  runtimeVersion?: string;
  providerId?: string;
  modelId?: string;
  status: AgentRunStatus;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  endedAt?: string;
  workspacePath: string;
  branch?: string;
  baseCommit?: string;
  runtimeThreadId?: string;
  currentTurnId?: string;
  lastConfirmedEventSeq?: number;
  checkpointId?: string;
  failure?: AgentRunFailure;
  recoveryReason?: string;
  retryCount: number;
  maxRetries: number;
  updatedAt: string;
}

export interface AgentRunEvent {
  id: string;
  runId: string;
  sessionId: string;
  type: AgentRunEventType;
  status?: AgentRunStatus;
  createdAt: string;
  summary: string;
  data?: Record<string, unknown>;
  seq?: number;
}

export interface AgentRunCheckpoint {
  id: string;
  runId: string;
  sessionId: string;
  schemaVersion: 1;
  createdAt: string;
  goal: string;
  plan: string[];
  completed: string[];
  pending: string[];
  workspacePath: string;
  branch?: string;
  validation: string[];
  knownRisks: string[];
  sourceEventSeq?: number;
}

export interface AgentRunRecoveryView {
  run: AgentRunRecord;
  latestCheckpoint?: AgentRunCheckpoint;
  decision: 'interrupted' | 'recovery_required';
  reasons: string[];
}

export const TERMINAL_RUN_STATUSES: readonly AgentRunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];

const transitions: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ['preparing', 'stopping', 'cancelled', 'failed', 'interrupted'],
  preparing: ['running', 'waiting_tool', 'stopping', 'failed', 'cancelled', 'interrupted', 'recovery_required'],
  running: ['waiting_tool', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted', 'recovery_required'],
  waiting_tool: ['running', 'stopping', 'failed', 'cancelled', 'interrupted', 'recovery_required'],
  stopping: ['cancelled', 'interrupted', 'failed'],
  completed: [], failed: [], cancelled: [], interrupted: ['preparing', 'recovery_required'], recovery_required: ['preparing', 'interrupted', 'cancelled'],
};

export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return from === to || transitions[from].includes(to);
}

export function assertAgentRunTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (!canTransitionAgentRun(from, to)) throw new Error(`运行状态不能从 ${from} 转为 ${to}`);
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

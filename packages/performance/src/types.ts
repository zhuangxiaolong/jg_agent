import type { RuntimeKind } from '../../domain/src';

export type PerformanceStage = 'runtime.initialize' | 'workspace.index_check' | 'workspace.index_update' | 'search' | 'file.read' | 'context.retrieve' | 'context.build' | 'model.queue' | 'model.first_token' | 'model.response' | 'tool.queue' | 'tool.execute' | 'command.execute' | 'test.execute' | 'retry' | 'task.finalize';
export type PerformanceStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';
export interface PerformanceSpan {
  id: string; traceId: string; parentSpanId?: string; stage: PerformanceStage; operation: string; status: PerformanceStatus;
  startedAt: string; endedAt?: string; durationMs?: number; itemCount?: number; byteCount?: number; errorCode?: string;
}
export interface PerformanceTrace {
  id: string; sessionId: string; taskId: string; workspaceId?: string; runtimeKind: RuntimeKind; providerId?: string; modelId?: string;
  endpoint?: string; status: PerformanceStatus; startedAt: string; endedAt?: string; totalDurationMs?: number;
  firstVisibleResponseMs?: number; toolEvents: number; retryCount: number; spans: PerformanceSpan[];
  context?: ContextBuildStats;
}
export interface PerformanceSettings {
  enabled: boolean; telemetryEnabled: boolean; workspaceIndexEnabled: boolean; contextOptimizationEnabled: boolean;
  safeParallelEnabled: boolean; maxParallelReadOperations: number; retainDays: number; contextBudgetTokens: number;
  testStrategy: 'recommend' | 'targeted' | 'full_approval'; version: number; updatedAt: string;
  runtimeOverrides: Partial<Record<RuntimeKind, boolean>>; workspaceOverrides: Record<string, boolean>;
}
export interface PerformanceState { version: 1; settings: PerformanceSettings; traces: PerformanceTrace[] }
export interface PerformanceReport {
  settings: PerformanceSettings; traces: PerformanceTrace[]; latest?: PerformanceTrace;
  unavailable: string[]; sampleCount: number; baselineStatus: 'insufficient_samples' | 'available';
}
export interface ContextFragment {
  workspaceId: string; repositoryId: string; worktreeId: string; path: string; hash: string; indexVersion: number;
  startLine: number; endLine: number; text: string; score: number;
}
export interface ContextBuildStats {
  sourceCount: number; fragmentCount: number; deduplicatedCount: number; trimmedCount: number; cacheHits: number;
  estimatedTokens: number; tokenMeasurement: 'estimated'; budgetTokens: number; requiredOverBudget: boolean;
}
export interface ContextBundle { text: string; fragments: ContextFragment[]; stats: ContextBuildStats }

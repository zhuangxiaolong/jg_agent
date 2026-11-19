import type { RuntimeKind } from '../../domain/src';

export type PerformanceStage = 'runtime.spawn' | 'runtime.initialize' | 'workspace.index_check' | 'workspace.index_update' | 'search' | 'file.read' | 'context.retrieve' | 'context.build' | 'context.memory_retrieve' | 'context.project_retrieve' | 'context.skill_retrieve' | 'context.dictionary_retrieve' | 'context.cache_lookup' | 'context.budget_allocate' | 'skill.match' | 'skill.load' | 'skill.resource_read' | 'model.queue' | 'model.first_token' | 'model.response' | 'tool.queue' | 'tool.execute' | 'command.execute' | 'test.execute' | 'retry' | 'task.finalize';
export type PerformanceStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unavailable';
export type ContextSourceType = 'memory' | 'project_fact' | 'project_decision' | 'skill_metadata' | 'skill_body' | 'dictionary' | 'project_resource' | 'workspace_code' | 'task_evidence';
export type ContextScope = 'global' | 'project' | 'workspace' | 'session';
export type ContextTrust = 'platform_required' | 'user_confirmed' | 'managed_skill' | 'user_memory' | 'untrusted_project_data';
export interface ContextCandidate {
  id: string; sourceType: ContextSourceType; sourceId: string; scope: ContextScope; projectId?: string; workspaceId?: string; sessionId?: string;
  contentHash: string; updatedAt?: string; trust: ContextTrust; status: 'active' | 'confirmed' | 'proposed' | 'rejected' | 'superseded' | 'unavailable';
  title: string; text: string; relevanceScore?: number; reasons?: string[]; explicit?: boolean; systemType?: string; version?: string; pluginHash?: string;
  path?: string; startLine?: number; endLine?: number; indexVersion?: number; fragment?: ContextFragment;
}
export interface ContextSourceSummary { sourceType: ContextSourceType; sourceId: string; title: string; scope: ContextScope; contentHash: string; reason: string; estimatedTokens: number; version?: string; pluginHash?: string; path?: string; startLine?: number; endLine?: number }
export interface ContextExcludedSummary { sourceType: ContextSourceType; sourceId: string; title: string; reason: string }
export interface PerformanceSpan {
  id: string; traceId: string; parentSpanId?: string; stage: PerformanceStage; operation: string; status: PerformanceStatus;
  startedAt: string; endedAt?: string; durationMs?: number; itemCount?: number; byteCount?: number; errorCode?: string;
}
export interface PerformanceTrace {
  id: string; sessionId: string; taskId: string; workspaceId?: string; runtimeKind: RuntimeKind; providerId?: string; modelId?: string;
  endpoint?: string; status: PerformanceStatus; startedAt: string; endedAt?: string; totalDurationMs?: number;
  firstVisibleResponseMs?: number; firstAssistantDeltaMs?: number; firstUiRenderMs?: number; runtimeReuseHit?: boolean; runtimeReuseMissReason?: string; toolEvents: number; retryCount: number; spans: PerformanceSpan[];
  context?: ContextBuildStats; loadedSkills?: ContextSourceSummary[];
}
export interface PerformanceSettings {
  enabled: boolean; telemetryEnabled: boolean; workspaceIndexEnabled: boolean; contextOptimizationEnabled: boolean;
  unifiedContextEnabled: boolean; retrievalCacheEnabled: boolean; contextExplainabilityEnabled: boolean;
  contextSources: Record<ContextSourceType, boolean>; maxSkillContexts: number; maxMemoryItems: number; maxProjectAssertions: number;
  safeParallelEnabled: boolean; maxParallelReadOperations: number; retainDays: number; contextBudgetTokens: number;
  runtimeReuseEnabled: boolean; runtimeReuseIdleTtlMs: number; runtimeReuseMaxIdleInstances: number;
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
  contextSizeChars?: number; requiredChars?: number; retrievedChars?: number;
  requiredEstimatedTokens?: number; optionalEstimatedTokens?: number; sourceCounts?: Partial<Record<ContextSourceType, number>>;
  selected?: ContextSourceSummary[]; excluded?: ContextExcludedSummary[]; contextHash?: string; retrievalDurationMs?: number; buildDurationMs?: number; cacheLookupDurationMs?: number;
  cacheStatus?: 'hit' | 'miss' | 'disabled';
}
export interface ContextBundle { text: string; fragments: ContextFragment[]; stats: ContextBuildStats }

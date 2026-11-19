import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Session } from '../../../../packages/domain/src';
import type { RuntimeEvent } from '../../../../packages/agent-runtime/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { cleanPerformanceText, ContextOptimizer, ContextRetrievalPlanner, PerformanceTelemetry, SafeParallelScheduler, WorkspaceIndexService, type ContextBundle, type ContextCandidate, type PerformanceStage, type PerformanceState, type WorkspaceIndexIdentity } from '../../../../packages/performance/src';

/** 只在现有已授权会话目录内加速检索，失败始终回到原 Runtime 工具。 */
export class DesktopPerformanceService {
  readonly telemetry: PerformanceTelemetry;
  readonly index: WorkspaceIndexService;
  private readonly context = new ContextOptimizer();
  private readonly planner = new ContextRetrievalPlanner();
  private readonly traces = new Map<string, string | undefined>();
  private readonly prompts = new Map<string, string>();
  private readonly turnVersions = new Map<string, number>();
  private readonly contextBundles = new Map<string, { sessionId: string; bundle: ContextBundle }>();
  private scheduler?: SafeParallelScheduler;
  private readonly watchers = new Map<string, () => void>();
  private generation = 0;
  private closed = false;
  private readonly redactText: (text: string) => string;
  constructor(store: LocalStore, dataRoot: string, redact: (text: string) => string) {
    this.redactText = redact;
    this.telemetry = new PerformanceTelemetry({ load: () => store.readPerformanceState() as PerformanceState | undefined, save: value => store.savePerformanceState(value), redact });
    this.index = new WorkspaceIndexService({ cacheRoot: path.join(dataRoot, 'performance-index') });
  }
  identity(session: Session): WorkspaceIndexIdentity {
    const root = path.resolve(session.workspacePath);
    return { workspaceId: session.workspaceId ?? session.projectId ?? session.id, repositoryId: session.projectId ?? session.id, worktreeId: process.platform === 'win32' ? root.toLowerCase() : root, root };
  }
  begin(session: Session, prompt: string, endpoint?: string): void {
    if (this.closed) return;
    this.turnVersions.set(session.id, (this.turnVersions.get(session.id) ?? 0) + 1);
    const generation = this.generation;
    const identity = this.identity(session);
    this.traces.set(session.id, this.telemetry.startTrace({ sessionId: session.id, workspaceId: identity.workspaceId, runtimeKind: session.runtimeKind ?? 'codex', providerId: session.providerId, modelId: session.model, baseUrl: endpoint }));
    this.prompts.set(session.id, prompt);
    const settings = this.telemetry.getSettings();
    if (!session.projectId || !this.telemetry.isEnabled(session.runtimeKind, identity.workspaceId) || !settings.workspaceIndexEnabled) return;
    const span = this.telemetry.startSpan(this.traceId(session.id), { stage: 'workspace.index_update', operation: 'authorized_worktree_incremental_scan' });
    void this.index.ensureFresh(identity).then(async result => {
      this.telemetry.endSpan(span, result.state === 'ready' ? 'completed' : 'unavailable', { itemCount: result.parsedFiles });
      if (this.closed || generation !== this.generation || result.state !== 'ready') return;
      if (!this.watchers.has(session.id)) {
        const stop = await this.index.watch(identity);
        if (this.closed || generation !== this.generation) stop(); else this.watchers.set(session.id, stop);
      }
    }).catch(() => this.telemetry.endSpan(span, 'unavailable'));
  }
  traceId(sessionId: string): string | undefined { return this.traces.get(sessionId); }
  setRuntimeReuse(sessionId: string, hit: boolean, missReason?: string): void { this.telemetry.setRuntimeReuse(this.traceId(sessionId), hit, missReason); }
  markFirstUiRender(sessionId: string): void { this.telemetry.markFirstUiRender(this.traceId(sessionId)); }
  recordCompletedSpan(sessionId: string, stage: PerformanceStage, operation: string, durationMs: number): void {
    this.telemetry.recordCompletedSpan(this.traceId(sessionId), { stage, operation, durationMs });
  }
  record(sessionId: string, event: RuntimeEvent): void { this.telemetry.recordRuntimeEvent(this.traceId(sessionId), event); }
  recordLoadedSkill(sessionId: string, input: { skillId: string; name: string; pluginVersion: string; pluginHash: string; skillHash: string; scope: 'global' | 'project'; content: string }): void {
    const safe = (value: string) => this.redactText(cleanPerformanceText(value));
    this.telemetry.recordLoadedSkill(this.traceId(sessionId), { sourceType: 'skill_body', sourceId: safe(input.skillId), title: safe(input.name), scope: input.scope, contentHash: input.skillHash, reason: '本轮 Skill Loader 已验证并加载正文', estimatedTokens: Math.ceil(Buffer.byteLength(input.content, 'utf8') / 3), version: safe(input.pluginVersion), pluginHash: input.pluginHash });
  }
  finish(sessionId: string, state: 'completed' | 'failed' | 'interrupted' | 'cancelled'): void {
    this.telemetry.finishTrace(this.traceId(sessionId), state);
    this.turnVersions.set(sessionId, (this.turnVersions.get(sessionId) ?? 0) + 1);
    for (const [key, entry] of this.contextBundles) if (entry.sessionId === sessionId) this.contextBundles.delete(key);
    this.prompts.delete(sessionId); this.scheduler?.cancelParent(sessionId);
  }
  async augmentContext(session: Session, requiredText: string, options?: { query: string; candidates: ContextCandidate[]; systemType?: string; fallbackText: () => string }): Promise<string> {
    const settings = this.telemetry.getSettings(), identity = this.identity(session), traceId = this.traceId(session.id);
    if (!this.telemetry.isEnabled(session.runtimeKind, identity.workspaceId) || !settings.contextOptimizationEnabled) return requiredText;
    if (options && settings.unifiedContextEnabled) return this.augmentUnifiedContext(session, requiredText, options, settings, identity, traceId);
    const span = this.telemetry.startSpan(traceId, { stage: 'context.build', operation: 'required_context_and_relevant_fragments' });
    try {
      const query = this.prompts.get(session.id) ?? '';
      const retrieve = async () => settings.workspaceIndexEnabled && session.projectId ? this.index.search(identity, query, { limit: 6 }) : [];
      let fragments;
      if (settings.safeParallelEnabled) {
        this.scheduler ??= new SafeParallelScheduler({ maxParallel: settings.maxParallelReadOperations, maxQueued: 12, authorize: operation => operation.safety === 'readonly' });
        const scheduler = this.scheduler;
        const operation = { id: randomUUID(), parentTaskId: session.id, workspaceId: identity.workspaceId, repositoryIds: [identity.repositoryId], worktreeId: identity.worktreeId, operation: 'context.index_search', safety: 'readonly' as const, timeoutMs: 15000, requiresApproval: false };
        fragments = (await scheduler.submit(operation, async signal => { if (signal.aborted) throw new Error('检索已取消'); const value = await retrieve(); if (signal.aborted) throw new Error('检索已取消'); return value; })).value;
      } else fragments = await retrieve();
      const bundle = this.context.build({ requiredText, fragments, budgetTokens: settings.contextBudgetTokens });
      this.telemetry.setContextStats(traceId, bundle.stats);
      this.telemetry.endSpan(span, 'completed', { itemCount: bundle.fragments.length });
      return bundle.text;
    } catch {
      this.telemetry.endSpan(span, 'unavailable'); return requiredText;
    }
  }
  private safeStats(stats: ContextBundle['stats'], explainability: boolean) {
    const safe = (value: string, limit: number) => this.redactText(cleanPerformanceText(value)).slice(0, limit);
    return { ...stats,
      ...(explainability ? {
        selected: stats.selected?.map(item => ({ ...item, sourceId: safe(item.sourceId, 200), title: safe(item.title, 120), reason: safe(item.reason, 240), ...(item.path ? { path: safe(item.path, 500) } : {}) })),
        excluded: stats.excluded?.map(item => ({ ...item, sourceId: safe(item.sourceId, 200), title: safe(item.title, 120), reason: safe(item.reason, 160) })),
      } : { selected: [], excluded: [] }),
    };
  }
  private async augmentUnifiedContext(session: Session, requiredText: string, options: { query: string; candidates: ContextCandidate[]; systemType?: string; fallbackText: () => string }, settings: ReturnType<PerformanceTelemetry['getSettings']>, identity: WorkspaceIndexIdentity, traceId?: string): Promise<string> {
    const turnVersion = this.turnVersions.get(session.id) ?? 0;
    const stage = (name: PerformanceStage, operation: string) => this.telemetry.startSpan(traceId, { stage: name, operation });
    const retrievalSpan = stage('context.retrieve', 'workspace_and_source_candidates');
    const retrievalStarted = performance.now();
    try {
      const retrieve = async () => settings.workspaceIndexEnabled && session.projectId ? this.index.search(identity, options.query, { limit: 8 }) : [];
      let fragments;
      if (settings.safeParallelEnabled && session.projectId && settings.workspaceIndexEnabled) {
        this.scheduler ??= new SafeParallelScheduler({ maxParallel: settings.maxParallelReadOperations, maxQueued: 12, authorize: operation => operation.safety === 'readonly' });
        const operation = { id: randomUUID(), parentTaskId: session.id, workspaceId: identity.workspaceId, repositoryIds: [identity.repositoryId], worktreeId: identity.worktreeId, operation: 'context.index_search', safety: 'readonly' as const, timeoutMs: 15000, requiresApproval: false };
        fragments = (await this.scheduler.submit(operation, async signal => { if (signal.aborted) throw new Error('检索已取消'); const value = await retrieve(); if (signal.aborted) throw new Error('检索已取消'); return value; })).value;
      } else fragments = await retrieve();
      const retrievalDurationMs = Math.max(0, performance.now() - retrievalStarted);
      this.telemetry.endSpan(retrievalSpan, 'completed', { itemCount: options.candidates.length + fragments.length });
      const candidates: ContextCandidate[] = [...options.candidates, ...fragments.map(fragment => ({ id: `code:${fragment.repositoryId}:${fragment.path}:${fragment.startLine}-${fragment.endLine}`, sourceType: 'workspace_code' as const, sourceId: `${fragment.repositoryId}:${fragment.path}`, scope: 'workspace' as const, workspaceId: fragment.workspaceId, contentHash: fragment.hash, trust: 'untrusted_project_data' as const, status: 'active' as const, title: `${fragment.path}:${fragment.startLine}-${fragment.endLine}`, text: fragment.text, relevanceScore: fragment.score, reasons: ['工作区索引关键词命中'], path: fragment.path, startLine: fragment.startLine, endLine: fragment.endLine, indexVersion: fragment.indexVersion, fragment }))];
      const plannedSpan = stage('context.budget_allocate', 'rank_and_filter_context_candidates');
      const allocationStarted = performance.now();
      const planned = this.planner.plan({ sessionId: session.id, projectId: session.projectId, workspaceId: identity.workspaceId, systemType: options.systemType, query: options.query }, candidates, settings);
      const allocationDurationMs = Math.max(0, performance.now() - allocationStarted);
      this.telemetry.endSpan(plannedSpan, 'completed', { itemCount: planned.candidates.length });
      const indexVersion = this.index.status(identity).version ?? 0;
      const sourceState = planned.candidates.map(candidate => [candidate.id, candidate.sourceType, candidate.sourceId, candidate.scope, candidate.projectId, candidate.workspaceId, candidate.sessionId, candidate.contentHash, createHash('sha256').update(`${candidate.title}\n${candidate.text}`).digest('hex'), candidate.updatedAt, candidate.status, candidate.trust, candidate.relevanceScore, candidate.reasons, candidate.explicit, candidate.systemType, candidate.version, candidate.pluginHash, candidate.path, candidate.startLine, candidate.endLine, candidate.indexVersion]);
      const cacheKey = createHash('sha256').update(JSON.stringify([session.id, session.projectId, session.runtimeKind, options.systemType, identity, indexVersion, createHash('sha256').update(options.query).digest('hex'), createHash('sha256').update(requiredText).digest('hex'), sourceState, planned.excluded, settings.contextBudgetTokens, settings.contextSources, settings.maxSkillContexts, settings.maxMemoryItems, settings.maxProjectAssertions])).digest('hex');
      const cacheSpan = stage('context.cache_lookup', 'session_context_bundle_cache');
      const cacheStarted = performance.now();
      const cached = settings.retrievalCacheEnabled ? this.contextBundles.get(cacheKey) : undefined;
      if (cached) { this.contextBundles.delete(cacheKey); this.contextBundles.set(cacheKey, cached); }
      this.telemetry.endSpan(cacheSpan, 'completed', { itemCount: cached ? 1 : 0 });
      const cacheLookupMs = Math.max(0, performance.now() - cacheStarted);
      let bundle: ContextBundle;
      if (cached) {
        bundle = { ...cached.bundle, fragments: [...cached.bundle.fragments], stats: { ...cached.bundle.stats, sourceCounts: { ...cached.bundle.stats.sourceCounts }, selected: cached.bundle.stats.selected?.map(item => ({ ...item })), excluded: cached.bundle.stats.excluded?.map(item => ({ ...item })), cacheHits: cached.bundle.stats.cacheHits + 1, cacheStatus: 'hit', retrievalDurationMs, buildDurationMs: undefined, cacheLookupDurationMs: cacheLookupMs } };
      } else {
        const buildSpan = stage('context.build', 'required_context_plus_budgeted_sources');
        const buildStarted = performance.now();
        bundle = this.context.build({ requiredText, candidates: planned.candidates, excluded: planned.excluded, budgetTokens: settings.contextBudgetTokens, cacheEnabled: settings.retrievalCacheEnabled });
        const buildDurationMs = Math.max(0, performance.now() - buildStarted);
        bundle.stats.retrievalDurationMs = retrievalDurationMs;
        bundle.stats.buildDurationMs = buildDurationMs + allocationDurationMs;
        bundle.stats.cacheStatus = settings.retrievalCacheEnabled ? 'miss' : 'disabled';
        bundle.stats.cacheLookupDurationMs = cacheLookupMs;
        this.telemetry.endSpan(buildSpan, 'completed', { itemCount: bundle.stats.sourceCount, byteCount: Buffer.byteLength(bundle.text, 'utf8') });
        if (settings.retrievalCacheEnabled) {
          this.contextBundles.set(cacheKey, { sessionId: session.id, bundle });
          while (this.contextBundles.size > 100) this.contextBundles.delete(this.contextBundles.keys().next().value!);
        }
      }
      if ((this.turnVersions.get(session.id) ?? 0) !== turnVersion) return options.fallbackText();
      this.telemetry.setContextStats(traceId, this.safeStats(bundle.stats, settings.contextExplainabilityEnabled));
      return bundle.text;
    } catch {
      this.telemetry.endSpan(retrievalSpan, 'unavailable');
      return options.fallbackText();
    }
  }
  indexStatus(session: Session) {
    if (!session.projectId) return { status: '未关联项目', fileCount: 0 };
    const settings = this.telemetry.getSettings(), identity = this.identity(session);
    if (!this.telemetry.isEnabled(session.runtimeKind, identity.workspaceId) || !settings.workspaceIndexEnabled) return { status: '已关闭', fileCount: 0 };
    const status = this.index.status(identity);
    const names = { unavailable: '未建立', indexing: '索引中', ready: '可用', failed: '索引失败（沿用原工具）' };
    return { status: names[status.state], fileCount: status.fileCount, updatedAt: status.updatedAt, error: status.error };
  }
  async rebuild(session: Session): Promise<void> {
    if (!session.projectId) throw new Error('索引需要已关联项目的会话');
    if (!this.telemetry.isEnabled(session.runtimeKind, this.identity(session).workspaceId) || !this.telemetry.getSettings().workspaceIndexEnabled) throw new Error('请先启用当前工作区索引');
    const result = await this.index.rebuild(this.identity(session));
    if (result.state === 'failed') throw new Error(result.error ?? '工作区索引失败');
  }
  stopIndexes(): void { this.generation++; this.index.close(); this.watchers.clear(); this.context.clear(); this.contextBundles.clear(); for (const sessionId of this.traces.keys()) this.scheduler?.cancelParent(sessionId); this.scheduler = undefined; }
  close(): void { this.closed = true; this.stopIndexes(); for (const sessionId of this.traces.keys()) this.finish(sessionId, 'interrupted'); this.telemetry.flush(); }
}

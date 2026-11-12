import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from '../../../../packages/domain/src';
import type { RuntimeEvent } from '../../../../packages/agent-runtime/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { ContextOptimizer, PerformanceTelemetry, SafeParallelScheduler, WorkspaceIndexService, type PerformanceState, type WorkspaceIndexIdentity } from '../../../../packages/performance/src';

/** 只在现有已授权会话目录内加速检索，失败始终回到原 Runtime 工具。 */
export class DesktopPerformanceService {
  readonly telemetry: PerformanceTelemetry;
  readonly index: WorkspaceIndexService;
  private readonly context = new ContextOptimizer();
  private readonly traces = new Map<string, string | undefined>();
  private readonly prompts = new Map<string, string>();
  private scheduler?: SafeParallelScheduler;
  private readonly watchers = new Map<string, () => void>();
  private generation = 0;
  private closed = false;
  constructor(store: LocalStore, dataRoot: string, redact: (text: string) => string) {
    this.telemetry = new PerformanceTelemetry({ load: () => store.readPerformanceState() as PerformanceState | undefined, save: value => store.savePerformanceState(value), redact });
    this.index = new WorkspaceIndexService({ cacheRoot: path.join(dataRoot, 'performance-index') });
  }
  identity(session: Session): WorkspaceIndexIdentity {
    const root = path.resolve(session.workspacePath);
    return { workspaceId: session.workspaceId ?? session.projectId ?? session.id, repositoryId: session.projectId ?? session.id, worktreeId: process.platform === 'win32' ? root.toLowerCase() : root, root };
  }
  begin(session: Session, prompt: string, endpoint?: string): void {
    if (this.closed) return;
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
  record(sessionId: string, event: RuntimeEvent): void { this.telemetry.recordRuntimeEvent(this.traceId(sessionId), event); }
  finish(sessionId: string, state: 'completed' | 'failed' | 'interrupted' | 'cancelled'): void {
    this.telemetry.finishTrace(this.traceId(sessionId), state);
    this.prompts.delete(sessionId); this.scheduler?.cancelParent(sessionId);
  }
  async augmentContext(session: Session, requiredText: string): Promise<string> {
    const settings = this.telemetry.getSettings(), identity = this.identity(session), traceId = this.traceId(session.id);
    if (!this.telemetry.isEnabled(session.runtimeKind, identity.workspaceId) || !settings.contextOptimizationEnabled) return requiredText;
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
  stopIndexes(): void { this.generation++; this.index.close(); this.watchers.clear(); this.context.clear(); for (const sessionId of this.traces.keys()) this.scheduler?.cancelParent(sessionId); this.scheduler = undefined; }
  close(): void { this.closed = true; this.stopIndexes(); for (const sessionId of this.traces.keys()) this.finish(sessionId, 'interrupted'); this.telemetry.flush(); }
}

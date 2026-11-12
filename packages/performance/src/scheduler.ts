import { performance } from 'node:perf_hooks';

export type OperationSafety = 'readonly' | 'workspace_write' | 'repository_mutation' | 'external_side_effect';
export interface ScheduledOperation {
  id: string; parentTaskId: string; workspaceId: string; repositoryIds: string[]; worktreeId: string;
  operation: string; safety: OperationSafety; timeoutMs: number; requiresApproval: boolean;
}
export interface ScheduledResult<T> { value: T; queueDurationMs: number; executionDurationMs: number }
interface PendingOperation {
  input: ScheduledOperation; controller: AbortController; queuedAt: number;
  execute: (signal: AbortSignal) => Promise<unknown>; resolve: (value: ScheduledResult<unknown>) => void; reject: (error: Error) => void;
}
const aborted = () => new Error('调度操作已取消或超时');

/** 仅调度调用方已授权的操作；超时后等待实际执行退出才释放锁。 */
export class SafeParallelScheduler {
  private readonly queued: PendingOperation[] = [];
  private readonly active = new Map<string, PendingOperation>();
  constructor(private readonly options: { maxParallel?: number; maxQueued?: number; authorize: (operation: ScheduledOperation) => boolean }) {}
  submit<T>(input: ScheduledOperation, execute: (signal: AbortSignal) => Promise<T>): Promise<ScheduledResult<T>> {
    if (!input.id || !input.parentTaskId || !input.workspaceId || !input.worktreeId || !input.repositoryIds.length || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 1) return Promise.reject(new Error('调度任务元数据无效'));
    if (input.requiresApproval || input.safety === 'external_side_effect' || !this.options.authorize(input)) return Promise.reject(new Error('操作尚未获平台授权，禁止通过性能调度绕过审批'));
    if (this.active.has(input.id) || this.queued.some(item => item.input.id === input.id)) return Promise.reject(new Error('调度任务 ID 重复'));
    if (this.queued.length >= (this.options.maxQueued ?? 100)) return Promise.reject(new Error('调度队列已满，请等待当前任务完成'));
    return new Promise<ScheduledResult<T>>((resolve, reject) => {
      this.queued.push({ input: structuredClone(input), controller: new AbortController(), queuedAt: performance.now(), execute, resolve: resolve as PendingOperation['resolve'], reject }); this.pump();
    });
  }
  private conflicts(left: ScheduledOperation, right: ScheduledOperation): boolean {
    // workspace ID 不是授权边界；同 repository/worktree 即使来自不同会话仍共用锁。
    const sharedRepository = left.repositoryIds.some(id => right.repositoryIds.includes(id));
    if (!sharedRepository) return false;
    if (left.safety === 'repository_mutation' || right.safety === 'repository_mutation') return true;
    return left.worktreeId === right.worktreeId && (left.safety !== 'readonly' || right.safety !== 'readonly');
  }
  private pump(): void {
    const limit = Math.max(1, Math.min(3, this.options.maxParallel ?? 3));
    for (let i = 0; i < this.queued.length && this.active.size < limit;) {
      const next = this.queued[i];
      const conflict = [...this.active.values()].some(item => this.conflicts(next.input, item.input));
      // 写者已在排队时，后来的相同工作树读者不能无限抢占。
      const earlierConflict = this.queued.slice(0, i).some(item => this.conflicts(next.input, item.input));
      if (conflict || earlierConflict) { i++; continue; }
      this.queued.splice(i, 1); this.active.set(next.input.id, next); void this.run(next);
    }
  }
  private async run(item: PendingOperation): Promise<void> {
    const started = performance.now(); const timer = setTimeout(() => item.controller.abort(), item.input.timeoutMs); timer.unref();
    try {
      const value = await item.execute(item.controller.signal);
      if (item.controller.signal.aborted) throw aborted();
      item.resolve({ value, queueDurationMs: started - item.queuedAt, executionDurationMs: performance.now() - started });
    } catch (error) { item.reject(error instanceof Error ? error : new Error('调度操作失败')); }
    finally { clearTimeout(timer); this.active.delete(item.input.id); this.pump(); }
  }
  cancelParent(parentTaskId: string): void {
    for (let i = this.queued.length - 1; i >= 0; i--) if (this.queued[i].input.parentTaskId === parentTaskId) { const [item] = this.queued.splice(i, 1); item.controller.abort(); item.reject(aborted()); }
    for (const item of this.active.values()) if (item.input.parentTaskId === parentTaskId) item.controller.abort();
  }
  getStatus(): { running: string[]; queued: string[]; cancellationPending: string[] } {
    return { running: [...this.active.keys()], queued: this.queued.map(item => item.input.id), cancellationPending: [...this.active.values()].filter(item => item.controller.signal.aborted).map(item => item.input.id) };
  }
}

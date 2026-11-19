interface Pending<T> { turnId: string; execute: () => Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void; }

/** 只为明确无副作用的资料检索提供有限并发；运行中的调用不被强制中断，排队项可取消。 */
export class ReadonlyToolConcurrency {
  private readonly queue: Pending<unknown>[] = [];
  private active = 0;
  constructor(private readonly maxParallel = 3) {
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 3) throw new Error('只读工具并发上限必须为 1 至 3');
  }
  run<T>(turnId: string, execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error('只读工具调用已取消'));
    return new Promise<T>((resolve, reject) => {
      const item: Pending<T> = { turnId, execute, resolve, reject, signal };
      if (signal) {
        item.onAbort = () => {
          const index = this.queue.indexOf(item as Pending<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1); reject(new Error('只读工具调用已取消'));
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      this.queue.push(item as Pending<unknown>); this.pump();
    });
  }
  private pump(): void {
    while (this.active < this.maxParallel && this.queue.length) {
      const item = this.queue.shift()!;
      if (item.signal?.aborted) { item.reject(new Error('只读工具调用已取消')); continue; }
      this.active++;
      void item.execute().then(value => item.resolve(value), error => item.reject(error instanceof Error ? error : new Error(String(error)))).finally(() => {
        this.active--; if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort); this.pump();
      });
    }
  }
  get pendingCount(): number { return this.queue.length; }
  get activeCount(): number { return this.active; }
  cancelTurn(turnId: string): void {
    for (const item of [...this.queue]) if (item.turnId === turnId) this.remove(item);
  }
  private remove(item: Pending<unknown>): void {
    const index = this.queue.indexOf(item); if (index < 0) return;
    this.queue.splice(index, 1); item.reject(new Error('只读工具调用已取消'));
  }
}

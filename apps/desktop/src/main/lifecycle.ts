export interface RunTicket { readonly sessionId: string; readonly startedAt: number; cancelled: boolean }

/** 异步启动的各阶段共享令牌，取消后旧请求不能继续启动工具或覆盖新任务。 */
export class RunLifecycle {
  private readonly active = new Map<string, RunTicket>();

  get size(): number { return this.active.size; }
  get tickets(): RunTicket[] { return [...this.active.values()]; }
  get(sessionId: string): RunTicket | undefined { return this.active.get(sessionId); }
  isCurrent(ticket: RunTicket): boolean { return this.active.get(ticket.sessionId) === ticket; }

  begin(sessionId: string): RunTicket {
    if (this.active.has(sessionId)) throw new Error('当前会话有正在执行的任务，请等待或取消');
    const ticket: RunTicket = { sessionId, startedAt: Date.now(), cancelled: false };
    this.active.set(sessionId, ticket);
    return ticket;
  }

  assertCurrent(ticket: RunTicket): void {
    if (!this.isCurrent(ticket) || ticket.cancelled) throw new Error('任务启动已取消');
  }

  cancel(ticket: RunTicket): void {
    if (this.isCurrent(ticket)) ticket.cancelled = true;
  }

  finish(ticket: RunTicket): void {
    if (this.isCurrent(ticket)) this.active.delete(ticket.sessionId);
  }
}

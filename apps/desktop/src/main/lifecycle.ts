export interface RunTicket { readonly sessionId: string; cancelled: boolean }

/** 异步启动的各阶段共享令牌，取消后旧请求不能继续启动工具或覆盖新任务。 */
export class RunLifecycle {
  private active?: RunTicket;

  get current(): RunTicket | undefined { return this.active; }

  begin(sessionId: string): RunTicket {
    if (this.active) throw new Error('当前有正在执行的任务，请等待或取消');
    const ticket: RunTicket = { sessionId, cancelled: false };
    this.active = ticket;
    return ticket;
  }

  assertCurrent(ticket: RunTicket): void {
    if (this.active !== ticket || ticket.cancelled) throw new Error('任务启动已取消');
  }

  cancel(ticket: RunTicket): void {
    if (this.active === ticket) ticket.cancelled = true;
  }

  finish(ticket: RunTicket): void {
    if (this.active === ticket) this.active = undefined;
  }
}

import { randomUUID } from 'node:crypto';
import type { ApprovalRequest } from '../../../../packages/domain/src';
import type { RunTicket } from './lifecycle';

type Decision = 'accept' | 'decline';
type Pending = { ticket: RunTicket; settle: (decision: Decision) => void };

/** 审批只绑定本轮任务，渲染进程只能提交不可复用的临时令牌。 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  constructor(
    private readonly current: () => RunTicket | undefined,
    private readonly publish: (request: ApprovalRequest) => void,
    private readonly resolved: (token: string) => void,
    private readonly timeoutMs = 120_000,
  ) {}

  request(ticket: RunTicket, detail: Omit<ApprovalRequest, 'token' | 'sessionId'>, signal: AbortSignal): Promise<Decision> {
    if (this.current() !== ticket || ticket.cancelled || signal.aborted || this.pending.size >= 16) return Promise.resolve('decline');
    return new Promise(resolve => {
      const token = randomUUID();
      const abort = () => settle('decline');
      const settle = (decision: Decision) => {
        if (!this.pending.delete(token)) return;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        resolve(decision);
        try { this.resolved(token); } catch { /* 窗口销毁不能保留审批。 */ }
      };
      const timer = setTimeout(abort, this.timeoutMs);
      timer.unref?.();
      this.pending.set(token, { ticket, settle });
      signal.addEventListener('abort', abort, { once: true });
      try { this.publish({ ...detail, token, sessionId: ticket.sessionId }); }
      catch { settle('decline'); }
    });
  }

  decide(token: string, decision: Decision): void {
    const pending = this.pending.get(token);
    const active = this.current();
    if (!pending || !active || pending.ticket !== active || active.cancelled) {
      pending?.settle('decline');
      throw new Error('审批请求已失效或已处理');
    }
    pending.settle(decision);
  }

  decline(sessionId?: string): void {
    for (const pending of this.pending.values()) {
      if (!sessionId || pending.ticket.sessionId === sessionId) pending.settle('decline');
    }
  }
}

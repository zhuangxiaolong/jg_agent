import { randomUUID } from 'node:crypto';
import type { RuntimeApproval } from '../../domain/src';
import type { RuntimeEvent } from './index';

/** 只在本轮保持决策回调。结束、断开或取消会使旧卡片失效。 */
export class RuntimeApprovals {
  private readonly pending = new Map<string, (state: 'allowed' | 'rejected' | 'expired') => void>();

  constructor(private readonly emit: (event: RuntimeEvent) => void) {}

  request(threadId: string, details: Pick<RuntimeApproval, 'title' | 'toolName' | 'input'>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const requestId = randomUUID();
    const publish = (state: RuntimeApproval['state'], text: string) => this.emit({
      threadId, type: 'approval', text, approval: { ...details, input: state === 'pending' ? details.input : '{}', requestId, state },
    });
    return new Promise(resolve => {
      const expire = () => finish('expired');
      const finish = (state: 'allowed' | 'rejected' | 'expired') => {
        if (!this.pending.delete(requestId)) return;
        signal.removeEventListener('abort', expire);
        resolve(state === 'allowed');
        publish(state, state === 'allowed' ? '已允许本次操作' : state === 'rejected' ? '已拒绝本次操作' : '审批已失效');
      };
      this.pending.set(requestId, finish);
      signal.addEventListener('abort', expire, { once: true });
      publish('pending', '等待确认工具操作');
    });
  }

  async respond(requestId: string, decision: 'allow_once' | 'reject_once'): Promise<void> {
    const finish = this.pending.get(requestId);
    if (!finish) throw new Error('该审批已处理或所属任务已结束');
    finish(decision === 'allow_once' ? 'allowed' : 'rejected');
  }
}

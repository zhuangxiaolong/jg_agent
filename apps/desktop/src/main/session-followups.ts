import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../../../../packages/domain/src';

export interface QueuedSessionTurn { id: string; prompt: string }
const QUEUED_TURN_PREFIX = 'queued-turn:';
export const MAX_QUEUED_SESSION_TURNS = 10;

/** 排队原文与领取/停止状态都保存在会话事件中；重载页面不会丢失，也不会并发启动同一会话。 */
export class SessionFollowups {
  private readonly dispatching = new Set<string>();
  private readonly activeTurns = new Map<string, { turn: QueuedSessionTurn; dispatchRequested: boolean; dispatched: boolean; stopReason?: string }>();
  constructor(private readonly options: {
    events(sessionId: string): AgentEvent[];
    publish(sessionId: string, type: AgentEvent['type'], text: string, requestId?: string): void;
    ready(sessionId: string): boolean;
    execute(sessionId: string, turn: QueuedSessionTurn): Promise<unknown>;
  }) {}

  isDispatching(sessionId: string): boolean { return this.dispatching.has(sessionId); }

  private unresolved(sessionId: string): Array<QueuedSessionTurn & { started: boolean }> {
    const pending = new Map<string, QueuedSessionTurn>();
    const started = new Set<string>();
    for (const event of this.options.events(sessionId)) {
      if (typeof event.requestId !== 'string' || !event.requestId.startsWith(QUEUED_TURN_PREFIX)) continue;
      if (event.type === 'user') pending.set(event.requestId, { id: event.requestId, prompt: event.text });
      else if (event.type === 'status') {
        if (event.text === '开始执行排队补充任务。') started.add(event.requestId);
        else pending.delete(event.requestId);
      }
    }
    return [...pending.values()].map(turn => ({ ...turn, started: started.has(turn.id) }));
  }

  pending(sessionId: string): QueuedSessionTurn[] {
    return this.unresolved(sessionId).filter(turn => !turn.started).map(({ id, prompt }) => ({ id, prompt }));
  }

  enqueue(sessionId: string, prompt: string): void {
    if (this.pending(sessionId).length >= MAX_QUEUED_SESSION_TURNS) throw new Error('当前会话已有10条补充任务排队，请等待处理后再发送');
    const id = `${QUEUED_TURN_PREFIX}${randomUUID()}`;
    this.options.publish(sessionId, 'user', prompt, id);
    this.options.publish(sessionId, 'status', '补充任务已排队，将在当前任务结束后依次执行。');
  }

  begin(sessionId: string, id: string): void {
    if (this.pending(sessionId)[0]?.id !== id) throw new Error('补充任务队列已变化，本次未启动');
    this.options.publish(sessionId, 'status', '开始执行排队补充任务。', id);
    this.activeTurns.set(sessionId, { turn: { id, prompt: this.options.events(sessionId).find(event => event.type === 'user' && event.requestId === id)?.text ?? '' }, dispatchRequested: this.dispatching.has(sessionId), dispatched: false });
  }

  markDispatched(sessionId: string, id: string): void {
    const active = this.activeTurns.get(sessionId);
    if (active?.turn.id !== id) return;
    active.dispatched = true;
    this.options.publish(sessionId, 'status', active.stopReason
      ? `补充任务已交给 Runtime，但${active.stopReason}，执行情况未确认。`
      : '排队补充任务已交给 Runtime。', id);
  }

  stop(sessionId: string, reason: string): void {
    const active = this.activeTurns.get(sessionId);
    if (active && !active.dispatched) {
      if (active.dispatchRequested) active.stopReason ??= reason;
    }
    for (const turn of this.unresolved(sessionId)) {
      if (active?.turn.id === turn.id) continue;
      this.options.publish(sessionId, 'status', `补充任务未执行（${reason}），原文已保留，请重新发送。`, turn.id);
      if (active?.turn.id === turn.id) this.activeTurns.delete(sessionId);
    }
  }

  async drain(sessionId: string): Promise<void> {
    if (this.dispatching.has(sessionId) || !this.options.ready(sessionId)) return;
    const turn = this.pending(sessionId)[0];
    if (!turn) return;
    this.dispatching.add(sessionId);
    try {
      const active = this.activeTurns.get(sessionId);
      if (active?.turn.id === turn.id) active.dispatchRequested = true;
      await this.options.execute(sessionId, turn);
      const current = this.activeTurns.get(sessionId);
      if (current?.turn.id === turn.id) {
        if (current.dispatched) { /* 主流程已确认 Runtime 接收。 */ }
        else if (current.stopReason) this.options.publish(sessionId, 'status', `补充任务已交给 Runtime，但${current.stopReason}，执行情况未确认。`, turn.id);
        else {
          current.dispatched = true;
          this.options.publish(sessionId, 'status', '排队补充任务已交给 Runtime。', turn.id);
        }
      }
    }
    catch {
      const active = this.activeTurns.get(sessionId);
      if (active?.turn.id === turn.id && !active.dispatched) {
        this.options.publish(sessionId, 'status', `补充任务未执行（${active.stopReason ?? '启动失败'}），原文已保留，请重新发送。`, turn.id);
        this.activeTurns.delete(sessionId);
      }
      this.stop(sessionId, '启动失败');
    }
    finally {
      this.dispatching.delete(sessionId);
      if (this.activeTurns.get(sessionId)?.turn.id === turn.id) this.activeTurns.delete(sessionId);
      if (this.options.ready(sessionId) && this.pending(sessionId).length) void this.drain(sessionId);
    }
  }
}

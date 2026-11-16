import type { RuntimeEvent } from '../../../../packages/agent-runtime/src';

/** 合并连续的消息与同一命令输出增量，其他事件前同步刷新并保留顺序。 */
export class RuntimeEventBatcher {
  private pending?: RuntimeEvent;
  private timer?: ReturnType<typeof setTimeout>;
  private firstDeltaPublished = false;
  constructor(private readonly publish: (event: RuntimeEvent) => void, private readonly delayMs = 80, private readonly immediateFirstDelta = false) {}
  push(event: RuntimeEvent): void {
    const mergeable = event.type === 'delta' || event.activity?.kind === 'command_output';
    if (!mergeable) { this.flush(); this.publish(event); return; }
    if (this.pending && this.pending.threadId !== event.threadId) this.flush();
    if (this.pending?.activity?.kind === 'command_output' && (event.activity?.kind !== 'command_output' || this.pending.activity.itemId !== event.activity.itemId)) this.flush();
    if (this.pending && ((this.pending.type === 'delta') !== (event.type === 'delta'))) this.flush();
    if (event.type === 'delta' && this.immediateFirstDelta && !this.firstDeltaPublished && event.text.trim()) {
      this.firstDeltaPublished = true;
      this.flush(); this.publish(event); return;
    }
    this.pending = this.pending ? { ...this.pending, text: this.pending.text + event.text } : { ...event };
    if (this.pending.text.length >= 16000) { this.flush(); return; }
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), this.delayMs); this.timer.unref(); }
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const event = this.pending; this.pending = undefined;
    if (event) this.publish(event);
  }
}

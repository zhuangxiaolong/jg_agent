import type { RuntimeAdapter } from '../../../../packages/agent-runtime/src/manager';
import type { RunTicket } from './lifecycle';

/** 运行实例同时绑定会话和本轮票据，旧实例不能覆盖或关闭后续轮次。 */
export class SessionRuntimes {
  private readonly entries = new Map<string, { ticket: RunTicket; adapter: RuntimeAdapter; terminal: boolean; sendSettled: boolean }>();

  get(sessionId: string): RuntimeAdapter | undefined { return this.entries.get(sessionId)?.adapter; }
  getForTicket(ticket: RunTicket): RuntimeAdapter | undefined {
    const entry = this.entries.get(ticket.sessionId);
    return entry?.ticket === ticket ? entry.adapter : undefined;
  }

  bind(ticket: RunTicket, adapter: RuntimeAdapter): void { this.entries.set(ticket.sessionId, { ticket, adapter, terminal: false, sendSettled: false }); }

  owns(ticket: RunTicket, adapter: RuntimeAdapter): boolean {
    const entry = this.entries.get(ticket.sessionId);
    return entry?.ticket === ticket && entry.adapter === adapter;
  }

  release(ticket: RunTicket, adapter: RuntimeAdapter): void {
    if (this.owns(ticket, adapter)) this.entries.delete(ticket.sessionId);
  }

  async markTerminal(ticket: RunTicket, adapter: RuntimeAdapter): Promise<void> {
    if (!this.owns(ticket, adapter)) return;
    this.entries.get(ticket.sessionId)!.terminal = true;
    await this.closeIfSettled(ticket, adapter);
  }

  async markSendSettled(ticket: RunTicket, adapter: RuntimeAdapter): Promise<void> {
    if (!this.owns(ticket, adapter)) return;
    this.entries.get(ticket.sessionId)!.sendSettled = true;
    await this.closeIfSettled(ticket, adapter);
  }

  private async closeIfSettled(ticket: RunTicket, adapter: RuntimeAdapter): Promise<void> {
    const entry = this.entries.get(ticket.sessionId);
    // turn/start 的响应与终态通知可能交错，收到终态且发送 Promise 已结算后才能回收。
    if (entry?.ticket !== ticket || entry.adapter !== adapter || !entry.terminal || !entry.sendSettled) return;
    this.entries.delete(ticket.sessionId);
    await adapter.close();
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    await entry.adapter.close();
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(entry => entry.adapter.close()));
  }
}

import type { RuntimeAdapter } from '../../../../packages/agent-runtime/src/manager';
import { performance } from 'node:perf_hooks';
import type { RunTicket } from './lifecycle';

export interface CodexRuntimeReusePolicy {
  enabled: boolean;
  idleTtlMs: number;
  maxIdleInstances: number;
}

const DEFAULT_CODEX_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GROK_IDLE_TTL_MS = 2 * 60 * 1000;

interface RuntimeEntry {
  ticket: RunTicket;
  adapter: RuntimeAdapter;
  terminal: boolean;
  sendSettled: boolean;
  reusable: boolean;
  reuseKey?: string;
  unsubscribe?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleExpiresAt?: number;
  idleOrder?: number;
}

function supportsIdleReuse(adapter: RuntimeAdapter): boolean {
  return adapter.kind === 'grok_build_acp' || adapter.kind === 'codex';
}

/** 运行实例同时绑定会话和本轮票据，旧实例不能覆盖或关闭后续轮次。 */
export class SessionRuntimes {
  private readonly entries = new Map<string, RuntimeEntry>();
  private idleSequence = 0;
  private readonly legacyIdleTtlMs: number;
  private readonly legacyMaxIdleInstances: number;
  private codexPolicy: CodexRuntimeReusePolicy;

  constructor(idleTtlMs?: number, maxIdleInstances = 3) {
    this.legacyIdleTtlMs = idleTtlMs ?? DEFAULT_GROK_IDLE_TTL_MS;
    this.legacyMaxIdleInstances = maxIdleInstances;
    this.codexPolicy = { enabled: true, idleTtlMs: idleTtlMs ?? DEFAULT_CODEX_IDLE_TTL_MS, maxIdleInstances };
  }

  async updateCodexPolicy(policy: CodexRuntimeReusePolicy): Promise<void> {
    if (typeof policy.enabled !== 'boolean' || !Number.isInteger(policy.idleTtlMs) || policy.idleTtlMs < 1000 || policy.idleTtlMs > 60 * 60 * 1000 || !Number.isInteger(policy.maxIdleInstances) || policy.maxIdleInstances < 1 || policy.maxIdleInstances > 10) throw new Error('Codex Runtime 复用策略无效');
    const previous = this.codexPolicy;
    this.codexPolicy = { ...policy };
    if (!policy.enabled) {
      await Promise.allSettled([...this.entries.values()].filter(entry => entry.adapter.kind === 'codex' && entry.idleExpiresAt !== undefined).map(entry => this.closeEntry(entry)));
    } else if (previous.idleTtlMs !== policy.idleTtlMs) {
      const now = performance.now();
      const codexIdle = [...this.entries.values()].filter(entry => entry.adapter.kind === 'codex' && entry.idleExpiresAt !== undefined);
      await Promise.allSettled(codexIdle.map(async entry => {
        const idleStartedAt = entry.idleExpiresAt! - previous.idleTtlMs;
        const expiresAt = idleStartedAt + policy.idleTtlMs;
        if (expiresAt <= now) { await this.closeEntry(entry); return; }
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleExpiresAt = expiresAt;
        entry.idleTimer = setTimeout(() => { void this.closeEntry(entry).catch(() => undefined); }, expiresAt - now);
        entry.idleTimer.unref();
      }));
    }
    await this.trimIdleEntries();
  }

  get(sessionId: string): RuntimeAdapter | undefined { return this.entries.get(sessionId)?.adapter; }
  hasActive(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return !!entry && entry.idleExpiresAt === undefined;
  }
  getForTicket(ticket: RunTicket): RuntimeAdapter | undefined {
    const entry = this.entries.get(ticket.sessionId);
    return entry?.ticket === ticket ? entry.adapter : undefined;
  }

  bind(ticket: RunTicket, adapter: RuntimeAdapter, reuseKey?: string): void {
    const previous = this.entries.get(ticket.sessionId);
    if (previous) this.clearEntry(previous);
    this.entries.set(ticket.sessionId, { ticket, adapter, terminal: false, sendSettled: false, reusable: false, reuseKey });
  }

  setEventSubscription(ticket: RunTicket, adapter: RuntimeAdapter, unsubscribe: () => void): void {
    const entry = this.entries.get(ticket.sessionId);
    if (entry?.ticket !== ticket || entry.adapter !== adapter || entry.idleExpiresAt !== undefined) { this.unsubscribe(unsubscribe); return; }
    this.unsubscribe(entry.unsubscribe);
    entry.unsubscribe = unsubscribe;
  }

  takeReusable(ticket: RunTicket, reuseKey: string): RuntimeAdapter | undefined {
    const entry = this.entries.get(ticket.sessionId);
    if (entry?.adapter.kind === 'codex' && !this.codexPolicy.enabled) return;
    if (!entry || ticket.cancelled || entry.ticket === ticket || entry.ticket.cancelled || !supportsIdleReuse(entry.adapter) || !entry.reusable || !entry.terminal || !entry.sendSettled || entry.reuseKey !== reuseKey || entry.idleExpiresAt === undefined) return;
    if (performance.now() >= entry.idleExpiresAt) { void this.closeEntry(entry).catch(() => undefined); return; }
    this.entries.delete(ticket.sessionId);
    this.clearEntry(entry);
    return entry.adapter;
  }

  owns(ticket: RunTicket, adapter: RuntimeAdapter): boolean {
    const entry = this.entries.get(ticket.sessionId);
    return entry?.ticket === ticket && entry.adapter === adapter;
  }

  release(ticket: RunTicket, adapter: RuntimeAdapter): void {
    const entry = this.entries.get(ticket.sessionId);
    if (entry?.ticket !== ticket || entry.adapter !== adapter) return;
    this.entries.delete(ticket.sessionId);
    this.clearEntry(entry);
  }

  async markTerminal(ticket: RunTicket, adapter: RuntimeAdapter, reusable = false): Promise<void> {
    if (!this.owns(ticket, adapter)) return;
    const entry = this.entries.get(ticket.sessionId)!;
    entry.terminal = true;
    entry.reusable = reusable && supportsIdleReuse(adapter) && !!entry.reuseKey && !ticket.cancelled && (adapter.kind !== 'codex' || this.codexPolicy.enabled);
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
    if (!entry.reusable || ticket.cancelled) { await this.closeEntry(entry); return; }
    if (entry.idleExpiresAt !== undefined) return;
    this.unsubscribe(entry.unsubscribe); entry.unsubscribe = undefined;
    const idleTtlMs = entry.adapter.kind === 'codex' ? this.codexPolicy.idleTtlMs : this.legacyIdleTtlMs;
    entry.idleExpiresAt = performance.now() + idleTtlMs;
    entry.idleOrder = ++this.idleSequence;
    entry.idleTimer = setTimeout(() => { void this.closeEntry(entry).catch(() => undefined); }, idleTtlMs);
    entry.idleTimer.unref();
    await this.trimIdleEntries();
  }

  private async trimIdleEntries(): Promise<void> {
    const idle = [...this.entries.values()].filter(item => item.idleExpiresAt !== undefined).sort((a, b) => a.idleOrder! - b.idleOrder!);
    const codexIdle = idle.filter(item => item.adapter.kind === 'codex');
    const legacyIdle = idle.filter(item => item.adapter.kind !== 'codex');
    await Promise.allSettled([
      ...codexIdle.slice(0, Math.max(0, codexIdle.length - this.codexPolicy.maxIdleInstances)),
      ...legacyIdle.slice(0, Math.max(0, legacyIdle.length - this.legacyMaxIdleInstances)),
    ].map(item => this.closeEntry(item)));
  }

  private unsubscribe(unsubscribe?: () => void): void {
    // 监听清理失败也必须继续回收进程，不能留下失去票据的 Runtime。
    try { unsubscribe?.(); } catch {}
  }

  private clearEntry(entry: RuntimeEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    this.unsubscribe(entry.unsubscribe); entry.unsubscribe = undefined;
  }

  private async closeEntry(entry: RuntimeEntry): Promise<void> {
    if (this.entries.get(entry.ticket.sessionId) !== entry) return;
    this.entries.delete(entry.ticket.sessionId);
    this.clearEntry(entry);
    await entry.adapter.close();
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await this.closeEntry(entry);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) this.clearEntry(entry);
    await Promise.allSettled(entries.map(entry => entry.adapter.close()));
  }
}

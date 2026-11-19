import { performance } from 'node:perf_hooks';
import type { RuntimeLifecycleEvent, RuntimeOptions } from '../../../../packages/agent-runtime/src';
import { createCodexRuntimeAdapter, type RuntimeAdapter } from '../../../../packages/agent-runtime/src';
import { codexRuntimeProcessKey } from './runtime-reuse';

export interface CodexPrewarmPolicy { enabled: boolean; idleTtlMs: number; maxIdleInstances: number; }
export interface CodexPrewarmSpan { stage: 'runtime.spawn' | 'runtime.initialize'; durationMs: number; }
export interface CodexPrewarmResult { adapter: RuntimeAdapter; spans: CodexPrewarmSpan[]; }
interface CodexAppServerPrewarmDependencies { createAdapter?: (options: RuntimeOptions) => RuntimeAdapter; processKey?: (options: RuntimeOptions, cwd: string) => Promise<string>; }

interface Candidate {
  adapter: RuntimeAdapter;
  promise: Promise<void>;
  spans: CodexPrewarmSpan[];
  sessionId: string;
  createdAt: number;
  readyAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  disposed: boolean;
}

/** 只持有已完成协议初始化的 Codex App Server，不创建 Thread、不发送模型请求。 */
export class CodexAppServerPrewarm {
  private readonly candidates = new Map<string, Candidate>();
  private closed = false;
  private policy: CodexPrewarmPolicy = { enabled: true, idleTtlMs: 5 * 60 * 1000, maxIdleInstances: 3 };
  private selectedSessionId?: string;
  private readonly createAdapter: (options: RuntimeOptions) => RuntimeAdapter;
  private readonly processKey: (options: RuntimeOptions, cwd: string) => Promise<string>;

  constructor(dependencies: CodexAppServerPrewarmDependencies = {}) {
    this.createAdapter = dependencies.createAdapter ?? createCodexRuntimeAdapter;
    this.processKey = dependencies.processKey ?? codexRuntimeProcessKey;
  }

  async selectSession(sessionId: string): Promise<void> {
    this.selectedSessionId = sessionId;
    const obsolete = [...this.candidates.entries()].filter(([, candidate]) => candidate.sessionId !== sessionId);
    await Promise.allSettled(obsolete.map(([key, candidate]) => this.dispose(key, candidate)));
  }

  async updatePolicy(policy: CodexPrewarmPolicy): Promise<void> {
    if (typeof policy.enabled !== 'boolean' || !Number.isInteger(policy.idleTtlMs) || policy.idleTtlMs < 1000 || policy.idleTtlMs > 60 * 60 * 1000 || !Number.isInteger(policy.maxIdleInstances) || policy.maxIdleInstances < 1 || policy.maxIdleInstances > 10) throw new Error('Codex Runtime 预热策略无效');
    this.policy = { ...policy };
    if (!policy.enabled) { await this.clear(); return; }
    await this.expireAndTrim();
    for (const [key, candidate] of this.candidates) this.scheduleExpiry(key, candidate);
  }

  async warm(options: RuntimeOptions, cwd: string, sessionId: string): Promise<void> {
    if (this.closed || !this.policy.enabled) return;
    let key: string;
    try { key = await this.processKey(options, cwd); } catch { return; }
    if (this.closed || !this.policy.enabled || this.selectedSessionId !== sessionId) return;
    const obsolete = [...this.candidates.entries()].filter(([candidateKey, candidate]) => candidateKey !== key || candidate.sessionId !== sessionId);
    await Promise.allSettled(obsolete.map(([candidateKey, candidate]) => this.dispose(candidateKey, candidate)));
    const existing = this.candidates.get(key);
    if (existing) { existing.sessionId = sessionId; return; }
    const starts = new Map<'runtime.spawn' | 'runtime.initialize', number>();
    const spans: CodexPrewarmSpan[] = [];
    const optionsWithLifecycle: RuntimeOptions = {
      ...options,
      onLifecycle: (event: RuntimeLifecycleEvent) => {
        options.onLifecycle?.(event);
        if (event === 'app_server_spawn_start') starts.set('runtime.spawn', performance.now());
        else if (event === 'app_server_spawned') this.finishSpan(starts, spans, 'runtime.spawn');
        else if (event === 'app_server_initialize_start') starts.set('runtime.initialize', performance.now());
        else if (event === 'app_server_initialized') this.finishSpan(starts, spans, 'runtime.initialize');
      },
    };
    const measuredAdapter = this.createAdapter(optionsWithLifecycle);
    const candidate: Candidate = { adapter: measuredAdapter, promise: Promise.resolve(), spans, sessionId, createdAt: performance.now(), disposed: false };
    candidate.promise = candidate.adapter.start().then(async () => {
      candidate.readyAt = performance.now();
      if (this.candidates.get(key) === candidate && !candidate.disposed) this.scheduleExpiry(key, candidate);
      void this.expireAndTrim();
    }).catch(async () => {
      if (this.candidates.get(key) === candidate) this.candidates.delete(key);
      candidate.disposed = true;
      await candidate.adapter.close().catch(() => undefined);
      throw new Error('Codex App Server 预热失败');
    });
    this.candidates.set(key, candidate);
    await this.expireAndTrim();
    try { await candidate.promise; } catch {}
  }

  async take(options: RuntimeOptions, cwd: string, sessionId: string): Promise<CodexPrewarmResult | undefined> {
    if (this.closed || !this.policy.enabled) return;
    let key: string;
    try { key = await this.processKey(options, cwd); } catch { return; }
    if (this.selectedSessionId !== sessionId) return;
    const candidate = this.candidates.get(key);
    if (!candidate || candidate.sessionId !== sessionId) return;
    try { await candidate.promise; } catch { return; }
    if (this.closed || !this.policy.enabled || candidate.disposed || this.candidates.get(key) !== candidate) return;
    if (candidate.readyAt !== undefined && performance.now() - candidate.readyAt >= this.policy.idleTtlMs) {
      await this.dispose(key, candidate);
      return;
    }
    this.candidates.delete(key);
    if (candidate.timer) clearTimeout(candidate.timer);
    candidate.timer = undefined;
    return { adapter: candidate.adapter, spans: [...candidate.spans] };
  }

  async clear(): Promise<void> {
    const candidates = [...this.candidates.entries()];
    this.candidates.clear();
    await Promise.allSettled(candidates.map(([key, candidate]) => this.dispose(key, candidate)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.clear();
  }

  private finishSpan(starts: Map<'runtime.spawn' | 'runtime.initialize', number>, spans: CodexPrewarmSpan[], stage: CodexPrewarmSpan['stage']): void {
    const started = starts.get(stage);
    if (started === undefined) return;
    spans.push({ stage, durationMs: Math.max(0, performance.now() - started) });
    starts.delete(stage);
  }

  private scheduleExpiry(key: string, candidate: Candidate): void {
    if (candidate.timer) clearTimeout(candidate.timer);
    if (candidate.readyAt === undefined || this.candidates.get(key) !== candidate || !this.policy.enabled) return;
    candidate.timer = setTimeout(() => { void this.dispose(key, candidate); }, Math.max(0, this.policy.idleTtlMs - (performance.now() - candidate.readyAt)));
    candidate.timer.unref();
  }

  private async expireAndTrim(): Promise<void> {
    const idle = [...this.candidates.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt);
    const expired = idle.filter(([, candidate]) => candidate.readyAt !== undefined && performance.now() - candidate.readyAt >= this.policy.idleTtlMs);
    const retained = idle.filter(([, candidate]) => !expired.some(([, item]) => item === candidate));
    const overflow = retained.slice(0, Math.max(0, retained.length - this.policy.maxIdleInstances));
    await Promise.allSettled([...expired, ...overflow].map(([key, candidate]) => this.dispose(key, candidate)));
  }

  private async dispose(key: string, candidate: Candidate): Promise<void> {
    if (this.candidates.get(key) === candidate) this.candidates.delete(key);
    if (candidate.disposed) return;
    candidate.disposed = true;
    if (candidate.timer) clearTimeout(candidate.timer);
    candidate.timer = undefined;
    await candidate.promise.catch(() => undefined);
    await candidate.adapter.close().catch(() => undefined);
  }
}

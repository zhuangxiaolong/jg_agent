import { execFile } from 'node:child_process';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RuntimeHealth, RuntimeKind } from '../../../../packages/domain/src';
import type { RuntimeManifest, RuntimePrewarmRequest, RuntimePrewarmResponse } from './runtime-prewarm-protocol';

const kinds: RuntimeKind[] = ['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp'];
interface Pending { worker: Worker; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Options {
  workerFile: string;
  resourcesRoot: string;
  dataRoot: string;
  grokRuntime(): { executablePath?: string; proxyUrl?: string };
  isBusy(): boolean;
  publish(health: RuntimeHealth & { kind: RuntimeKind }): void;
  initialDelayMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

/** 大文件校验、SDK 导入和本地握手均隔离在 Worker；后台与实际发送使用独立通道。 */
export class RuntimePrewarmService {
  private worker?: Worker;
  private verificationWorker?: Worker;
  private readonly pending = new Map<number, Pending>();
  private readonly workerChildren = new Map<Worker, Set<number>>();
  private readonly retirements = new Set<Promise<void>>();
  private readonly checks = new Map<string, Promise<RuntimeHealth>>();
  private readonly verifications = new Map<RuntimeKind, Promise<RuntimeManifest>>();
  private readonly health = new Map<RuntimeKind, { key: string; value: RuntimeHealth }>();
  private readonly queue: RuntimeKind[] = [];
  private nextId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private stopped = false;
  private backgroundRunning = false;
  private foreground = 0;
  private closing?: Promise<void>;

  constructor(private readonly options: Options) {}

  private configuration(kind: RuntimeKind) {
    const grok = kind === 'grok_build_acp' ? this.options.grokRuntime() : {};
    return { resourcesRoot: this.options.resourcesRoot, dataRoot: this.options.dataRoot, kind, grokExecutablePath: grok.executablePath, proxyUrl: grok.proxyUrl };
  }

  snapshot(kind: RuntimeKind): RuntimeHealth {
    const key = JSON.stringify(this.configuration(kind));
    const saved = this.health.get(kind);
    if (saved?.key === key) return saved.value;
    if (this.started && !this.stopped && !this.queue.includes(kind) && !this.checks.has(key)) {
      this.queue.push(kind); this.arm(this.options.intervalMs ?? 300);
    }
    return { kind, available: false, compatible: false, version: '', warmingUp: true, detail: '本地组件正在后台预热，可正常操作界面；发送任务时会按需校验' };
  }

  start(preferred: RuntimeKind): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.queue.push(preferred, ...kinds.filter(kind => kind !== preferred));
    this.arm(this.options.initialDelayMs ?? 1500);
  }

  private arm(delay: number): void {
    if (this.timer || this.stopped || this.backgroundRunning || !this.queue.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // 真正执行任务、创建工作区或校验时，把尚未开始的预热让给用户操作。
      if (this.options.isBusy() || this.foreground) { this.arm(this.options.intervalMs ?? 300); return; }
      const kind = this.queue.shift()!;
      this.backgroundRunning = true;
      void this.check(kind).catch(() => undefined).finally(() => { this.backgroundRunning = false; this.arm(this.options.intervalMs ?? 300); });
    }, delay);
    this.timer.unref();
  }

  /** 手动刷新与同一组件的后台预热共享进行中的检查，完成后重新发布状态。 */
  check(kind: RuntimeKind): Promise<RuntimeHealth> {
    if (this.stopped) return Promise.resolve(this.unavailable(kind, 'Runtime 后台服务已关闭'));
    const configuration = this.configuration(kind), key = JSON.stringify(configuration);
    const existing = this.checks.get(key);
    if (existing) return existing;
    const checking = this.request({ ...configuration, method: 'check' }).then(result => result as RuntimeHealth).catch(() => this.unavailable(kind, 'Runtime 后台预检失败或超时，请刷新组件状态后重试')).then(value => {
      if (!this.stopped && key === JSON.stringify(this.configuration(kind))) {
        this.health.set(kind, { key, value });
        try { this.options.publish({ ...value, kind }); } catch { /* 窗口关闭不能中断后台资源回收。 */ }
      }
      return value;
    }).finally(() => { if (this.checks.get(key) === checking) this.checks.delete(key); });
    this.checks.set(key, checking);
    return checking;
  }

  /** 真实任务仍逐轮全量验证，不把启动时的健康快照当作资源完整性证明。 */
  verify(kind: RuntimeKind): Promise<RuntimeManifest> {
    const existing = this.verifications.get(kind);
    if (existing) return existing;
    this.foreground += 1;
    const verifying = this.request({ ...this.configuration(kind), method: 'verify' }, true).then(result => result as RuntimeManifest).finally(() => {
      this.foreground -= 1;
      if (this.verifications.get(kind) === verifying) this.verifications.delete(kind);
    });
    this.verifications.set(kind, verifying);
    return verifying;
  }

  private unavailable(kind: RuntimeKind, detail: string): RuntimeHealth { return { kind, available: false, compatible: false, version: '', detail }; }

  private getWorker(verification: boolean): Worker {
    const existing = verification ? this.verificationWorker : this.worker;
    if (existing) return existing;
    const worker = new Worker(this.options.workerFile, { resourceLimits: { maxOldGenerationSizeMb: 192 } });
    if (verification) this.verificationWorker = worker; else this.worker = worker;
    const children = new Set<number>();
    this.workerChildren.set(worker, children);
    worker.on('message', (message: RuntimePrewarmResponse) => {
      if ('type' in message) {
        if (this.workerChildren.has(worker) && Number.isSafeInteger(message.pid) && message.pid > 0 && message.pid !== process.pid) {
          if (message.active) children.add(message.pid); else children.delete(message.pid);
        }
        return;
      }
      const item = this.pending.get(message.id);
      if (!item || item.worker !== worker) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if ('error' in message) item.reject(new Error(message.error)); else item.resolve(message.result);
    });
    worker.on('error', () => { void this.failWorker(worker); });
    worker.on('exit', () => { void this.failWorker(worker); });
    return worker;
  }

  private request(input: Omit<Extract<RuntimePrewarmRequest, { method: 'check' | 'verify' }>, 'id'> | { method: 'close' }, verification = false): Promise<unknown> {
    if (this.stopped && input.method !== 'close') return Promise.reject(new Error('Runtime 后台服务已关闭'));
    let worker: Worker;
    try { worker = this.getWorker(verification); } catch { return Promise.reject(new Error('无法启动 Runtime 后台服务')); }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.failWorker(worker); }, input.method === 'close' ? 12000 : this.options.requestTimeoutMs ?? 60000);
      timer.unref();
      this.pending.set(id, { worker, resolve, reject, timer });
      try { worker.postMessage({ ...input, id }); }
      catch { void this.failWorker(worker); }
    });
  }

  private failWorker(worker: Worker): Promise<void> {
    if (this.worker !== worker && this.verificationWorker !== worker) return Promise.resolve();
    if (this.worker === worker) this.worker = undefined;
    if (this.verificationWorker === worker) this.verificationWorker = undefined;
    for (const [id, item] of this.pending) if (item.worker === worker) {
      clearTimeout(item.timer); item.reject(new Error('Runtime 后台服务中断或超时')); this.pending.delete(id);
    }
    const retiring = (async () => {
      // 先停止线程继续启动新进程，再回收线程实际报告的子进程。
      await worker.terminate().catch(() => undefined);
      const children = [...this.workerChildren.get(worker) ?? []]; this.workerChildren.delete(worker);
      await Promise.allSettled(children.map(pid => new Promise<void>(resolve => {
        if (process.platform === 'win32') execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
        else { try { process.kill(pid, 'SIGKILL'); } catch {} resolve(); }
      })));
    })();
    this.retirements.add(retiring);
    void retiring.finally(() => this.retirements.delete(retiring));
    return retiring;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.queue.length = 0;
    this.closing = (async () => {
      await Promise.allSettled([false, true].map(async verification => {
        const worker = verification ? this.verificationWorker : this.worker;
        if (!worker) return;
        try { await this.request({ method: 'close' }, verification); } catch {}
        await this.failWorker(worker);
      }));
      await Promise.allSettled([...this.retirements]);
    })();
    return this.closing;
  }
}

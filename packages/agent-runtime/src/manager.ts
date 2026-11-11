import type { RuntimeHealth, RuntimeKind } from '../../domain/src/index';
import { CODEX_RUNTIME_VERSION, RUNTIME_CAPABILITIES_VERSION, CodexRuntime, type RuntimeEvent, type RuntimeOptions } from './index';
import { CLAUDE_AGENT_SDK_RUNTIME_VERSION } from './claude-adapter';

export const JINGGONG_RUNTIME_VERSION = '0.1.0';
export const JINGGONG_RUNTIME_USER_AGENT_PREFIX = 'jinggong_runtime/';

/** 桌面端统一依赖的 Runtime 最小协议；具体实现不得在这里互相回退。 */
export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly version: string;
  readonly capabilitiesVersion: number;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  checkRuntime(): Promise<RuntimeHealth>;
  start(): Promise<void>;
  startSession(cwd: string): Promise<string>;
  resumeSession(threadId: string, cwd: string, nativeSessionId?: string): Promise<string>;
  sendTurn(threadId: string, prompt: string, cwd: string, imagePaths?: string[]): Promise<void>;
  cancelRun(threadId: string): Promise<void>;
  close(): Promise<void>;
}

export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'codex' as const;
  readonly version = CODEX_RUNTIME_VERSION;
  readonly capabilitiesVersion = RUNTIME_CAPABILITIES_VERSION;
  constructor(readonly runtime: CodexRuntime) {}
  onEvent(listener: (event: RuntimeEvent) => void): () => void { return this.runtime.onEvent(listener); }
  async checkRuntime(): Promise<RuntimeHealth> { return { ...(await this.runtime.checkRuntime()), kind: this.kind, capabilitiesVersion: this.capabilitiesVersion }; }
  start(): Promise<void> { return this.runtime.start(); }
  startSession(cwd: string): Promise<string> { return this.runtime.startSession(cwd); }
  resumeSession(threadId: string, cwd: string, _nativeSessionId?: string): Promise<string> { return this.runtime.resumeSession(threadId, cwd); }
  sendTurn(threadId: string, prompt: string, cwd: string, imagePaths: string[] = []): Promise<void> { return this.runtime.sendTurn(threadId, prompt, cwd, imagePaths); }
  cancelRun(threadId: string): Promise<void> { return this.runtime.cancelRun(threadId); }
  close(): Promise<void> { return this.runtime.close(); }
}

export function createCodexRuntimeAdapter(options: RuntimeOptions): RuntimeAdapter {
  return new CodexRuntimeAdapter(new CodexRuntime(options));
}

export class JinggongRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'jinggong' as const;
  readonly version = JINGGONG_RUNTIME_VERSION;
  readonly capabilitiesVersion = RUNTIME_CAPABILITIES_VERSION;
  constructor(readonly runtime: CodexRuntime) {}
  onEvent(listener: (event: RuntimeEvent) => void): () => void { return this.runtime.onEvent(listener); }
  async checkRuntime(): Promise<RuntimeHealth> { return { ...(await this.runtime.checkRuntime()), kind: this.kind, capabilitiesVersion: this.capabilitiesVersion }; }
  start(): Promise<void> { return this.runtime.start(); }
  startSession(cwd: string): Promise<string> { return this.runtime.startSession(cwd); }
  resumeSession(threadId: string, cwd: string, _nativeSessionId?: string): Promise<string> { return this.runtime.resumeSession(threadId, cwd); }
  sendTurn(threadId: string, prompt: string, cwd: string, imagePaths: string[] = []): Promise<void> { return this.runtime.sendTurn(threadId, prompt, cwd, imagePaths); }
  cancelRun(threadId: string): Promise<void> { return this.runtime.cancelRun(threadId); }
  close(): Promise<void> { return this.runtime.close(); }
}

/** 未配置资源时的显式不可用适配器，禁止把缺失 Jinggong 静默解释成 Codex。 */
class UnavailableRuntimeAdapter implements RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly version: string;
  readonly capabilitiesVersion = RUNTIME_CAPABILITIES_VERSION;
  constructor(kind: RuntimeKind, version: string, private readonly message: string) {
    this.kind = kind;
    this.version = version;
  }
  onEvent(): () => void { return () => undefined; }
  async checkRuntime(): Promise<RuntimeHealth> {
    return { kind: this.kind, available: false, compatible: false, version: '', capabilitiesVersion: this.capabilitiesVersion, detail: this.message };
  }
  async start(): Promise<void> { throw new Error(this.message); }
  async startSession(): Promise<string> { await this.start(); throw new Error(this.message); }
  async resumeSession(): Promise<string> { await this.start(); throw new Error(this.message); }
  async sendTurn(): Promise<void> { await this.start(); }
  async cancelRun(): Promise<void> { return undefined; }
  async close(): Promise<void> { return undefined; }
}

export function createJinggongRuntimeAdapter(options: RuntimeOptions): RuntimeAdapter {
  return new JinggongRuntimeAdapter(new CodexRuntime({ ...options, runtimeVersion: JINGGONG_RUNTIME_VERSION, runtimeDisplayName: 'Jinggong Runtime', expectedUserAgentPrefix: JINGGONG_RUNTIME_USER_AGENT_PREFIX }));
}

export type RuntimeAdapterFactory = () => RuntimeAdapter;

export interface RuntimeManagerOptions {
  codex?: RuntimeAdapter | RuntimeAdapterFactory;
  jinggong?: RuntimeAdapter | RuntimeAdapterFactory;
  claude_agent_sdk?: RuntimeAdapter | RuntimeAdapterFactory;
}

function resolveAdapter(value: RuntimeAdapter | RuntimeAdapterFactory | undefined): RuntimeAdapter | undefined {
  return typeof value === 'function' ? value() : value;
}

/** Runtime 选择器。kind 缺失或未知时直接报错，禁止静默切换到另一 Runtime。 */
export class RuntimeManager {
  private readonly adapters: Partial<Record<RuntimeKind, RuntimeAdapter | RuntimeAdapterFactory>>;
  constructor(options: RuntimeManagerOptions = {}) {
    this.adapters = { ...options };
  }
  get(kind: RuntimeKind): RuntimeAdapter {
    if (kind !== 'jinggong' && kind !== 'codex' && kind !== 'claude_agent_sdk') throw new Error(`不支持的 Runtime 类型：${String(kind)}`);
    const configured = resolveAdapter(this.adapters[kind]);
    if (configured) return configured;
    if (kind === 'jinggong') return new UnavailableRuntimeAdapter(kind, JINGGONG_RUNTIME_VERSION, 'Jinggong Runtime 尚未就绪，请先执行构建并随安装包部署独立 jinggong-runtime.exe');
    if (kind === 'claude_agent_sdk') return new UnavailableRuntimeAdapter(kind, CLAUDE_AGENT_SDK_RUNTIME_VERSION, 'Claude Agent SDK Runtime 尚未配置 SDK/Binary，请在应用安装包中部署组件');
    throw new Error('Codex Runtime 尚未配置');
  }
  async checkRuntime(kind: RuntimeKind): Promise<RuntimeHealth> { return this.get(kind).checkRuntime(); }
}

export function createRuntimeManager(options: RuntimeManagerOptions = {}): RuntimeManager { return new RuntimeManager(options); }


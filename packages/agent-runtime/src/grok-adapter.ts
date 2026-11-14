import { execFile, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeHealth } from '../../domain/src/index';
import type { RuntimeAdapter } from './manager';
import { RUNTIME_CAPABILITIES_VERSION, redactRuntimeText, type RuntimeEvent } from './index';
import { GROK_BUILD_RUNTIME_VERSION, GROK_CREDENTIAL_ENV, GROK_EXECUTION_RULES_VERSION, GROK_MANAGED_POLICY, GROK_RELAY_MODEL_ALIAS, buildGrokEnvironment, ensureGrokDirectory, grokBaseUrl, grokConfigToml, grokExecutionInstructions, samePath, validateGrokOptions, withinPath, type GrokRuntimeOptions } from './grok-config';

export { GROK_BUILD_RUNTIME_VERSION, buildGrokEnvironment, grokConfigToml } from './grok-config';
export type { GrokRuntimeOptions } from './grok-config';

type RpcId = string | number;
type JsonObject = Record<string, any>;
interface Pending { resolve(value: JsonObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Binding { sessionId: string; cwd: string; fingerprint: string }
interface Turn { sessionId: string; cancelled: boolean; tools: Map<string, { name: string; stage: 'tool' | 'read' | 'command'; completed: boolean }>; cancelTimer?: ReturnType<typeof setTimeout> }

/** 仅供正式协议测试替换进程入口；生产工厂不开放任意环境或命令参数。 */
export interface GrokProcessFactory {
  version(executable: string, environment: NodeJS.ProcessEnv): Promise<string>;
  launch(executable: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  rpcTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelTimeoutMs?: number;
}

const systemProcesses: GrokProcessFactory = {
  version: (executable, env) => new Promise((resolve, reject) => execFile(executable, ['--version'], { env, windowsHide: true, timeout: 10000, maxBuffer: 8192 }, (error, stdout) => error ? reject(error) : resolve(stdout))),
  launch: (executable, args, options) => spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }),
};
const MAX_LINE = 4 * 1024 * 1024;
function record(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validId(value: unknown): value is RpcId { return (typeof value === 'string' && value.length > 0 && value.length <= 256) || (typeof value === 'number' && Number.isSafeInteger(value)); }
function validSession(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value); }
function errorCodeSuffix(error: unknown): string { const code = (error as NodeJS.ErrnoException | undefined)?.code; return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? `（${code}）` : ''; }
function launchErrorMessage(error: unknown, asynchronous: boolean, executable?: string, home?: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    if (executable && !existsSync(executable)) return 'Grok 可执行文件不存在，检查 Runtime 路径';
    if (home && !existsSync(home)) return 'Grok 工作目录不存在，检查 Runtime 目录';
    return 'Grok 可执行文件或工作目录不存在，检查 Runtime 路径/目录';
  }
  return `${asynchronous ? 'Grok ACP 子进程启动或管道失败' : '无法启动 Grok ACP 子进程'}${errorCodeSuffix(error)}`;
}

/** 仅配置、工作区与组件身份完全相同时复用；凭据只参与内存摘要，不落盘。 */
export async function grokRuntimeReuseKey(options: GrokRuntimeOptions, cwd: string): Promise<string> {
  validateGrokOptions(options);
  const info = await lstat(options.executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Grok 可执行文件必须是普通文件，不允许链接');
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return createHash('sha256').update(JSON.stringify([
    normalized(options.executable), info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs,
    normalized(options.home), normalized(cwd), grokBaseUrl(options.baseUrl), options.model,
    options.apiBackend, options.apiKey, options.proxyUrl, options.reasoningEffort, options.developerInstructions,
  ])).digest('hex');
}

/** 固定版本 ACP 适配器：每实例绑定一个受管 home 和工作区，不提供原生工具沙箱保证。 */
export class GrokBuildRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'grok_build_acp' as const;
  readonly version = GROK_BUILD_RUNTIME_VERSION;
  readonly capabilitiesVersion = RUNTIME_CAPABILITIES_VERSION;
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<RpcId, Pending>();
  private readonly serverRequests = new Set<string>();
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private initialized = false;
  private closed = false;
  private nextId = 1;
  private buffer = '';
  private binding?: Binding;
  private turn?: Turn;
  private loadSession = false;
  private readonly fingerprint: string;
  private readonly options: GrokRuntimeOptions;

  constructor(options: GrokRuntimeOptions, private readonly processes: GrokProcessFactory = systemProcesses) {
    validateGrokOptions(options);
    this.options = { ...options };
    this.fingerprint = createHash('sha256').update(JSON.stringify([grokBaseUrl(options.baseUrl), options.model, options.apiBackend, this.version])).digest('hex');
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void { this.emitter.on('event', listener); return () => this.emitter.off('event', listener); }
  private clean(value: string, max = 32000): string { return redactRuntimeText(value, this.options.apiKey, max); }
  private emit(event: RuntimeEvent): void { this.emitter.emit('event', { ...event, text: this.clean(event.text) }); }

  async checkRuntime(): Promise<RuntimeHealth> {
    const base = { kind: this.kind, capabilitiesVersion: this.capabilitiesVersion, sandbox: 'unverified' as const };
    try {
      const info = await lstat(this.options.executable);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Grok 可执行文件必须是普通文件，不允许链接');
      const environment = buildGrokEnvironment(this.options); delete environment[GROK_CREDENTIAL_ENV];
      const raw = await this.processes.version(this.options.executable, environment);
      const version = /^grok\s+(\d+\.\d+\.\d+)(?:\s|$)/m.exec(raw)?.[1] ?? '';
      return { ...base, available: true, version, compatible: version === this.version, detail: version === this.version ? `Grok Build ${version} 本机组件就绪；Agent 兼容性须按中转站/模型/backend 实测。多仓库、插件和受控子 Agent 暂不支持；Windows OS 沙箱未验证。` : `Grok Build 版本不兼容，要求 ${this.version}，实际 ${version || '无法识别'}` };
    } catch (error) { return { ...base, available: false, version: '', compatible: false, detail: this.clean(`Grok Build 不可用：${(error as Error).message}`) }; }
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Grok Runtime 已关闭');
    if (this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private async initialize(): Promise<void> {
    const health = await this.checkRuntime();
    if (!health.available || !health.compatible) throw new Error(health.detail);
    await this.prepareHome();
    if (this.closed) throw new Error('Grok Runtime 已关闭');
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.processes.launch(this.options.executable, ['agent', '--no-leader', '--always-approve', '--model', GROK_RELAY_MODEL_ALIAS, 'stdio'], { cwd: this.options.home, env: buildGrokEnvironment(this.options), windowsHide: true });
    } catch (error) {
      throw new Error(this.clean(launchErrorMessage(error, false, this.options.executable, this.options.home)));
    }
    this.child = child; this.buffer = ''; this.serverRequests.clear();
    child.stdout.on('error', error => { if (this.child === child) void this.fail(new Error(`Grok ACP 输出管道已断开${errorCodeSuffix(error)}`)); });
    child.stderr.on('error', error => { if (this.child === child) void this.fail(new Error(`Grok ACP 错误输出管道已断开${errorCodeSuffix(error)}`)); });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (this.child === child) this.receive(chunk); });
    // stderr 不落盘、不转发正文，避免 SDK 的隐藏推理、会话快照或凭据进入平台日志。
    child.stderr.on('data', () => undefined);
    child.on('error', error => { if (this.child === child) void this.fail(new Error(this.clean(launchErrorMessage(error, true, this.options.executable, this.options.home)))); });
    child.stdin.on('error', error => { if (this.child === child) void this.fail(new Error(`Grok ACP 输入管道已断开${errorCodeSuffix(error)}`)); });
    child.on('exit', (code, signal) => { if (this.child === child) void this.fail(new Error(`Grok ACP 进程已退出（${code ?? signal ?? '未知'}）`)); });
    try {
      const result = await this.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'jinggong-agent', version: '0.6.9' } });
      if (result.protocolVersion !== 1) throw new Error('Grok ACP 协议版本不兼容');
      this.loadSession = result.agentCapabilities?.loadSession === true;
      this.initialized = true;
    } catch (error) { await this.fail(error as Error); throw new Error(this.clean((error as Error).message)); }
  }

  private async prepareHome(): Promise<void> {
    this.options.home = await ensureGrokDirectory(this.options.home);
    const marker = path.join(this.options.home, 'jinggong-profile.json');
    const existing = await this.readJson(marker);
    if (existing) {
      if (existing.fingerprint !== this.fingerprint || existing.owner !== 'jinggong-grok') throw new Error('Grok 受管配置不属于当前中转站/模型，拒绝复用');
    } else {
      const names = await readdir(this.options.home);
      if (names.some(name => name !== 'context')) throw new Error('Grok 配置目录已有非受管内容，不会覆盖用户配置');
    }
    await ensureGrokDirectory(path.join(this.options.home, 'profile'));
    await this.writeManaged('jinggong-profile.json', JSON.stringify({ owner: 'jinggong-grok', fingerprint: this.fingerprint, version: this.version, executionRulesVersion: GROK_EXECUTION_RULES_VERSION }));
    await this.writeManaged('config.toml', grokConfigToml(this.options));
    await this.writeManaged('managed_config.toml', GROK_MANAGED_POLICY);
  }

  private async writeManaged(filename: string, content: string): Promise<void> {
    if (this.options.apiKey && content.includes(this.options.apiKey)) throw new Error('Grok 配置包含模型凭据，已拒绝写入');
    const target = path.join(this.options.home, filename);
    try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error('Grok 配置文件不允许链接'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async readJson(filename: string): Promise<JsonObject | undefined> {
    try { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 65536) throw new Error('Grok 会话绑定文件不安全'); const value = JSON.parse(await readFile(filename, 'utf8')); if (!record(value)) throw new Error('Grok 会话绑定文件格式无效'); return value; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  private async cwd(value: string): Promise<string> {
    if (!path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('Grok 工作区必须是有效绝对路径');
    const info = await lstat(value); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Grok 工作区必须是普通目录');
    const normalized = await realpath(value);
    if (withinPath(normalized, this.options.home) || withinPath(this.options.home, normalized)) throw new Error('Grok 工作区与受管配置目录必须分离');
    return normalized;
  }

  private sessionParams(cwd: string): JsonObject { return { cwd, mcpServers: [], _meta: { rules: grokExecutionInstructions(this.options.developerInstructions) } }; }

  private async configureReasoning(sessionId: string): Promise<void> {
    if (this.options.reasoningEffort === undefined) return;
    // session/load 会恢复旧档位；必须用 ACP 覆盖并读回确认，不能仅传启动参数。
    const result = await this.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: this.options.reasoningEffort });
    const option = Array.isArray(result.configOptions) ? result.configOptions.find(item => item?.id === 'reasoning_effort') : undefined;
    if (option?.currentValue !== this.options.reasoningEffort) throw new Error('Grok Runtime 未应用所选推理强度；不会自动降档或发送任务，请检查模型兼容性');
  }

  async startSession(cwd: string): Promise<string> {
    await this.start();
    if (this.binding || await this.readJson(path.join(this.options.home, 'jinggong-session.json'))) throw new Error('当前 Grok 配置目录已绑定会话，请恢复原会话或使用新目录');
    const normalized = await this.cwd(cwd);
    const result = await this.request('session/new', this.sessionParams(normalized));
    if (!validSession(result.sessionId)) { await this.fail(new Error('Grok ACP 未返回有效 Session ID')); throw new Error('Grok ACP 未返回有效 Session ID'); }
    const selected = result.models?.currentModelId;
    if (selected && selected !== GROK_RELAY_MODEL_ALIAS && selected !== this.options.model) { await this.fail(new Error('Grok ACP 选择了非当前配置模型')); throw new Error('Grok ACP 选择了非当前配置模型'); }
    await this.configureReasoning(result.sessionId);
    this.binding = { sessionId: result.sessionId, cwd: normalized, fingerprint: this.fingerprint };
    await this.writeManaged('jinggong-session.json', JSON.stringify(this.binding));
    return result.sessionId;
  }

  async resumeSession(threadId: string, cwd: string, nativeSessionId?: string): Promise<string> {
    if (nativeSessionId && nativeSessionId !== threadId) throw new Error('Grok 原生 Session 绑定不一致，不会跨 Runtime 恢复');
    if (!validSession(threadId)) throw new Error('Grok Session ID 格式无效');
    await this.start();
    if (this.turn) throw new Error('Grok 当前会话仍在运行');
    const normalized = await this.cwd(cwd);
    const saved = await this.readJson(path.join(this.options.home, 'jinggong-session.json'));
    if (!saved || saved.sessionId !== threadId || saved.fingerprint !== this.fingerprint || typeof saved.cwd !== 'string' || !samePath(saved.cwd, normalized)) throw new Error('Grok 会话不属于当前配置或工作区，拒绝恢复');
    // 同一已就绪进程已持有完整会话，不重复加载历史或覆盖已确认的推理档位。
    if (this.binding?.sessionId === threadId && samePath(this.binding.cwd, normalized)) return threadId;
    if (!this.loadSession) throw new Error('当前 Grok ACP 未声明 session/load 支持，请新建会话');
    await this.request('session/load', { ...this.sessionParams(normalized), sessionId: threadId });
    await this.configureReasoning(threadId);
    this.binding = { sessionId: threadId, cwd: normalized, fingerprint: this.fingerprint };
    return threadId;
  }

  async sendTurn(threadId: string, prompt: string, cwd: string, imagePaths: string[] = []): Promise<void> {
    if (!this.options.apiKey) throw new Error('Grok 中转站尚未配置 API Key');
    if (!prompt.trim() || prompt.length > 100000) throw new Error('Grok 任务内容为空或超过 100000 字符');
    if (prompt.includes(this.options.apiKey)) throw new Error('任务内容包含已配置 Grok 凭据，已拒绝发送');
    if (imagePaths.length) throw new Error('Grok Runtime 当前尚不支持图片输入');
    if (!this.initialized || !this.binding || this.binding.sessionId !== threadId || !samePath(await this.cwd(cwd), this.binding.cwd)) throw new Error('Grok 会话或工作区尚未正确绑定');
    if (this.turn) throw new Error('当前 Grok 会话已有运行中的任务');
    // 上轮权限请求已结算，原生进程可以在新轮复用请求 ID；仍拒绝本轮重复请求。
    this.serverRequests.clear();
    const turn: Turn = { sessionId: threadId, cancelled: false, tools: new Map() }; this.turn = turn;
    this.emit({ threadId, type: 'status', text: 'running' });
    try {
      const result = await this.request('session/prompt', { sessionId: threadId, prompt: [{ type: 'text', text: prompt }] }, this.processes.promptTimeoutMs ?? 24 * 60 * 60 * 1000);
      if (!['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'].includes(result.stopReason)) throw new Error('Grok ACP 未返回有效任务终态');
      if (turn.cancelled || result.stopReason === 'cancelled') this.emit({ threadId, type: 'status', text: 'interrupted' });
      else if (result.stopReason !== 'end_turn') throw new Error(`Grok 任务未完整完成：${result.stopReason}`);
      else this.emit({ threadId, type: 'status', text: 'completed' });
    } catch (error) {
      if (turn.cancelled) this.emit({ threadId, type: 'status', text: 'interrupted' });
      else { const failure = new Error(this.clean((error as Error).message)); this.emit({ threadId, type: 'error', text: failure.message }); throw failure; }
    } finally {
      if (turn.cancelTimer) clearTimeout(turn.cancelTimer);
      if (this.turn === turn) this.turn = undefined;
    }
  }

  async cancelRun(threadId: string): Promise<void> {
    const turn = this.turn; if (!turn || turn.sessionId !== threadId) return;
    if (!turn.cancelled) { turn.cancelled = true; this.notify('session/cancel', { sessionId: threadId }); }
    turn.cancelTimer ??= setTimeout(() => { if (this.turn === turn) void this.fail(new Error('Grok 取消未返回终态，已回收进程')); }, this.processes.cancelTimeoutMs ?? 5000);
  }

  async respondApproval(_requestId: string, _decision: 'allow_once' | 'reject_once'): Promise<void> {
    throw new Error('Grok 全权限模式无需逐次审批，旧审批请求已失效');
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE && !this.buffer.includes('\n')) { void this.fail(new Error('Grok ACP 单行超过 4 MiB')); return; }
    let split: number;
    while ((split = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, split); this.buffer = this.buffer.slice(split + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE) { void this.fail(new Error('Grok ACP 单行超过 4 MiB')); return; }
      let message: JsonObject; try { message = JSON.parse(line); if (!record(message) || message.jsonrpc !== '2.0') throw new Error(); } catch { void this.fail(new Error('Grok ACP 返回损坏的 JSON-RPC 数据')); return; }
      if (validId(message.id) && !message.method) {
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(this.clean(`Grok ACP 错误：${typeof message.error.message === 'string' ? message.error.message : '未知错误'}`)));
        else if (record(message.result)) pending.resolve(message.result);
        else pending.reject(new Error('Grok ACP 响应格式无效'));
      } else if (typeof message.method === 'string') {
        if (validId(message.id)) void this.serverRequest(message).catch(() => { void this.fail(new Error('Grok ACP 权限请求处理失败')); });
        else if (message.method === 'session/update') this.update(message.params);
      }
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE) void this.fail(new Error('Grok ACP 单行超过 4 MiB'));
  }

  private update(params: unknown): void {
    const turn = this.turn; if (!turn || turn.cancelled || !record(params) || params.sessionId !== turn.sessionId || !record(params.update)) return;
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') this.emit({ threadId: turn.sessionId, type: 'delta', text: update.content.text });
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return;
    if (!validSession(update.toolCallId)) return;
    const previous = turn.tools.get(update.toolCallId);
    const name = typeof update.title === 'string' ? this.clean(update.title, 256) : previous?.name ?? 'Grok 工具';
    const stage = update.kind === 'execute' ? 'command' as const : update.kind === 'read' ? 'read' as const : previous?.stage ?? 'tool' as const;
    const terminal = ['completed', 'failed'].includes(update.status);
    if (!previous) { turn.tools.set(update.toolCallId, { name, stage, completed: terminal }); this.emit({ threadId: turn.sessionId, type: 'tool', text: name, performance: { callId: update.toolCallId, phase: 'started', operation: name, stage } }); }
    if (terminal && !previous?.completed) { turn.tools.set(update.toolCallId, { name, stage, completed: true }); this.emit({ threadId: turn.sessionId, type: 'tool', text: `${name}：${update.status === 'failed' ? '失败' : '完成'}`, performance: { callId: update.toolCallId, phase: 'completed', operation: name, stage, exitCode: update.status === 'failed' ? 1 : 0 } }); }
  }

  private async serverRequest(message: JsonObject): Promise<void> {
    const rpcId = message.id as RpcId;
    const duplicate = `${typeof rpcId}:${rpcId}`;
    if (this.serverRequests.has(duplicate) || this.serverRequests.size > 4096) { await this.fail(new Error('Grok ACP 重复或过量服务端请求')); return; }
    this.serverRequests.add(duplicate);
    if (message.method !== 'session/request_permission') { this.write({ jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: '当前精工 Grok 客户端未实现此能力' } }); if (this.turn) await this.cancelRun(this.turn.sessionId); return; }
    const turn = this.turn; const params = message.params;
    const deny = async () => { this.write({ jsonrpc: '2.0', id: rpcId, result: { outcome: { outcome: 'cancelled' } } }, true); if (turn) await this.cancelRun(turn.sessionId); };
    if (!turn || turn.cancelled || !record(params) || params.sessionId !== turn.sessionId || !record(params.toolCall) || !Array.isArray(params.options) || params.options.length > 16) return deny();
    const allow = params.options.find((item: unknown) => record(item) && item.kind === 'allow_always') ?? params.options.find((item: unknown) => record(item) && item.kind === 'allow_once');
    if (!validSession(allow?.optionId)) return deny();
    // 用户已选择全权限，原生工具统一自动授权，不再限制工具名或工作区内外路径。
    this.write({ jsonrpc: '2.0', id: rpcId, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
  }

  private request(method: string, params: JsonObject, timeoutMs = this.processes.rpcTimeoutMs ?? 30000): Promise<JsonObject> {
    if (!this.child || this.closed) return Promise.reject(new Error('Grok ACP 进程未运行'));
    if (this.pending.size >= 64) return Promise.reject(new Error('Grok ACP 在途请求超过限制'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); const error = new Error(`Grok ACP ${method} 超时，已回收进程`); reject(error); void this.fail(error); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private notify(method: string, params: JsonObject): void { this.write({ jsonrpc: '2.0', method, params }, true); }
  private write(message: JsonObject, bestEffort = false): void {
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE) throw new Error('Grok ACP 请求超过 4 MiB');
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) { if (bestEffort) return; throw new Error('Grok ACP 输入管道不可用'); }
    if (this.child.stdin.writableLength > MAX_LINE) { void this.fail(new Error('Grok ACP 写入队列超过限制')); return; }
    this.child.stdin.write(line);
  }

  private async fail(error: Error): Promise<void> {
    const child = this.child; this.child = undefined; this.initialized = false; this.binding = undefined;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(this.clean(error.message))); } this.pending.clear();
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid) {
        await new Promise<void>(resolve => execFile(path.join(process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => resolve()));
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        const timeout = setTimeout(resolve, 2000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    await new Promise<void>(resolve => setImmediate(resolve));
  }

  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    if (this.turn) { this.turn.cancelled = true; if (this.turn.cancelTimer) clearTimeout(this.turn.cancelTimer); }
    await this.fail(new Error('Grok Runtime 已关闭')); this.binding = undefined;
  }
}

export function createGrokBuildRuntimeAdapter(options: GrokRuntimeOptions): GrokBuildRuntimeAdapter { return new GrokBuildRuntimeAdapter(options); }

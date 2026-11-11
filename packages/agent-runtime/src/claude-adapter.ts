import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { RuntimeHealth, RuntimeKind } from '../../domain/src/index';
import type { RuntimeAdapter } from './manager';
import type { RuntimeApprovalDecision, RuntimeEvent } from './index';

/** 当前 PoC 锁定的官方 SDK 版本。正式打包时必须与 native binary 一起锁定。 */
export const CLAUDE_AGENT_SDK_RUNTIME_VERSION = '0.3.319';
export const CLAUDE_AGENT_SDK_RUNTIME_KIND = 'claude_agent_sdk' as RuntimeKind;
// 只读分析允许通过 Claude 内置网页工具查询公开信息，但仍禁止命令执行和文件修改。
const CLAUDE_READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
export function isClaudeReadOnlyTool(toolName: string): boolean { return CLAUDE_READ_ONLY_TOOLS.has(toolName); }

/** 只读会话禁止交互式浏览器与登录态操作，但可以查询公开网页。 */
export function claudeReadOnlyNetworkInstruction(): string {
  return '\n当前会话处于只读准入状态，禁止调用交互式 browser_action 或依赖登录态的浏览器操作；可以使用 Claude 内置 WebSearch 和 WebFetch 查询公开网页信息。';
}

export interface ClaudePermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  title?: string;
  description?: string;
  blockedPath?: string;
  decisionReason?: string;
}

export interface ClaudeSdkQueryOptions {
  cwd: string;
  additionalDirectories?: string[];
  model: string;
  abortController: AbortController;
  settingSources: [];
  permissionMode: 'default';
  includePartialMessages: true;
  tools?: string[];
  appendSystemPrompt?: string;
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string | undefined>;
  canUseTool?: (toolName: string, input: Record<string, unknown>, options: ClaudePermissionRequest) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;
  resume?: string;
}

export interface ClaudeSdkQueryHandle extends AsyncIterable<unknown> {
  close?: () => void;
}

export interface ClaudeSdkModule {
  query(params: { prompt: string; options: ClaudeSdkQueryOptions }): ClaudeSdkQueryHandle;
}

export type ClaudeSdkLoader = () => Promise<ClaudeSdkModule>;

export interface ClaudeRuntimeOptions {
  model: string;
  apiKey?: string;
  /** 当前会话选择的通用中转站 URL，用于实际模型调用。 */
  relayBaseUrl?: string;
  executablePath: string;
  /** 需求准入未通过时启用，限制 Claude 只能进行只读分析。 */
  readOnly?: boolean;
  /** 仅传递平台必须的安全/联网提示，避免把未筛选业务资料当成系统指令。 */
  additionalSystemPrompt?: string;
  additionalDirectories?: string[];
  sdkLoader?: ClaudeSdkLoader;
  env?: Record<string, string | undefined>;
  onApprovalRequest?: (request: ClaudePermissionRequest & { threadId: string }) => Promise<RuntimeApprovalDecision>;
  onNativeSessionId?: (platformSessionId: string, nativeSessionId: string) => void;
}

interface ClaudeSession {
  id: string;
  cwd: string;
  nativeSessionId?: string;
  controller?: AbortController;
  query?: ClaudeSdkQueryHandle;
}

/**
 * 延迟加载官方 SDK，避免桌面应用未选择 Claude Runtime 时加载或启动其 native binary。
 * 不存在 CLI fallback；缺少 SDK 时调用方会收到明确的不可用状态。
 */
export const loadOfficialClaudeAgentSdk: ClaudeSdkLoader = async () => {
  const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<ClaudeSdkModule & { default?: ClaudeSdkModule }>;
  const loaded = await importer('@anthropic-ai/claude-agent-sdk');
  const query = (loaded as { query?: unknown }).query;
  return typeof query === 'function' ? loaded : (loaded.default as ClaudeSdkModule);
};

export function buildClaudeEnvironment(apiKey?: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const allow = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|LC_CTYPE|TERM|TZ)$/i;
  const environment: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) if (allow.test(key) && value !== undefined) environment[key] = value;
  Object.assign(environment, overrides);
  if (apiKey) environment.ANTHROPIC_API_KEY = apiKey;
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = 'jinggong-agent';
  return environment;
}

/** 通用中转站常用 /v1 根路径，Anthropic SDK 会自行追加 /v1/messages。 */
export function claudeRelayBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function redact(text: string, apiKey?: string): string {
  return (apiKey ? text.split(apiKey).join('[已脱敏]') : text)
    .replace(/Bearer\s+[^\s,;"'<>]+/gi, 'Bearer [已脱敏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已脱敏]')
    .slice(0, 32000);
}

function extractText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  const content = record.content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (!item || typeof item !== 'object') return '';
    const block = item as Record<string, unknown>;
    return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
  }).filter(Boolean).join('');
}

/** 将官方 SDK 的消息流收敛到平台 RuntimeEvent，不暴露隐藏推理、密钥或完整工具参数。 */
export function normalizeClaudeSdkMessage(message: unknown, apiKey?: string): { type: RuntimeEvent['type']; text: string; nativeSessionId?: string; terminal?: boolean } | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const value = message as Record<string, unknown>;
  const sessionId = typeof value.session_id === 'string' ? value.session_id : undefined;
  if (value.type === 'system' && value.subtype === 'init') return { type: 'status', text: 'Claude Runtime 会话已启动', nativeSessionId: sessionId };
  if (value.type === 'stream_event') {
    const event = value.event;
    if (event && typeof event === 'object') {
      const delta = (event as Record<string, unknown>).delta;
      const text = delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>).text === 'string' ? (delta as Record<string, unknown>).text as string : '';
      if (text) return { type: 'delta', text: redact(text, apiKey), nativeSessionId: sessionId };
    }
    return undefined;
  }
  if (value.type === 'assistant') {
    const text = extractText(value.message);
    return text ? { type: 'message', text: redact(text, apiKey), nativeSessionId: sessionId } : undefined;
  }
  if (value.type === 'tool_progress') {
    const tool = typeof value.tool_name === 'string' ? value.tool_name : '未知工具';
    return { type: 'tool', text: `Claude 工具执行中：${tool}`, nativeSessionId: sessionId };
  }
  if (value.type === 'system' && typeof value.subtype === 'string' && value.subtype.startsWith('task_')) {
    const summary = typeof value.summary === 'string' ? value.summary : typeof value.description === 'string' ? value.description : value.subtype;
    return { type: 'tool', text: redact(`Claude 任务：${summary}`, apiKey), nativeSessionId: sessionId };
  }
  if (value.type === 'result') {
    const failed = value.subtype !== 'success' || value.is_error === true;
    const result = typeof value.result === 'string' ? value.result : failed ? 'Claude Runtime 执行失败' : '';
    return { type: failed ? 'error' : 'status', text: failed ? redact(result, apiKey) : 'completed', nativeSessionId: sessionId, terminal: true };
  }
  if (value.type === 'system' && value.subtype === 'permission_denied') {
    const messageText = typeof value.message === 'string' ? value.message : '工具调用被拒绝';
    return { type: 'error', text: redact(messageText, apiKey), nativeSessionId: sessionId };
  }
  return undefined;
}

export class ClaudeAgentSdkRuntimeAdapter implements RuntimeAdapter {
  readonly kind = CLAUDE_AGENT_SDK_RUNTIME_KIND;
  readonly version = CLAUDE_AGENT_SDK_RUNTIME_VERSION;
  readonly capabilitiesVersion = 1;
  private readonly emitter = new EventEmitter();
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly loader: ClaudeSdkLoader;
  private started = false;
  private closed = false;

  constructor(private readonly options: ClaudeRuntimeOptions) {
    this.loader = options.sdkLoader ?? loadOfficialClaudeAgentSdk;
  }

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  async checkRuntime(): Promise<RuntimeHealth> {
    if (!this.options.model.trim()) return { kind: this.kind, available: false, compatible: false, version: this.version, detail: 'Claude Runtime 未配置模型 ID' };
    try {
      await this.loader();
      if (!path.isAbsolute(this.options.executablePath)) throw new Error('未配置应用随包 Claude Binary 的绝对路径');
      const binary = await lstat(this.options.executablePath);
      if (!binary.isFile() || binary.isSymbolicLink()) throw new Error('Claude Binary 不存在或不是受信任的普通文件');
      await access(this.options.executablePath, constants.R_OK);
      if (!this.options.apiKey) return { kind: this.kind, available: true, compatible: true, version: this.version, detail: 'Claude SDK 与 native binary 已就绪；API Key 将使用模型中转站配置' };
      return { kind: this.kind, available: true, compatible: true, version: this.version, detail: 'Claude Agent SDK Runtime 已就绪；连接测试需由用户主动发起' };
    } catch (error) {
      return { kind: this.kind, available: false, compatible: false, version: this.version, detail: `Claude Runtime 组件不可用：${redact((error as Error).message ?? String(error), this.options.apiKey)}` };
    }
  }

  /** 用户主动触发的真实连接测试；checkRuntime() 永远只做本地组件预检。 */
  async testConnection(cwd: string): Promise<RuntimeHealth> {
    const local = await this.checkRuntime();
    if (!local.available || !local.compatible) return local;
    if (!this.options.apiKey) return { ...local, available: false, compatible: false, detail: 'Claude Runtime 组件已就绪，但默认模型中转站尚未配置 API Key' };
    let query: ClaudeSdkQueryHandle | undefined;
    const controller = new AbortController();
    try {
      const normalized = await this.validateCwd(cwd);
      const sdk = await this.loader();
      const additionalDirectories = await this.validateAdditionalDirectories(normalized, this.options.additionalDirectories ?? []);
      query = sdk.query({ prompt: 'Reply with exactly OK.', options: {
        cwd: normalized,
        ...(additionalDirectories?.length ? { additionalDirectories } : {}),
        model: this.options.model,
        abortController: controller,
        settingSources: [],
        permissionMode: 'default',
        includePartialMessages: true,
        tools: [],
        pathToClaudeCodeExecutable: this.options.executablePath,
        env: buildClaudeEnvironment(this.options.apiKey, { ...this.options.env, ...(this.options.relayBaseUrl ? { ANTHROPIC_BASE_URL: claudeRelayBaseUrl(this.options.relayBaseUrl) } : {}) }),
        canUseTool: async () => ({ behavior: 'deny', message: '连接测试期间已禁用工具调用' }),
      } });
      let completed = false;
      for await (const message of query) {
        const normalizedMessage = normalizeClaudeSdkMessage(message, this.options.apiKey);
        if (!normalizedMessage?.terminal) continue;
        if (normalizedMessage.type === 'error') throw new Error(normalizedMessage.text || 'Claude 连接测试失败');
        completed = true;
        break;
      }
      if (!completed) throw new Error('Claude 连接测试未收到完成响应');
      return { ...local, detail: `Claude Agent SDK 连接测试成功（模型：${this.options.model}）` };
    } catch (error) {
      return { ...local, available: false, compatible: false, detail: `Claude 连接测试失败：${redact((error as Error).message ?? String(error), this.options.apiKey)}` };
    } finally {
      controller.abort();
      query?.close?.();
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Claude Runtime 已关闭');
    // 仅加载 JS SDK 并检查组件，不发起模型请求。
    const health = await this.checkRuntime();
    if (!health.available || !health.compatible) throw new Error(health.detail);
    this.started = true;
  }

  async startSession(cwd: string): Promise<string> {
    await this.start();
    const normalized = await this.validateCwd(cwd);
    const id = randomUUID();
    this.sessions.set(id, { id, cwd: normalized });
    return id;
  }

  async resumeSession(threadId: string, cwd: string, nativeSessionId?: string): Promise<string> {
    await this.start();
    const normalized = await this.validateCwd(cwd);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new Error('Claude 原生 Session ID 格式无效；不会跨 Runtime 恢复');
    const native = nativeSessionId?.trim();
    if (native && /[\x00-\x1f]/.test(native)) throw new Error('Claude 原生 Session ID 含非法控制字符');
    this.sessions.set(threadId, { id: threadId, cwd: normalized, ...(native ? { nativeSessionId: native } : {}) });
    return threadId;
  }

  async sendTurn(threadId: string, prompt: string, cwd: string): Promise<void> {
    if (!this.started) await this.start();
    if (!this.options.apiKey) throw new Error('模型中转站尚未配置 API Key；真实模型会话未执行');
    if (!prompt.trim() || prompt.length > 100000) throw new Error('任务内容为空或超过 100000 字符');
    if (prompt.includes(this.options.apiKey)) throw new Error('任务内容包含已配置 Claude 凭据，请先移除');
    const session = this.sessions.get(threadId);
    if (!session) throw new Error('Claude Runtime 会话尚未创建或恢复');
    const resolved = await this.validateCwd(cwd);
    if (path.resolve(resolved).toLowerCase() !== path.resolve(session.cwd).toLowerCase()) throw new Error('Claude Runtime 工作目录与会话不一致');
    if (session.controller) throw new Error('当前 Claude 会话已有正在执行的任务');
    const controller = new AbortController();
    session.controller = controller;
    let query: ClaudeSdkQueryHandle | undefined;
    let terminalStatus: string | undefined;
    try {
      const sdk = await this.loader();
      const additionalDirectories = await this.validateAdditionalDirectories(session.cwd, this.options.additionalDirectories ?? []);
      query = sdk.query({ prompt, options: {
        cwd: session.cwd,
        ...(additionalDirectories?.length ? { additionalDirectories } : {}),
        model: this.options.model,
        abortController: controller,
        settingSources: [],
        permissionMode: 'default',
        includePartialMessages: true,
        ...(this.options.readOnly ? { tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] } : {}),
        ...(this.options.additionalSystemPrompt ? { appendSystemPrompt: this.options.additionalSystemPrompt } : {}),
        pathToClaudeCodeExecutable: this.options.executablePath,
        env: buildClaudeEnvironment(this.options.apiKey, { ...this.options.env, ...(this.options.relayBaseUrl ? { ANTHROPIC_BASE_URL: claudeRelayBaseUrl(this.options.relayBaseUrl) } : {}) }),
        ...(session.nativeSessionId ? { resume: session.nativeSessionId } : {}),
        canUseTool: async (toolName, input, request) => {
          if (this.options.readOnly && !isClaudeReadOnlyTool(toolName)) return { behavior: 'deny', message: '当前会话受只读准入门禁保护，已拒绝写入或执行工具' };
          if (!this.options.onApprovalRequest) return { behavior: 'deny', message: '平台未配置统一权限审批，已拒绝工具调用' };
          const decision = await this.options.onApprovalRequest({ ...request, toolName, input, threadId });
          return decision === 'accept' ? { behavior: 'allow' } : { behavior: 'deny', message: '用户拒绝了该工具调用' };
        },
      } });
      session.query = query;
      this.emit({ threadId, type: 'status', text: 'running' });
      for await (const message of query) {
        const normalized = normalizeClaudeSdkMessage(message, this.options.apiKey);
        if (!normalized) continue;
        if (normalized.nativeSessionId) {
          session.nativeSessionId = normalized.nativeSessionId;
          this.options.onNativeSessionId?.(threadId, normalized.nativeSessionId);
        }
        this.emit({ threadId, type: normalized.type, text: normalized.text });
        if (normalized.terminal) terminalStatus = normalized.text;
        if (normalized.terminal) break;
      }
      if (!controller.signal.aborted && !terminalStatus) this.emit({ threadId, type: 'status', text: 'completed' });
    } catch (error) {
      if (!controller.signal.aborted) {
        this.emit({ threadId, type: 'error', text: redact((error as Error).message ?? String(error), this.options.apiKey) });
        throw error;
      }
      this.emit({ threadId, type: 'status', text: 'interrupted' });
    } finally {
      session.controller = undefined;
      session.query = undefined;
    }
  }

  async cancelRun(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.controller) return;
    session.controller.abort();
    session.query?.close?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const session of this.sessions.values()) {
      session.controller?.abort();
      session.query?.close?.();
    }
    this.sessions.clear();
    this.started = false;
  }

  /** 任务首条 system/init 事件之后可读取真实 Claude 原生 Session ID，用于持久化。 */
  getNativeSessionId(threadId: string): string | undefined { return this.sessions.get(threadId)?.nativeSessionId; }

  private async validateCwd(cwd: string): Promise<string> {
    if (!path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) throw new Error('Claude Runtime 工作目录必须是有效绝对路径');
    const normalized = path.resolve(cwd);
    const stat = await lstat(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Claude Runtime 工作目录必须是受信任的实际目录');
    await access(normalized, constants.R_OK);
    return realpath(normalized);
  }

  private async validateAdditionalDirectories(cwd: string, directories: string[]): Promise<string[]> {
    const seen = new Set([this.canonicalKey(cwd)]);
    const result: string[] = [];
    for (const directory of directories) {
      if (!path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory)) throw new Error('Claude 附加仓库目录必须是有效绝对路径');
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Claude 附加仓库目录不是受信任的实际目录：${path.basename(directory)}`);
      const canonical = await realpath(directory);
      const key = this.canonicalKey(canonical);
      if (seen.has(key)) throw new Error('Claude 附加仓库目录重复或与主仓库相同');
      seen.add(key);
      await access(canonical, constants.R_OK);
      result.push(canonical);
    }
    return result;
  }

  private canonicalKey(value: string): string { return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value); }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Claude Runtime 任务已取消');
  }

  private emit(event: RuntimeEvent): void { this.emitter.emit('event', event); }
}

export function createClaudeAgentSdkRuntimeAdapter(options: ClaudeRuntimeOptions): ClaudeAgentSdkRuntimeAdapter {
  return new ClaudeAgentSdkRuntimeAdapter(options);
}

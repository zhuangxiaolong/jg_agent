export type WeComEventType = 'session.completed' | 'session.failed' | 'session.error' | 'session.cancelled' | 'session.interrupted';
export type WeComRuntimeKind = 'codex' | 'jinggong' | 'claude_agent_sdk';
export type WeComErrorCode = 'NETWORK_TIMEOUT' | 'NETWORK_UNAVAILABLE' | 'WEBHOOK_INVALID' | 'RATE_LIMITED' | 'MESSAGE_INVALID' | 'MENTION_INVALID' | 'REMOTE_REJECTED' | 'CREDENTIAL_MISSING' | 'DELIVERY_INTERRUPTED';

export interface WeComEventPolicy {
  onCompleted: boolean;
  onFailed: boolean;
  onError: boolean;
  onCancelled: boolean;
  onInterrupted: boolean;
}

export interface WeComNotificationTarget {
  id: string;
  name: string;
  purpose: 'private_group' | 'team_group';
  credentialRef: string;
  enabled: boolean;
  mentionedUserIds?: string[];
  mentionedMobiles?: string[];
  eventPolicy: WeComEventPolicy;
  workspaceIds?: string[];
  runtimeKinds?: WeComRuntimeKind[];
}

export interface WeComTerminalEvent {
  eventId: string;
  platformSessionId: string;
  workspaceId?: string;
  workspaceName?: string;
  runtimeKind: WeComRuntimeKind;
  eventType: WeComEventType;
  occurredAt: string;
  title: string;
  summary?: string;
  durationMs?: number;
  repositorySummaries?: Array<{ name: string }>;
  changedFileCount?: number;
  testSummary?: string;
  failedStage?: string;
  errorSummary?: string;
  hasUncommittedChanges?: boolean;
}

export interface WeComTargetPrecedence {
  sessionTargetIds?: string[];
  workspaceTargetIds?: string[];
  runtimeTargetIds?: string[];
  defaultTargetIds?: string[];
}

export interface WeComTextPayload {
  msgtype: 'text';
  text: {
    content: string;
    mentioned_list?: string[];
    mentioned_mobile_list?: string[];
  };
}

export interface WeComSendSuccess { ok: true; httpStatus: number; errcode: 0; attempts: number }
export interface WeComSendFailure { ok: false; code: WeComErrorCode; retryable: boolean; attempts: number; httpStatus?: number; errcode?: number; errorSummary: string }
export type WeComSendResult = WeComSendSuccess | WeComSendFailure;

export const DEFAULT_WECOM_EVENT_POLICY: WeComEventPolicy = {
  onCompleted: true,
  onFailed: true,
  onError: true,
  onCancelled: false,
  onInterrupted: true,
};

const MAX_MESSAGE_BYTES = 1800;
const MAX_NAME_LENGTH = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_INTERVAL_MS = 3_100;

function eventEnabled(policy: WeComEventPolicy, type: WeComEventType): boolean {
  switch (type) {
    case 'session.completed': return policy.onCompleted;
    case 'session.failed': return policy.onFailed;
    case 'session.error': return policy.onError;
    case 'session.cancelled': return policy.onCancelled;
    case 'session.interrupted': return policy.onInterrupted;
  }
}

/** 按会话、工作区、Runtime、全局顺序合并目标；高优先级目标先出现，同一目标只保留一次。 */
export function resolveWeComTargets(
  event: WeComTerminalEvent,
  targets: readonly WeComNotificationTarget[],
  precedence: WeComTargetPrecedence,
): WeComNotificationTarget[] {
  const configured = new Map(targets.map(target => [target.id, target]));
  const orderedIds = [
    ...(precedence.sessionTargetIds ?? []),
    ...(precedence.workspaceTargetIds ?? []),
    ...(precedence.runtimeTargetIds ?? []),
    ...(precedence.defaultTargetIds ?? []),
  ];
  const seen = new Set<string>();
  const result: WeComNotificationTarget[] = [];
  for (const id of orderedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const target = configured.get(id);
    if (!target?.enabled || !eventEnabled(target.eventPolicy, event.eventType)) continue;
    if (target.workspaceIds?.length && (!event.workspaceId || !target.workspaceIds.includes(event.workspaceId))) continue;
    if (target.runtimeKinds?.length && !target.runtimeKinds.includes(event.runtimeKind)) continue;
    result.push(target);
  }
  return result;
}

function cleanField(value: string | undefined, fallback = '未提供', limit = MAX_NAME_LENGTH): string {
  if (!value) return fallback;
  let text = value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/Bearer\s+[^\s,;"'<>]+/gi, 'Bearer [已脱敏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已脱敏]')
    .replace(/(https?:\/\/[^\s?]+\?[^\s#]*\bkey=)[^&\s]+/gi, '$1[已脱敏]')
    .replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[本机路径已省略]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[本机路径已省略]')
    .replace(/\\\\[^\\\s]+\\[^\\\s]+(?:\\[^\\\s]+)*/g, '[本机路径已省略]')
    .replace(/(?:file:\/\/[^\s]+|https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s]*)/gi, '[本机路径已省略]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) text = fallback;
  return text.slice(0, limit);
}

function fitUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = '';
  for (const character of text) {
    if (Buffer.byteLength(result + character + '…', 'utf8') > maxBytes) break;
    result += character;
  }
  return `${result}…`;
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return '未知';
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function runtimeLabel(kind: WeComRuntimeKind): string {
  return kind === 'codex' ? 'Codex' : kind === 'jinggong' ? 'Jinggong' : 'Claude Agent SDK';
}

/** 仅输出必要摘要，不包含代码、Diff、对话推理、密钥或本机可访问性不明的链接。 */
export function renderWeComMessage(event: WeComTerminalEvent): string {
  const title = cleanField(event.title, '未命名任务');
  const workspace = cleanField(event.workspaceName, '未指定');
  const repos = (event.repositorySummaries ?? []).map(repo => cleanField(repo.name, '未命名仓库', 80)).slice(0, 8).join('、') || '未指定';
  const timestamp = cleanField(event.occurredAt, '未知', 40);
  const error = cleanField(event.errorSummary ?? event.summary, '请打开精工Agent检查任务详情。', 240);
  const failed = event.eventType !== 'session.completed';
  const lines = failed
    ? [
      '【精工Agent】任务执行异常',
      `任务：${title}`,
      `Runtime：${runtimeLabel(event.runtimeKind)}`,
      `工作区：${workspace}`,
      `失败阶段：${cleanField(event.failedStage, '未知')}`,
      `错误摘要：${error}`,
      `未提交修改：${event.hasUncommittedChanges === undefined ? '未知' : event.hasUncommittedChanges ? '是' : '否'}`,
      `发生时间：${timestamp}`,
      '请打开精工Agent检查任务详情。',
    ]
    : [
      '【精工Agent】任务已完成',
      `任务：${title}`,
      `Runtime：${runtimeLabel(event.runtimeKind)}`,
      `工作区：${workspace}`,
      `仓库：${repos}`,
      `修改文件：${Number.isInteger(event.changedFileCount) && event.changedFileCount! >= 0 ? event.changedFileCount : '未知'}`,
      `测试：${cleanField(event.testSummary, '未执行')}`,
      `耗时：${formatDuration(event.durationMs)}`,
      `完成时间：${timestamp}`,
    ];
  return fitUtf8(lines.join('\n'), MAX_MESSAGE_BYTES);
}

function normalizeMentions(values: readonly string[] | undefined, pattern: RegExp, fieldName: string): string[] {
  const cleaned = [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))];
  if (cleaned.some(value => value === '@all' || !pattern.test(value))) throw new Error(`${fieldName}格式无效，且不支持 @all`);
  return cleaned;
}

export function createWeComTextPayload(content: string, target: Pick<WeComNotificationTarget, 'purpose' | 'mentionedUserIds' | 'mentionedMobiles'>): WeComTextPayload {
  const safeContent = fitUtf8(cleanField(content, '', Number.MAX_SAFE_INTEGER), MAX_MESSAGE_BYTES);
  if (!safeContent) throw new Error('通知内容不能为空');
  const payload: WeComTextPayload = { msgtype: 'text', text: { content: safeContent } };
  if (target.purpose === 'team_group') {
    const users = normalizeMentions(target.mentionedUserIds, /^[A-Za-z0-9_.@-]{1,128}$/, '@ UserID');
    const mobiles = normalizeMentions(target.mentionedMobiles, /^\+?[0-9]{6,20}$/, '@ 手机号');
    if (users.length) payload.text.mentioned_list = users;
    if (mobiles.length) payload.text.mentioned_mobile_list = mobiles;
  }
  return payload;
}

export function createWeComIdempotencyKey(eventId: string, targetId: string): string {
  if (!eventId || !targetId || /[\x00-\x1f]/.test(eventId + targetId)) throw new Error('通知去重标识无效');
  return `${eventId}:${targetId}`;
}

export interface WeComCredentialReader { getSecret(reference: string): Promise<string | null> }
export type WeComTransport = (url: string, init: RequestInit) => Promise<Response>;

export class WeComDeliveryError extends Error {
  constructor(readonly code: WeComErrorCode, readonly retryable: boolean, message: string, readonly httpStatus?: number, readonly errcode?: number, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'WeComDeliveryError';
  }
}

function validateWebhookUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WeComDeliveryError('WEBHOOK_INVALID', false, 'Webhook 地址无效'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'qyapi.weixin.qq.com' || url.username || url.password || url.pathname !== '/cgi-bin/webhook/send' || !url.searchParams.get('key') || url.hash) {
    throw new WeComDeliveryError('WEBHOOK_INVALID', false, 'Webhook 地址不是有效的企业微信群机器人地址');
  }
  return url;
}

function errorForStatus(status: number, retryAfterMs?: number): WeComDeliveryError {
  if (status === 429) return new WeComDeliveryError('RATE_LIMITED', true, '企业微信通知达到频率限制', status, undefined, retryAfterMs);
  if (status === 408) return new WeComDeliveryError('NETWORK_TIMEOUT', true, '企业微信通知请求超时', status, undefined, retryAfterMs);
  if (status >= 500) return new WeComDeliveryError('NETWORK_UNAVAILABLE', true, '企业微信服务暂时不可用', status, undefined, retryAfterMs);
  if (status >= 400) return new WeComDeliveryError('REMOTE_REJECTED', false, '企业微信拒绝了通知请求', status);
  return new WeComDeliveryError('REMOTE_REJECTED', false, '企业微信返回了无效响应', status);
}

function retryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(60_000, date - now)) : undefined;
}

function parseWeComError(errcode: number, status: number, retryAfterMs?: number): WeComDeliveryError {
  if (errcode === 45009) return new WeComDeliveryError('RATE_LIMITED', true, '企业微信通知达到频率限制', status, errcode, retryAfterMs);
  if ([93000, 93008].includes(errcode)) return new WeComDeliveryError('WEBHOOK_INVALID', false, 'Webhook 无效或机器人已失效', status, errcode);
  if ([93009, 93010].includes(errcode)) return new WeComDeliveryError('MENTION_INVALID', false, '群成员 @ 参数无效，请检查 UserID 或手机号', status, errcode);
  if ([93004, 93013, 93014].includes(errcode)) return new WeComDeliveryError('MESSAGE_INVALID', false, '企业微信不接受当前消息格式或长度', status, errcode);
  return new WeComDeliveryError('REMOTE_REJECTED', false, '企业微信业务接口拒绝了通知', status, errcode);
}

export class WeComWebhookAdapter {
  constructor(
    private readonly credentials: WeComCredentialReader,
    private readonly transport: WeComTransport = (url, init) => fetch(url, init),
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async sendText(target: WeComNotificationTarget, content: string): Promise<{ httpStatus: number; errcode: 0 }> {
    if (!target.enabled) throw new WeComDeliveryError('WEBHOOK_INVALID', false, '通知目标已停用');
    let secret: string | null;
    try {
      secret = await this.credentials.getSecret(target.credentialRef);
    } catch {
      throw new WeComDeliveryError('CREDENTIAL_MISSING', false, '本地 Webhook 凭据读取失败');
    }
    if (!secret) throw new WeComDeliveryError('CREDENTIAL_MISSING', false, '本地 Webhook 凭据不存在');
    const url = validateWebhookUrl(secret);
    const payload = createWeComTextPayload(content, target);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.transport(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new WeComDeliveryError('NETWORK_TIMEOUT', true, '企业微信通知请求超时');
      const code = (error as NodeJS.ErrnoException)?.code;
      throw new WeComDeliveryError('NETWORK_UNAVAILABLE', true, code === 'ENOTFOUND' ? '无法连接企业微信服务' : '企业微信网络请求失败');
    } finally {
      clearTimeout(timer);
    }
    const delay = retryAfter(response.headers.get('retry-after'), this.now());
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (!response.ok) throw errorForStatus(response.status, delay);
      throw new WeComDeliveryError('REMOTE_REJECTED', false, '企业微信返回了无法解析的响应', response.status);
    }
    const result = body as { errcode?: unknown } | null;
    if (result && Number.isInteger(result.errcode)) {
      const errcode = result.errcode as number;
      if (errcode !== 0) throw parseWeComError(errcode, response.status, delay);
      if (!response.ok) throw errorForStatus(response.status, delay);
      return { httpStatus: response.status, errcode: 0 };
    }
    if (!response.ok) throw errorForStatus(response.status, delay);
    throw new WeComDeliveryError('REMOTE_REJECTED', false, '企业微信响应缺少业务状态码', response.status);
  }
}

export interface WeComRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  minIntervalMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** 按目标串行节流，并仅对网络/限流错误执行有界指数退避。 */
export class WeComNotificationSender {
  private readonly lastSentAt = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly minIntervalMs: number;

  constructor(private readonly adapter: WeComWebhookAdapter, options: WeComRetryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 3));
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 8000);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  }

  async send(target: WeComNotificationTarget, content: string): Promise<WeComSendResult> {
    return this.withTargetLock(target.id, async () => {
      let failure: WeComDeliveryError | undefined;
      let attempt = 0;
      for (attempt = 1; attempt <= this.maxAttempts; attempt++) {
        await this.waitForTarget(target.id);
        this.lastSentAt.set(target.id, this.now());
        try {
          const result = await this.adapter.sendText(target, content);
          return { ok: true, ...result, attempts: attempt };
        } catch (error) {
          failure = error instanceof WeComDeliveryError
            ? error
            : new WeComDeliveryError('NETWORK_UNAVAILABLE', true, '企业微信网络请求失败');
          if (!failure.retryable || attempt >= this.maxAttempts) break;
          const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
          const jitter = Math.floor(exponential * Math.max(0, Math.min(1, this.random())) * 0.5);
          await this.sleep(Math.max(failure.retryAfterMs ?? 0, exponential + jitter));
        }
      }
      const finalFailure = failure ?? new WeComDeliveryError('REMOTE_REJECTED', false, '通知发送失败');
      return {
        ok: false,
        code: finalFailure.code,
        retryable: finalFailure.retryable,
        attempts: Math.min(attempt, this.maxAttempts),
        ...(finalFailure.httpStatus === undefined ? {} : { httpStatus: finalFailure.httpStatus }),
        ...(finalFailure.errcode === undefined ? {} : { errcode: finalFailure.errcode }),
        errorSummary: finalFailure.message,
      };
    });
  }

  private async withTargetLock<T>(targetId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(targetId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(targetId, tail);
    await previous;
    try { return await action(); }
    finally {
      release();
      if (this.tails.get(targetId) === tail) this.tails.delete(targetId);
    }
  }

  private async waitForTarget(targetId: string): Promise<void> {
    const earliest = (this.lastSentAt.get(targetId) ?? 0) + this.minIntervalMs;
    const wait = Math.max(0, earliest - this.now());
    if (wait) await this.sleep(wait);
  }
}

export * from './desktop-service';

import type { JiraAssignee, JiraAttachment, JiraConnectionResult, JiraIssue, JiraProject, JiraSearchInput, JiraSearchPage, JiraTransition } from '../../domain/src';
import { createHmac, randomBytes } from 'node:crypto';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_SIZE = 50;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]{0,63})-[1-9]\d{0,18}$/;
export type JiraImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const MAX_JIRA_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_JIRA_IMAGES = 20;
export const MAX_JIRA_SESSION_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_SCOPE_SALT = randomBytes(32);
const MAX_SESSION_RESPONSE_BYTES = 16 * 1024;
class JiraAuthenticationError extends Error {}

/** 校验实际文件头及容器边界，不允许 SVG/HTML 伪装为图片。 */
export function inspectJiraImage(value: Uint8Array, declaredType: string): { mimeType: JiraImageMimeType; imageBytes: number } {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const declaredMime = declaredType.split(';', 1)[0].trim().toLowerCase();
  if (!IMAGE_TYPES.includes(declaredMime)) throw new Error('Jira 图片仅支持 PNG、JPEG、GIF 和 WebP，拒绝 SVG、HTML 或未知类型');
  if (!bytes.length || bytes.length > MAX_JIRA_IMAGE_BYTES) throw new Error('Jira 图片为空或超过每张 8 MiB 限制');
  // Jira 历史附件可能把 JPEG 错标为 PNG；真实文件签名决定缓存类型，声明仍须是受支持的图片 MIME。
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) ? 'image/gif'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined;
  const dimensions = (width: number, height: number) => {
    if (!width || !height || width * height > 40000000) throw new Error('Jira 图片尺寸无效或超过 4000 万像素限制');
  };
  let valid = false, imageBytes = bytes.length;
  if (mimeType === 'image/png' && bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, first = true;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length) break;
      const kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (first) { if (kind !== 'IHDR' || length !== 13) break; dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12)); first = false; }
      if (kind === 'IEND') { valid = length === 0 && end === bytes.length; break; }
      offset = end;
    }
  } else if (mimeType === 'image/jpeg' && bytes.length >= 16) {
    let offset = 2, frame = false, scan = false;
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217) { valid = frame && scan && bytes.length - offset <= 64 * 1024; imageBytes = offset; break; }
      if (marker === 0 || marker === 216 || marker === undefined) break;
      if (marker === 1) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8) { dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)); frame = true; }
      offset += length;
      if (marker === 218) {
        if (!frame || length < 6) break;
        scan = true;
        // 熵编码内 FF00 为转义字节，FFD0..FFD7 为重启标记；其余标记交回外层解析。
        while (offset < bytes.length) {
          if (bytes[offset] !== 255) { offset++; continue; }
          const start = offset++;
          while (bytes[offset] === 255) offset++;
          if (bytes[offset] === 0 || bytes[offset] >= 208 && bytes[offset] <= 215) { offset++; continue; }
          offset = start; break;
        }
      }
    }
  } else if (mimeType === 'image/gif' && bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes[bytes.length - 1] === 59) {
    dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8)); valid = true;
  } else if (mimeType === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    const kind = bytes.toString('ascii', 12, 16), length = bytes.readUInt32LE(16);
    if (20 + length <= bytes.length) {
      if (kind === 'VP8X' && length >= 10) { dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1); valid = true; }
      if (kind === 'VP8 ' && length >= 10 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) { dimensions(bytes.readUInt16LE(26) & 16383, bytes.readUInt16LE(28) & 16383); valid = true; }
      if (kind === 'VP8L' && length >= 5 && bytes[20] === 47) { const packed = bytes.readUInt32LE(21); dimensions((packed & 16383) + 1, ((packed >>> 14) & 16383) + 1); valid = true; }
    }
  }
  if (!valid) throw new Error('Jira 图片真实签名或文件结构与 MIME 不一致，已拒绝使用');
  return { mimeType: mimeType as JiraImageMimeType, imageBytes };
}

export function validateJiraImage(value: Uint8Array, declaredType: string): JiraImageMimeType { return inspectJiraImage(value, declaredType).mimeType; }
export interface JiraConnectorOptions { baseUrl: string; account: string; password: string; projectKey?: string; dateFieldId?: string }
export type JiraTransport = (url: string, init: RequestInit) => Promise<Response>;

export function parseJiraLocation(value: string): { baseUrl: string; projectKey?: string } {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /[\x00-\x1f\\]/.test(value)) throw new Error('请输入有效的 Jira HTTP 或 HTTPS 地址');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的 Jira HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /%2f|%5c/i.test(url.pathname)) throw new Error('Jira 地址仅支持 HTTP/HTTPS，且不能包含用户名、密码或编码路径分隔符');
  const segments = url.pathname.split('/').filter(Boolean);
  const route = segments.findIndex(part => ['projects', 'browse', 'secure', 'plugins'].includes(part.toLowerCase()));
  let projectKey: string | undefined;
  if (route >= 0) {
    let candidate = segments[route + 1] ?? '';
    try { candidate = decodeURIComponent(candidate).toUpperCase(); } catch { throw new Error('Jira 地址包含无效编码'); }
    if (segments[route].toLowerCase() === 'browse') candidate = ISSUE_KEY.exec(candidate)?.[1] ?? '';
    if (['projects', 'browse'].includes(segments[route].toLowerCase()) && PROJECT_KEY.test(candidate)) projectKey = candidate;
  }
  const queryProject = url.searchParams.get('projectKey')?.toUpperCase();
  if (!projectKey && queryProject && PROJECT_KEY.test(queryProject)) projectKey = queryProject;
  const context = (route >= 0 ? segments.slice(0, route) : segments).join('/');
  return { baseUrl: `${url.origin}${context ? `/${context}` : ''}`, ...(projectKey ? { projectKey } : {}) };
}

export function normalizeJiraUrl(value: string): string { return parseJiraLocation(value).baseUrl; }

function object(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown, maximum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }

/** Jira 查询及用户主动发起的任务流转，不执行业务资料中的指令。 */
export class JiraConnector {
  private readonly baseUrl: string;
  private readonly projectKey: string;
  private readonly dateFieldId: string;
  private readonly authorization: string;
  readonly imageCacheScope: string;
  private metadataPromise?: Promise<JiraConnectionResult>;
  private sessionPromise?: Promise<string>;
  private sessionCookie?: string;
  private sessionValue?: string;
  constructor(private readonly options: JiraConnectorOptions, private readonly transport: JiraTransport = fetch) {
    const location = parseJiraLocation(options.baseUrl);
    this.baseUrl = location.baseUrl;
    this.projectKey = (options.projectKey ?? location.projectKey ?? 'NEWDEVGROUP').toUpperCase();
    this.dateFieldId = options.dateFieldId ?? '11116';
    if (!PROJECT_KEY.test(this.projectKey)) throw new Error('Jira 项目 Key 只能使用英文字母、数字和下划线，且必须以字母开头');
    if (!/^\d{1,12}$/.test(this.dateFieldId)) throw new Error('Jira 日期字段 ID 必须为数字，例如 11116');
    if (typeof options.account !== 'string' || !options.account.trim() || /[:\x00-\x1f]/.test(options.account) || typeof options.password !== 'string' || !options.password || /[\r\n\0]/.test(options.password)) throw new Error('请配置有效的 Jira 账号与独立密码或 Token');
    this.authorization = `Basic ${Buffer.from(`${options.account}:${options.password}`, 'utf8').toString('base64')}`;
    this.imageCacheScope = createHmac('sha256', IMAGE_SCOPE_SALT).update(`${this.baseUrl}\0${this.authorization}`).digest('hex');
  }

  private text(value: unknown): string {
    if (typeof value !== 'string') return '';
    const text = value.split(this.options.password).join('[已脱敏]').split(this.authorization).join('[已脱敏]');
    return this.sessionValue ? text.split(this.sessionValue).join('[已脱敏]') : text;
  }

  private async authenticateSession(signal: AbortSignal): Promise<string> {
    if (!this.sessionPromise) this.sessionPromise = (async () => {
      let response: Response | undefined;
      try {
        // 兼容网页登录可用但 Basic 被拒绝的 Jira Server，JSON 登录保持 UTF-8 并仅在内存保存会话。
        response = await this.transport(`${this.baseUrl}/rest/auth/1/session`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: this.options.account, password: this.options.password }), redirect: 'error', credentials: 'omit', cache: 'no-store', signal });
        if (/AUTHENTICATION_DENIED|CAPTCHA/i.test(response.headers.get('x-seraph-loginreason') ?? '')) throw new JiraAuthenticationError('Jira 已拒绝认证或要求验证码，请先在 Jira 网页完成登录验证后重试');
        if (response.status === 429) throw new JiraAuthenticationError('Jira 请求过于频繁，请稍后重试');
        if (response.status >= 500) throw new JiraAuthenticationError('Jira 服务暂时不可用，请稍后重试');
        if (response.status >= 300 && response.status < 400) throw new JiraAuthenticationError('Jira 登录返回地址重定向，请检查 Jira Base URL；连接器不会转发认证信息');
        if (!response.ok) throw new JiraAuthenticationError('Jira 认证失败，请检查登录账号、密码或 Token，以及 Jira REST 认证配置');
        if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new JiraAuthenticationError('Jira 会话登录未返回有效 JSON，请检查 Jira REST 认证配置');
        const declared = response.headers.get('content-length');
        if (declared && Number(declared) > MAX_SESSION_RESPONSE_BYTES) throw new JiraAuthenticationError('Jira 会话登录响应过大，已拒绝保存');
        const reader = response.body?.getReader();
        if (!reader) throw new JiraAuthenticationError('Jira 会话登录返回空响应');
        const chunks: Uint8Array[] = []; let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_SESSION_RESPONSE_BYTES) throw new JiraAuthenticationError('Jira 会话登录响应过大，已拒绝保存');
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
        let data: unknown;
        try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
        catch { throw new JiraAuthenticationError('Jira 会话登录返回无效 JSON'); }
        const session = object(data) && object(data.session) ? data.session : undefined;
        if (!session || typeof session.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session.name) || typeof session.value !== 'string' || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/.test(session.value)) throw new JiraAuthenticationError('Jira 会话登录未返回有效会话，请检查 Jira REST 认证配置');
        this.sessionValue = session.value;
        this.sessionCookie = `${session.name}=${session.value}`;
        return this.sessionCookie;
      } finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined); }
    })();
    return this.sessionPromise;
  }

  private async authenticatedRequest(url: string, init: RequestInit): Promise<Response> {
    const previous = this.sessionCookie;
    const send = (cookie?: string) => this.transport(url, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : { Authorization: this.authorization }) } });
    const response = await send(previous);
    if (response.status !== 401 || /AUTHENTICATION_DENIED|CAPTCHA/i.test(response.headers.get('x-seraph-loginreason') ?? '')) return response;
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    if (previous && this.sessionCookie === previous) { this.sessionCookie = undefined; this.sessionPromise = undefined; }
    // 并行查询共用一次登录；失败不重复尝试，避免错误密码触发账号锁定。
    const cookie = await this.authenticateSession(init.signal as AbortSignal);
    return send(cookie);
  }

  private async get(endpoint: string, query?: URLSearchParams, mutation?: { method: 'POST' | 'PUT'; body: BodyInit; multipart?: boolean }): Promise<any> {
    const url = `${this.baseUrl}/rest/api/2/${endpoint}${query ? `?${query}` : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref();
    let response: Response | undefined;
    try {
      try { response = await this.authenticatedRequest(url, { method: mutation?.method ?? 'GET', headers: { Accept: 'application/json', ...(mutation ? mutation.multipart ? { 'X-Atlassian-Token': 'no-check' } : { 'Content-Type': 'application/json' } : {}) }, ...(mutation ? { body: mutation.body } : {}), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal }); }
      catch (error) { if (error instanceof JiraAuthenticationError) throw error; throw new Error(controller.signal.aborted ? 'Jira 请求超过 15 秒，请检查网络后重试' : '无法连接 Jira，请检查地址、网络、证书及是否发生登录重定向'); }
      if (/AUTHENTICATION_DENIED|CAPTCHA/i.test(response.headers.get('x-seraph-loginreason') ?? '')) throw new Error('Jira 已拒绝认证或要求验证码，请先在 Jira 网页完成登录验证后重试');
      if (response.status === 401) throw new Error('Jira 认证失败，请检查账号、密码或 Token');
      if (response.status === 403) throw new Error('当前 Jira 账号没有访问权限，请联系 Jira 管理员检查项目与 REST 权限');
      if (response.status === 404) throw new Error('Jira 地址、项目、字段或任务不存在，或当前账号无权查看');
      if (response.status === 429) throw new Error('Jira 请求过于频繁，请稍后重试');
      if (response.status >= 300 && response.status < 400) throw new Error('Jira 返回登录或地址重定向，请填写正确的 Jira Base URL；连接器不会转发认证信息');
      if (!response.ok) {
        if (!mutation) throw new Error(response.status >= 500 ? 'Jira 服务暂时不可用，请稍后重试' : 'Jira 拒绝了查询，请检查项目、日期字段和查询权限');
        const errors = await response.text();
        let detail = ''; try { const data = JSON.parse(errors); detail = [...(Array.isArray(data.errorMessages) ? data.errorMessages : []), ...Object.entries(data.errors ?? {}).map(([name, value]) => `${name}: ${value}`)].join('；'); } catch { /* 非 JSON 不作为业务详情显示。 */ }
        throw new Error(this.text(`Jira ${response.status >= 500 ? '服务暂时不可用，' : ''}${mutation ? '操作' : '查询'}失败（HTTP ${response.status}）${detail ? '：' + detail.slice(0, 1200) : ''}`));
      }
      if (response.status === 204) return undefined;
      if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Jira 未返回 JSON 数据，可能需要网页登录或 Base URL 不正确');
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new Error('Jira 响应超过 8 MiB，请缩小查询范围');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Jira 返回了空响应');
      try {
        while (true) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try { part = await reader.read(); } catch { throw new Error(controller.signal.aborted ? 'Jira 请求超过 15 秒，请检查网络后重试' : 'Jira 响应传输中断，请重试'); }
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error('Jira 响应超过 8 MiB，请缩小查询范围');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      let result: unknown;
      try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { throw new Error('Jira 返回了无效 JSON，未将错误内容作为任务展示'); }
      if (object(result) && ((Array.isArray(result.errorMessages) && result.errorMessages.length) || (object(result.errors) && Object.keys(result.errors).length))) throw new Error('Jira 返回查询错误，请检查字段、日期及访问权限');
      return result;
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    }
  }

  async transitions(key: string): Promise<JiraTransition[]> {
    if (!ISSUE_KEY.test(key)) throw new Error('Jira 任务编号无效');
    const data = await this.get(`issue/${encodeURIComponent(key)}/transitions`);
    if (!Array.isArray(data?.transitions)) throw new Error('Jira 流转状态格式无效');
    return data.transitions.filter((item: any) => typeof item.id === 'string' && typeof item.name === 'string').map((item: any) => ({ id: this.text(item.id), name: this.text(item.name), status: this.text(item.to?.name || item.name) }));
  }
  async assignees(key: string, query = ''): Promise<JiraAssignee[]> {
    if (!ISSUE_KEY.test(key) || query.length > 100) throw new Error('Jira 经办人查询无效');
    const data = await this.get('user/assignable/search', new URLSearchParams({ issueKey: key, query, username: query, maxResults: '50' }));
    if (!Array.isArray(data)) throw new Error('Jira 经办人格式无效');
    return data.filter((item: any) => item.active !== false && (typeof item.accountId === 'string' || typeof item.name === 'string')).map((item: any) => ({ id: this.text(item.accountId || item.name), displayName: this.text(item.displayName || item.name), field: item.accountId ? 'accountId' : 'name' }));
  }
  async reporter(key: string): Promise<JiraAssignee | undefined> {
    if (!ISSUE_KEY.test(key)) throw new Error('Jira 任务编号无效');
    const data = await this.get(`issue/${encodeURIComponent(key)}`, new URLSearchParams({ fields: 'reporter' }));
    const item = data?.fields?.reporter;
    if (!object(item) || item.active === false) return undefined;
    const id = this.text(item.accountId || item.name), displayName = this.text(item.displayName || item.name);
    return id && displayName ? { id, displayName, field: item.accountId ? 'accountId' : 'name' } : undefined;
  }
  async uploadTestImage(key: string, name: string, bytes: Uint8Array, mimeType: string): Promise<{ id: string; name: string }> {
    validateJiraImage(bytes, mimeType);
    return this.uploadAttachment(key, name, bytes, mimeType);
  }
  async uploadAttachment(key: string, name: string, bytes: Uint8Array, mimeType: string): Promise<{ id: string; name: string }> {
    if (!ISSUE_KEY.test(key) || !name || /[\x00-\x1f\x7f/\\]/.test(name) || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType)) throw new Error('Jira 附件参数无效');
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('单个 Jira 附件不能超过 8 MiB');
    const form = new FormData(); form.append('file', new Blob([Uint8Array.from(bytes)], { type: mimeType }), name);
    const data = await this.get(`issue/${encodeURIComponent(key)}/attachments`, undefined, { method: 'POST', body: form, multipart: true });
    if (!Array.isArray(data) || typeof data[0]?.id !== 'string' || typeof data[0]?.filename !== 'string') throw new Error('Jira 未返回已上传附件信息，请检查附件后再重试');
    return { id: data[0].id, name: this.text(data[0].filename) };
  }
  async assign(key: string, assignee: JiraAssignee): Promise<void> {
    if (!ISSUE_KEY.test(key) || !assignee.id || !['name', 'accountId'].includes(assignee.field)) throw new Error('Jira 经办人参数无效');
    await this.get(`issue/${encodeURIComponent(key)}/assignee`, undefined, { method: 'PUT', body: JSON.stringify({ [assignee.field]: assignee.id }) });
  }
  async transition(key: string, transitionId: string, comment: string): Promise<void> {
    if (!ISSUE_KEY.test(key) || !/^[a-zA-Z0-9_-]{1,100}$/.test(transitionId) || !comment.trim() || comment.length > 30000) throw new Error('请选择状态并填写不超过 30000 字的测试结果');
    await this.get(`issue/${encodeURIComponent(key)}/transitions`, undefined, { method: 'POST', body: JSON.stringify({ transition: { id: transitionId }, update: { comment: [{ add: { body: comment } }] } }) });
  }

  private async metadata(): Promise<JiraConnectionResult> {
    if (!this.metadataPromise) {
      this.metadataPromise = (async () => {
        const [user, fields] = await Promise.all([this.get('myself'), this.get('field')]);
        if (!object(user) || typeof user.displayName !== 'string' || typeof user.timeZone !== 'string' || !user.timeZone) throw new Error('Jira 未返回当前用户与时区，无法可靠构造日期查询');
        try { new Intl.DateTimeFormat('zh-CN', { timeZone: user.timeZone }).format(); } catch { throw new Error('Jira 返回的用户时区无法识别，请由管理员检查时区配置'); }
        if (!Array.isArray(fields)) throw new Error('Jira 字段元数据格式无效，无法识别日期字段');
        const field = fields.find(item => object(item) && item.id === `customfield_${this.dateFieldId}`);
        if (!field || !object(field.schema)) throw new Error(`当前账号无法读取日期字段 cf[${this.dateFieldId}]，请检查字段 ID 与权限`);
        const kinds = new Set<'date' | 'datetime'>();
        if (field.schema.type === 'date' || field.schema.type === 'datetime') kinds.add(field.schema.type);
        if (typeof field.schema.custom === 'string' && /:datepicker$/.test(field.schema.custom)) kinds.add('date');
        if (typeof field.schema.custom === 'string' && /:(?:datetime|datetimepicker)$/.test(field.schema.custom)) kinds.add('datetime');
        if (kinds.size !== 1) throw new Error('配置的 Jira 字段不是可确认的 Date 或 Date Time 类型，请联系管理员核实');
        return { displayName: this.text(user.displayName), timeZone: user.timeZone, fieldName: this.text(field.name) || `cf[${this.dateFieldId}]`, fieldType: [...kinds][0] };
      })().catch(error => { this.metadataPromise = undefined; throw error; });
    }
    return this.metadataPromise;
  }

  async testConnection(): Promise<JiraConnectionResult> { return this.metadata(); }

  async downloadImage(attachment: JiraAttachment): Promise<{ bytes: Uint8Array; mimeType: JiraImageMimeType }> {
    let url: URL;
    try { url = new URL(attachment.url); } catch { throw new Error('Jira 图片附件地址无效，无法安全下载'); }
    const base = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || url.hash || /[%](?:2f|5c)/i.test(url.pathname) || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) throw new Error('Jira 图片必须来自已配置服务的同源和相同 context 路径，禁止向外站发送凭据');
    if (!integer(attachment.size, MAX_JIRA_IMAGE_BYTES)) throw new Error('Jira 图片超过每张 8 MiB 限制或大小无效');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS); timer.unref();
    let response: Response | undefined;
    try {
      try { response = await this.authenticatedRequest(url.toString(), { method: 'GET', headers: { Accept: IMAGE_TYPES.join(', ') }, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal }); }
      catch (error) { if (error instanceof JiraAuthenticationError) throw error; throw new Error(controller.signal.aborted ? 'Jira 图片下载超过 15 秒，请重试' : 'Jira 图片下载失败，请检查网络或附件地址；不允许重定向'); }
      if (/AUTHENTICATION_DENIED|CAPTCHA/i.test(response.headers.get('x-seraph-loginreason') ?? '')) throw new Error('Jira 图片下载要求重新登录或完成验证码');
      if (response.status === 401) throw new Error('Jira 图片下载认证失败，请检查账号、密码或 Token');
      if (response.status === 403) throw new Error('当前 Jira 账号无权读取该图片附件');
      if (response.status === 404) throw new Error('Jira 图片附件不存在或当前账号无权查看');
      if (!response.ok) throw new Error('Jira 图片下载失败，服务器未返回可读取的图片');
      const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
      if (!IMAGE_TYPES.includes(mimeType)) throw new Error('Jira 附件未返回支持的图片 MIME，拒绝 SVG、HTML 或登录页面');
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_JIRA_IMAGE_BYTES)) throw new Error('Jira 图片超过每张 8 MiB 限制或响应大小无效');
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Jira 图片返回空响应');
      try {
        while (true) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try { part = await reader.read(); } catch { throw new Error(controller.signal.aborted ? 'Jira 图片下载超过 15 秒，请重试' : 'Jira 图片传输中断，请重试'); }
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_JIRA_IMAGE_BYTES) throw new Error('Jira 图片超过每张 8 MiB 限制');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = Buffer.concat(chunks, size);
      const image = inspectJiraImage(bytes, mimeType);
      // JPEG EOI 后允许最多 64 KiB 尾元数据，但不将尾内容带入缓存、界面和模型。
      return { bytes: bytes.subarray(0, image.imageBytes), mimeType: image.mimeType };
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    }
  }

  async listProjects(): Promise<JiraProject[]> {
    const data = await this.get('project');
    if (!Array.isArray(data) || data.length > 5000) throw new Error('Jira 项目列表格式异常或超过 5000 项，请联系管理员检查');
    const ids = new Set<string>();
    const keys = new Set<string>();
    return data.map(item => {
      if (!object(item) || typeof item.id !== 'string' || !/^\d{1,32}$/.test(item.id) || typeof item.key !== 'string' || !PROJECT_KEY.test(item.key) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256 || /[\x00-\x1f\x7f]/.test(item.name) || ids.has(item.id) || keys.has(item.key)) throw new Error('Jira 项目列表包含无效或重复项目，未展示不完整列表');
      ids.add(item.id); keys.add(item.key);
      return { id: item.id, key: item.key, name: this.text(item.name) };
    });
  }

  private queryProject(value: unknown): string {
    if (value === undefined) return this.projectKey;
    if (value === '*') return value;
    if (typeof value !== 'string' || !PROJECT_KEY.test(value.toUpperCase())) throw new Error('Jira 查询项目 Key 无效，须为最多 64 位英文字母、数字和下划线，或选择所有可访问项目');
    return value.toUpperCase();
  }

  async searchIssues(input: JiraSearchInput): Promise<JiraSearchPage> {
    if (!input || typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number(input.date.slice(0, 4)) < 1000) throw new Error('请选择有效的查询日期，格式为 YYYY-MM-DD');
    const scope = input.scope === undefined ? 'daily' : input.scope;
    if (scope !== 'daily' && scope !== 'recent') throw new Error('Jira 查询范围无效，请选择日报任务或最近任务');
    const projectKey = this.queryProject(input.projectKey);
    const date = new Date(`${input.date}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date) throw new Error('查询日期不存在，请重新选择日期');
    const nextDate = new Date(date.getTime() + 86400000).toISOString().slice(0, 10);
    if (!/^\d{4}-/.test(nextDate)) throw new Error('查询日期超出支持范围');
    const startAt = input.startAt ?? 0;
    if (!integer(startAt, 1000000) || (input.onlyMine !== undefined && typeof input.onlyMine !== 'boolean')) throw new Error('Jira 分页或负责人筛选参数无效');
    const connection = await this.metadata();
    const dateClause = connection.fieldType === 'date' ? `cf[${this.dateFieldId}] = "${input.date}"` : `cf[${this.dateFieldId}] >= "${input.date} 00:00" AND cf[${this.dateFieldId}] < "${nextDate} 00:00"`;
    const clauses = [...(projectKey === '*' ? [] : [`project = "${projectKey}"`]), ...(scope === 'daily' ? [dateClause] : []), ...(input.onlyMine ? ['assignee = currentUser()'] : [])];
    const jql = `${clauses.length ? `${clauses.join(' AND ')} ` : ''}ORDER BY updated DESC, key ASC`;
    const query = new URLSearchParams({ jql, startAt: String(startAt), maxResults: String(PAGE_SIZE), fields: this.fields() });
    const data = await this.get('search', query);
    if (!object(data) || !Array.isArray(data.issues) || !integer(data.startAt, 1000000) || data.startAt !== startAt || !integer(data.maxResults, 1000) || !integer(data.total, 100000000) || data.issues.length > PAGE_SIZE || data.issues.length > data.maxResults || (!data.maxResults && data.total > startAt) || (!data.issues.length && data.total > startAt)) throw new Error('Jira 返回的分页数据异常，请重新查询；未展示不完整任务列表');
    const fetchedAt = new Date().toISOString();
    return { issues: data.issues.map(item => this.issue(item, fetchedAt, projectKey)), startAt: data.startAt, maxResults: data.maxResults, total: data.total, isLast: data.startAt + data.maxResults >= data.total, jql, timeZone: connection.timeZone, fetchedAt };
  }

  async getIssue(key: string, selectedProject?: string): Promise<JiraIssue> {
    const projectKey = this.queryProject(selectedProject);
    if (typeof key !== 'string' || !ISSUE_KEY.test(key) || (projectKey !== '*' && ISSUE_KEY.exec(key)![1] !== projectKey)) throw new Error('任务 Key 无效或不属于配置的 Jira 项目');
    const issue = this.issue(await this.get(`issue/${encodeURIComponent(key)}`, new URLSearchParams({ fields: this.fields() })), new Date().toISOString(), projectKey);
    if (issue.key !== key) throw new Error('Jira 返回的任务 Key 与所选任务不一致，已拒绝保存或展示');
    return issue;
  }

  private fields(): string { return `summary,description,issuetype,status,priority,assignee,reporter,updated,attachment,customfield_${this.dateFieldId}`; }

  private description(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return this.text(value);
    if (!object(value) || value.type !== 'doc') throw new Error('Jira 任务描述格式无法识别，未展示不完整描述');
    let nodes = 0;
    const walk = (node: unknown, depth: number): string => {
      if (++nodes > 50000 || depth > 32 || !object(node)) throw new Error('Jira 描述结构过于复杂，请在 Jira 网页查看完整任务');
      if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
      if (node.type === 'hardBreak') return '\n';
      const content = Array.isArray(node.content) ? node.content.map(child => walk(child, depth + 1)).join('') : '';
      return content + (['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type) ? '\n' : '');
    };
    return this.text(walk(value, 0).trimEnd());
  }

  private issue(value: unknown, fetchedAt: string, projectKey: string): JiraIssue {
    if (!object(value) || typeof value.id !== 'string' || !value.id || typeof value.key !== 'string' || !ISSUE_KEY.test(value.key) || !object(value.fields)) throw new Error('Jira 返回的任务结构无效，未将错误响应作为任务展示');
    if (projectKey !== '*' && ISSUE_KEY.exec(value.key)![1] !== projectKey) throw new Error('Jira 返回配置项目之外的任务，已拒绝展示');
    const fields = value.fields;
    const named = (item: unknown) => object(item) ? this.text(item.displayName) || this.text(item.name) : '';
    const attachments = Array.isArray(fields.attachment) ? fields.attachment.map(item => {
      if (!object(item) || typeof item.id !== 'string' || typeof item.filename !== 'string' || !integer(item.size, Number.MAX_SAFE_INTEGER)) throw new Error('Jira 附件元数据异常，请在 Jira 网页核对');
      let url = '';
      try {
        const candidate = new URL(item.content, `${this.baseUrl}/`);
        const base = new URL(this.baseUrl);
        if (['http:', 'https:'].includes(candidate.protocol) && candidate.origin === base.origin && !candidate.username && !candidate.password && candidate.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) url = candidate.toString();
      } catch { /* 不将不安全或外站附件地址交给桌面端。 */ }
      return { id: this.text(item.id), name: this.text(item.filename), mimeType: this.text(item.mimeType), size: item.size, url };
    }) : [];
    return { id: this.text(value.id), key: value.key, summary: this.text(fields.summary), description: this.description(fields.description), status: named(fields.status), issueType: named(fields.issuetype), priority: named(fields.priority) || undefined, assignee: named(fields.assignee) || undefined, reporter: named(fields.reporter) || undefined, updated: this.text(fields.updated) || undefined, url: `${this.baseUrl}/browse/${encodeURIComponent(value.key)}`, attachments, fetchedAt };
  }
}

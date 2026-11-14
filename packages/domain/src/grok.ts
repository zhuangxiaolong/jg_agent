export type GrokApiBackend = 'chat_completions' | 'responses' | 'messages';
export interface GrokRuntimeSettings { enabled: boolean; executablePath: string; proxyUrl?: string }
export interface GrokCompatibilityResult { level: 'untested' | 'text' | 'agent'; status: 'passed' | 'failed'; checkedAt: string; detail: string }
export interface GrokModelProfile { id: string; name: string; apiBackend: GrokApiBackend; enabled: boolean; compatibility?: GrokCompatibilityResult }
export interface GrokProviderProfile { id: string; name: string; baseUrl: string; enabled: boolean; hasKey: boolean; models: GrokModelProfile[] }
export interface GrokSettingsSnapshot { runtime: GrokRuntimeSettings; providers: GrokProviderProfile[] }
export interface GrokManagerApi {
  saveRuntime(input: GrokRuntimeSettings): Promise<GrokRuntimeSettings>;
  saveModels(providerId: string, models: Array<{ id: string; apiBackend: GrokApiBackend }>): Promise<GrokProviderProfile>;
  testConnection(providerId: string, modelId: string): Promise<GrokCompatibilityResult>;
}

const secretPattern = /(?:\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;}]{6,})/i;
const controlPattern = /[\x00-\x1f\x7f]/;

export function grokMetadataText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || controlPattern.test(value) || secretPattern.test(value) || (!allowEmpty && !value.trim())) throw new Error(`${label}无效或包含未脱敏凭据`);
  return value.trim();
}

export function grokProfileId(value: unknown): string {
  if (typeof value !== 'string' || (value !== 'legacy-default' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))) throw new Error('Grok 中转站标识无效');
  return value;
}

/** 只对根地址补 /v1；用户提供的网关路径保持不变。 */
export function normalizeGrokBaseUrl(value: unknown): string {
  const text = grokMetadataText(value, 'Grok Base URL', 2000);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error('Grok Base URL 必须为有效 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Grok Base URL 必须为不含用户名、密码、查询参数或片段的 HTTPS 地址');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/v1';
  return url.toString().replace(/\/$/, '');
}

export function safeGrokRuntime(value: GrokRuntimeSettings): GrokRuntimeSettings {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new Error('Grok Runtime 配置无效');
  const executablePath = grokMetadataText(value.executablePath, 'Grok 可执行文件路径', 2048, true);
  if (value.enabled && !executablePath) throw new Error('启用 Grok Runtime 前请填写可执行文件路径');
  if (executablePath && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/]|\/)/.test(executablePath)) throw new Error('Grok 可执行文件必须使用绝对路径');
  const result: GrokRuntimeSettings = { enabled: value.enabled, executablePath };
  if (value.proxyUrl !== undefined && value.proxyUrl !== '') {
    const text = grokMetadataText(value.proxyUrl, 'Grok 代理地址', 2000);
    let url: URL;
    try { url = new URL(text); } catch { throw new Error('Grok 代理地址无效'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Grok 代理仅支持无凭据、查询参数及路径的 HTTP/HTTPS 地址');
    result.proxyUrl = url.toString().replace(/\/$/, '');
  }
  return result;
}

export function safeGrokCompatibility(value: GrokCompatibilityResult): GrokCompatibilityResult {
  if (!value || !['untested', 'text', 'agent'].includes(value.level) || !['passed', 'failed'].includes(value.status) || typeof value.checkedAt !== 'string' || value.checkedAt.length > 80 || Number.isNaN(Date.parse(value.checkedAt))) throw new Error('Grok 兼容性记录无效');
  return { level: value.level, status: value.status, checkedAt: value.checkedAt, detail: grokMetadataText(value.detail, 'Grok 兼容性说明', 2000, true) };
}

export function safeGrokModel(value: GrokModelProfile): GrokModelProfile {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[A-Za-z0-9._:/-]{1,160}$/.test(value.id) || !['chat_completions', 'responses', 'messages'].includes(value.apiBackend) || typeof value.enabled !== 'boolean') throw new Error('Grok 模型配置无效');
  const result: GrokModelProfile = { id: grokMetadataText(value.id, 'Grok 模型 ID', 160), name: grokMetadataText(value.name, 'Grok 模型名称', 240), apiBackend: value.apiBackend, enabled: value.enabled };
  if (value.compatibility !== undefined) result.compatibility = safeGrokCompatibility(value.compatibility);
  return result;
}

/** 存储层重新投影全部字段，不接纳附加凭据属性或 hasKey 声明。 */
export function safeGrokProvider(value: GrokProviderProfile): GrokProviderProfile {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || !Array.isArray(value.models) || value.models.length > 100) throw new Error('Grok 中转站配置无效');
  const models = value.models.map(safeGrokModel);
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('同一 Grok 中转站的模型 ID 不能重复');
  return { id: grokProfileId(value.id), name: grokMetadataText(value.name, 'Grok 中转站名称', 80), baseUrl: normalizeGrokBaseUrl(value.baseUrl), enabled: value.enabled, hasKey: false, models };
}

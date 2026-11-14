import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ReasoningEffort } from '../../domain/src/index';
import { buildRuntimeExecutionInstructions } from './execution-instructions';

export const GROK_BUILD_RUNTIME_VERSION = '1.0.67';
export const GROK_RELAY_MODEL_ALIAS = 'jinggong-relay';
export const GROK_CREDENTIAL_ENV = 'JINGGONG_GROK_API_KEY';
export const GROK_EXECUTION_RULES_VERSION = 2;
const reasoningEfforts: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** 减少简单联网查询的重复取数和 Shell 纠错轮次，不覆盖用户选择的推理强度。 */
export function grokExecutionInstructions(instructions?: string, platform = process.platform): string {
  return buildRuntimeExecutionInstructions(instructions, platform);
}

export interface GrokRuntimeOptions {
  executable: string;
  home: string;
  baseUrl: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  apiKey?: string;
  apiBackend: 'chat_completions' | 'responses' | 'messages';
  proxyUrl?: string;
  developerInstructions?: string;
}

export function grokBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Grok 中转站必须是无凭据、查询参数和片段的 HTTPS 地址');
  if (url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/$/, '');
}

function proxy(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Grok 代理必须是无凭据的 HTTP/HTTPS 代理地址');
  return url.toString().replace(/\/$/, '');
}

export function validateGrokOptions(options: GrokRuntimeOptions): void {
  if (!path.isAbsolute(options.executable) || !path.isAbsolute(options.home) || /[\x00-\x1f]/.test(options.executable + options.home)) throw new Error('Grok 可执行文件和受管配置目录必须是有效绝对路径');
  grokBaseUrl(options.baseUrl);
  if (!['chat_completions', 'responses', 'messages'].includes(options.apiBackend)) throw new Error('不支持的 Grok API backend');
  if (!options.model.trim() || options.model.length > 256 || /[\x00-\x1f]/.test(options.model)) throw new Error('Grok 模型 ID 无效');
  if (options.reasoningEffort !== undefined && !reasoningEfforts.includes(options.reasoningEffort)) throw new Error('Grok 模型推理强度无效，请选择支持的档位；不会自动降档');
  if (options.apiKey && /[\x00-\x1f]/.test(options.apiKey)) throw new Error('Grok API Key 含非法控制字符');
  if (options.proxyUrl) proxy(options.proxyUrl);
  if (options.developerInstructions && Buffer.byteLength(options.developerInstructions, 'utf8') > 2 * 1024 * 1024) throw new Error('Grok 开发要求超过 2 MiB，不会静默截断');
  if (options.apiKey && [options.executable, options.home, options.baseUrl, options.model, options.proxyUrl, options.developerInstructions].some(value => value?.includes(options.apiKey!))) throw new Error('Grok 配置或开发要求包含模型凭据，已拒绝写入');
  for (const originalHome of [process.env.USERPROFILE, process.env.HOME]) {
    if (originalHome && samePath(options.home, path.join(originalHome, '.grok'))) throw new Error('Grok 必须使用精工受管目录，不得覆盖用户 .grok');
  }
}

export function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b); }
export function withinPath(root: string, target: string): boolean { const relative = path.relative(root, target); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }

/** 配置目录逐段拒绝链接，避免覆盖用户配置或跟随被替换的目录。 */
export async function ensureGrokDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Grok 配置目录不允许链接或非目录节点');
  }
  return realpath(absolute);
}

/** 使用受管环境与专用模型凭据；工具按用户授权直接执行，并非 Windows OS 沙箱。 */
export function buildGrokEnvironment(options: GrokRuntimeOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allow = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|COMMONPROGRAMW6432|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|LC_CTYPE|TERM|TZ|DOTNET_ROOT(?:\(X86\))?|JAVA_HOME|MAVEN_HOME|M2_HOME|GRADLE_HOME|GOROOT|ANDROID_HOME|ANDROID_SDK_ROOT|VSINSTALLDIR|VCINSTALLDIR|VCTOOLSINSTALLDIR|WINDOWSSDKDIR|WINDOWSSDKVERSION|UNIVERSALCRTSDKDIR|UCRTVERSION|INCLUDE|LIB|LIBPATH)$/i;
  for (const [name, value] of Object.entries(process.env)) if (allow.test(name) && value !== undefined) environment[name.toUpperCase()] = value;
  const profile = path.join(options.home, 'profile');
  // 保持 folder-trust gate 启用；不传 --trust，避免项目 hooks/MCP/skills 影响受管会话。
  Object.assign(environment, { GROK_HOME: options.home, USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local'), GROK_DISABLE_AUTOUPDATER: '1', GROK_FOLDER_TRUST: '1', GROK_ERROR_REPORTING: '0', DISABLE_ERROR_REPORTING: '1' });
  if (process.platform === 'win32') {
    const windows = environment.SYSTEMROOT ?? environment.WINDIR ?? 'C:\\Windows';
    environment.PATH = [...new Set([path.join(windows, 'System32'), path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0'), ...(environment.PATH ?? '').split(';').filter(Boolean)])].join(';');
    environment.SYSTEMROOT = windows; environment.WINDIR = windows;
    environment.COMSPEC = path.join(windows, 'System32', 'cmd.exe');
    environment.PATHEXT ??= '.COM;.EXE;.BAT;.CMD';
    environment.GROK_SHELL = 'powershell';
  }
  if (options.proxyUrl) environment.HTTPS_PROXY = environment.HTTP_PROXY = proxy(options.proxyUrl);
  if (options.apiKey) environment[GROK_CREDENTIAL_ENV] = options.apiKey;
  return environment;
}

export function grokConfigToml(options: GrokRuntimeOptions): string {
  validateGrokOptions(options);
  // 未声明菜单时原生请求不带 effort，冷恢复也不会沿用旧会话的显式档位。
  const reasoningMenu = options.reasoningEffort === undefined ? '' : `reasoning_efforts = [${reasoningEfforts.map(value => `{ value = ${JSON.stringify(value)}, label = ${JSON.stringify(value)} }`).join(', ')}]\n`;
  return `[cli]\nauto_update = false\n[models]\ndefault = ${JSON.stringify(GROK_RELAY_MODEL_ALIAS)}\n[model.${GROK_RELAY_MODEL_ALIAS}]\nmodel = ${JSON.stringify(options.model)}\nbase_url = ${JSON.stringify(grokBaseUrl(options.baseUrl))}\napi_backend = ${JSON.stringify(options.apiBackend)}\nenv_key = ${JSON.stringify(GROK_CREDENTIAL_ENV)}\n${reasoningMenu}[features]\nremote_fetch = false\ntelemetry = false\n[diagnostics]\nerror_reporting = false\n[ui]\npermission_mode = "always-approve"\n[sandbox]\nprofile = "off"\n[shell_environment_policy]\ninherit = "core"\nignore_default_excludes = false\nexclude = ["${GROK_CREDENTIAL_ENV}", "XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_AUTH", "HTTP_PROXY", "HTTPS_PROXY"]\n[toolset.bash]\nlogin_shell_capture = false\n[compat.claude]\nagents = false\nrules = false\nhooks = false\nskills = false\nmcps = false\n[compat.cursor]\nagents = false\nrules = false\nhooks = false\nskills = false\nmcps = false\n[compat.codex]\nhooks = false\nskills = false\n[telemetry]\notel_enabled = false\ntrace_upload = false\n`;
}

export const GROK_MANAGED_POLICY = 'allow_managed_hooks_only = true\nallow_managed_mcp_servers_only = true\nenable_all_project_mcp_servers = false\nstrict_known_marketplaces = []\n';

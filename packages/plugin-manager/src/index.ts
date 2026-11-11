import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const PLUGIN_MANAGER_LIMITS = {
  maxArchiveBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxFiles: 2_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
} as const;

export type PluginErrorCode =
  | 'PLUGIN_ARCHIVE_INVALID' | 'PLUGIN_ARCHIVE_LIMIT_EXCEEDED' | 'PLUGIN_PATH_TRAVERSAL_BLOCKED'
  | 'PLUGIN_MANIFEST_MISSING' | 'PLUGIN_MANIFEST_INVALID' | 'PLUGIN_MANIFEST_CONFLICT'
  | 'PLUGIN_SKILL_INVALID' | 'PLUGIN_DUPLICATE_NAME' | 'MCP_CONFIG_INVALID';

export class PluginManagerError extends Error {
  readonly code: PluginErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly suggestedAction?: string;

  constructor(code: PluginErrorCode, message: string, details?: unknown, retryable = false, suggestedAction?: string) {
    super(message);
    this.name = 'PluginManagerError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.suggestedAction = suggestedAction;
  }
}

export interface PluginArchiveLimits {
  maxArchiveBytes?: number;
  maxExpandedBytes?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxCompressionRatio?: number;
}

export interface PluginDiagnostic {
  code: string;
  message: string;
  paths?: string[];
  severity: 'warning' | 'error';
}

export interface NormalizedPluginManifest {
  name: string;
  version: string;
  description: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  sourceManifest: 'portable' | 'codex-compat';
  rootPath: string;
  skillsRoot?: string;
  mcpConfigPath?: string;
  hooksConfigPaths: string[];
  hasOptionalUi: boolean;
  unknownExtensions: string[];
  rawManifestHash: string;
  raw: Record<string, unknown>;
}

export interface SkillResource { kind: 'reference' | 'script' | 'asset'; relativePath: string }
export interface SkillDescriptor {
  id: string;
  pluginId: string;
  name: string;
  description: string;
  skillDir: string;
  skillFile: string;
  contentHash: string;
  resources: SkillResource[];
  supportedRuntimes: Array<'codex' | 'jinggong' | 'claude_agent_sdk'>;
  metadata: Record<string, unknown>;
}

export interface NormalizedMcpServer {
  id: string;
  pluginId: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  envRefs?: Record<string, string>;
  httpHeaderRefs?: Record<string, string>;
  enabled: boolean;
  requiresUserTrust: boolean;
  redactedConfig: Record<string, unknown>;
}

export interface PluginFile { path: string; bytes: Uint8Array; mode?: number; isDirectory?: boolean }
export interface PluginPackageInspection {
  rootPath: string;
  sourceType: 'zip' | 'directory';
  files: PluginFile[];
  manifest: NormalizedPluginManifest;
  skills: SkillDescriptor[];
  mcpServers: NormalizedMcpServer[];
  hooks: string[];
  executableResources: string[];
  diagnostics: PluginDiagnostic[];
}

interface ZipEntry {
  path: string;
  compressedSize: number;
  expandedSize: number;
  crc: number;
  compression: number;
  localOffset: number;
  dataOffset: number;
  localEnd: number;
  isDirectory: boolean;
  mode?: number;
}

function limitsOf(input?: PluginArchiveLimits): Required<PluginArchiveLimits> {
  return { ...PLUGIN_MANAGER_LIMITS, ...(input ?? {}) };
}

function fail(code: PluginErrorCode, message: string, details?: unknown): never {
  throw new PluginManagerError(code, message, details);
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseJson(bytes: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PLUGIN_MANIFEST_INVALID', `${label} 必须是 JSON 对象`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PluginManagerError) throw error;
    fail(label.includes('mcp') ? 'MCP_CONFIG_INVALID' : 'PLUGIN_MANIFEST_INVALID', `${label} JSON 无法解析`);
  }
}

function normalizePath(raw: string): string {
  if (!raw || raw.includes('\0')) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `插件路径无效：${raw}`);
  const value = raw.replaceAll('\\', '/');
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `禁止绝对路径：${raw}`);
  const pieces = value.split('/');
  if (pieces.some(piece => piece === '..')) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `禁止路径穿越：${raw}`);
  if (pieces.some(piece => /[<>:"|?*\u0000-\u001f]/.test(piece) || /[. ]$/.test(piece) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece))) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `路径包含 Windows 不安全文件名：${raw}`);
  if (pieces.some(piece => piece === '')) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `路径包含空段：${raw}`);
  const normalized = pieces.filter(piece => piece !== '.').join('/');
  if (!normalized) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `插件路径为空：${raw}`);
  return normalized;
}

function ensureRelativeReference(value: string, field: string): string {
  try { return normalizePath(value); } catch (error) {
    if (error instanceof PluginManagerError) throw new PluginManagerError('PLUGIN_MANIFEST_INVALID', `${field} 路径无效`, error.message);
    throw error;
  }
}

function validateManifestPaths(value: unknown, parentKey = ''): void {
  if (Array.isArray(value)) { for (const item of value) validateManifestPaths(item, parentKey); return; }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && /^(skills?|hooks?|mcp|ui|assets?|scripts?|path|file|directory|root)$/i.test(parentKey)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) fail('PLUGIN_MANIFEST_INVALID', `本地路径字段 ${parentKey} 不允许远程 URL`);
      ensureRelativeReference(value, parentKey);
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) validateManifestPaths(child, key);
}

function parseManifest(files: Map<string, PluginFile>, rootPath: string, diagnostics: PluginDiagnostic[]): NormalizedPluginManifest {
  const portable = files.get('plugin.json');
  const compat = files.get('.codex-plugin/plugin.json');
  if (!portable && !compat) fail('PLUGIN_MANIFEST_MISSING', '插件缺少 plugin.json 或 .codex-plugin/plugin.json');
  const portableJson = portable ? parseJson(portable.bytes, 'plugin.json') : undefined;
  const compatJson = compat ? parseJson(compat.bytes, '.codex-plugin/plugin.json') : undefined;
  if (portableJson && compatJson && canonicalJson(portableJson) !== canonicalJson(compatJson)) {
    diagnostics.push({ code: 'PLUGIN_MANIFEST_CONFLICT', message: 'portable 与 Codex 兼容 Manifest 内容冲突，已保留冲突诊断并采用 portable', paths: ['plugin.json', '.codex-plugin/plugin.json'], severity: 'error' });
  }
  const raw = portableJson ?? compatJson!;
  validateManifestPaths(raw);
  const sourceManifest = portableJson ? 'portable' : 'codex-compat';
  const required = ['name', 'version', 'description'] as const;
  for (const field of required) if (typeof raw[field] !== 'string' || !(raw[field] as string).trim()) fail('PLUGIN_MANIFEST_INVALID', `Manifest 字段 ${field} 必须是非空字符串`);
  if (!/^[^\\/:*?"<>|\u0000-\u001f]{1,100}$/.test(raw.name as string)) fail('PLUGIN_MANIFEST_INVALID', 'Manifest name 含非法字符');
  const author = raw.author;
  let normalizedAuthor: NormalizedPluginManifest['author'];
  if (typeof author === 'string') normalizedAuthor = { name: author };
  else if (author && typeof author === 'object' && !Array.isArray(author)) normalizedAuthor = { name: typeof (author as any).name === 'string' ? (author as any).name : undefined, email: typeof (author as any).email === 'string' ? (author as any).email : undefined, url: typeof (author as any).url === 'string' ? (author as any).url : undefined };
  const hooks = files.keys();
  const hookPaths = [...hooks].filter(path => path.startsWith('hooks/') || path.startsWith('.codex-plugin/hooks/'));
  const unknown = Object.keys(raw).filter(key => !['name', 'version', 'description', 'author', 'homepage', 'repository', 'skills', 'mcp', 'hooks', 'ui'].includes(key));
  return {
    name: raw.name as string, version: raw.version as string, description: raw.description as string,
    author: normalizedAuthor, homepage: typeof raw.homepage === 'string' ? raw.homepage : undefined, repository: typeof raw.repository === 'string' ? raw.repository : undefined,
    sourceManifest, rootPath, skillsRoot: files.has('skills') || [...files.keys()].some(path => path.startsWith('skills/')) ? 'skills' : undefined,
    mcpConfigPath: files.has('mcp.json') ? 'mcp.json' : files.has('.mcp.json') ? '.mcp.json' : undefined,
    hooksConfigPaths: [...new Set(hookPaths)], hasOptionalUi: files.has('ui') || [...files.keys()].some(path => path.startsWith('ui/')),
    unknownExtensions: unknown, rawManifestHash: hash((portable ?? compat!).bytes), raw: redactValue(raw, '', {}) as Record<string, unknown>,
  };
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true';
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1).split(',').map(item => parseScalar(item.trim())).filter(item => item !== '');
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const entries = trimmed.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean).map(item => {
      const colon = item.indexOf(':'); return colon > 0 ? [item.slice(0, colon).trim(), parseScalar(item.slice(colon + 1))] as const : undefined;
    }).filter((item): item is readonly [string, unknown] => !!item);
    return Object.fromEntries(entries);
  }
  return trimmed;
}

function parseFrontmatter(text: string, skillPath: string): Record<string, unknown> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') fail('PLUGIN_SKILL_INVALID', `Skill ${skillPath} 缺少 YAML frontmatter`);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) fail('PLUGIN_SKILL_INVALID', `Skill ${skillPath} frontmatter 未闭合`);
  const tokens = lines.slice(1, end).map((line, index) => ({ line: index + 2, indent: line.match(/^ */)?.[0].length ?? 0, text: line.trim() })).filter(token => token.text && !token.text.startsWith('#'));
  let cursor = 0;
  function parseBlock(indent: number): unknown {
    const isArray = tokens[cursor]?.indent === indent && tokens[cursor]?.text.startsWith('- ');
    const result: Record<string, unknown> | unknown[] = isArray ? [] : {};
    while (cursor < tokens.length && tokens[cursor].indent === indent) {
      const token = tokens[cursor++];
      if (isArray) {
        if (!token.text.startsWith('- ')) fail('PLUGIN_SKILL_INVALID', `Skill ${skillPath} frontmatter 行 ${token.line} 混用数组和对象`);
        const value = token.text.slice(2).trim();
        if (value) (result as unknown[]).push(parseScalar(value));
        else if (cursor < tokens.length && tokens[cursor].indent > indent) (result as unknown[]).push(parseBlock(tokens[cursor].indent));
        else (result as unknown[]).push(null);
        continue;
      }
      const colon = token.text.indexOf(':');
      if (colon <= 0) fail('PLUGIN_SKILL_INVALID', `Skill ${skillPath} frontmatter 行 ${token.line} 无效`);
      const key = token.text.slice(0, colon).trim(); const value = token.text.slice(colon + 1).trim();
      if (!value) {
        if (cursor < tokens.length && tokens[cursor].indent > indent) (result as Record<string, unknown>)[key] = parseBlock(tokens[cursor].indent);
        else (result as Record<string, unknown>)[key] = '';
      } else if (/^[|>][+-]?$/.test(value)) {
        const continuation: string[] = [];
        while (cursor < tokens.length && tokens[cursor].indent > indent) continuation.push(tokens[cursor++].text);
        (result as Record<string, unknown>)[key] = value.startsWith('|') ? continuation.join('\n') : continuation.join(' ');
      } else (result as Record<string, unknown>)[key] = parseScalar(value);
    }
    return result;
  }
  if (tokens.length === 0) return {};
  const metadata = parseBlock(tokens[0].indent);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('PLUGIN_SKILL_INVALID', `Skill ${skillPath} frontmatter 顶层必须是字段对象`);
  return metadata as Record<string, unknown>;
}

function discoverSkills(files: Map<string, PluginFile>, pluginId: string): SkillDescriptor[] {
  const skillFiles = [...files.entries()].filter(([path]) => /^skills\/[^/]+\/SKILL\.md$/.test(path));
  const names = new Set<string>();
  return skillFiles.map(([skillFile, file]) => {
    const skillDir = skillFile.slice(0, skillFile.lastIndexOf('/'));
    const metadata = parseFrontmatter(new TextDecoder().decode(file.bytes), skillFile);
    if (typeof metadata.name !== 'string' || !metadata.name.trim() || typeof metadata.description !== 'string' || !metadata.description.trim()) fail('PLUGIN_SKILL_INVALID', `Skill ${skillFile} 必须包含 name 和 description`);
    if (names.has(metadata.name)) fail('PLUGIN_DUPLICATE_NAME', `插件内 Skill 名称重复：${metadata.name}`);
    names.add(metadata.name);
    const resources: SkillResource[] = [];
    for (const path of files.keys()) {
      if (!path.startsWith(`${skillDir}/`) || path === skillFile) continue;
      const relativePath = path.slice(skillDir.length + 1);
      const first = relativePath.split('/')[0];
      const kind: SkillResource['kind'] = first === 'scripts' ? 'script' : first === 'assets' ? 'asset' : 'reference';
      resources.push({ kind, relativePath });
    }
    return { id: `${pluginId}:${metadata.name}`, pluginId, name: metadata.name, description: metadata.description, skillDir, skillFile, contentHash: hash(file.bytes), resources, supportedRuntimes: ['codex'], metadata };
  });
}

function envReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
  return match ? `env:${match[1]}` : undefined;
}

function redactValue(value: unknown, key: string, refs: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const ref = envReference(value);
    if (ref) { refs[key] = ref; return value; }
    if (/(token|secret|password|passwd|api.?key|authorization|credential|private.?key)/i.test(key)) return '<redacted>';
    return value
      .replace(/((?:--?|\/)(?:token|secret|password|api[-_]?key|authorization)(?:=|\s+))[^\s]+/gi, '$1<redacted>')
      .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer <redacted>')
      .replace(/(Authorization\s*:\s*)[^\s,;"']+/gi, '$1<redacted>');
  }
  if (Array.isArray(value)) {
    let redactNext = false;
    return value.map(item => {
      if (redactNext) { redactNext = false; return '<redacted>'; }
      if (typeof item === 'string' && /^--?(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)$/i.test(item)) { redactNext = true; return item; }
      return redactValue(item, key, refs);
    });
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => {
    if ((childKey === 'env' || childKey === 'headers') && childValue && typeof childValue === 'object' && !Array.isArray(childValue)) {
      const safeValues = Object.fromEntries(Object.entries(childValue as Record<string, unknown>).map(([name, item]) => [name, envReference(item) ? item : typeof item === 'string' ? '<redacted>' : redactValue(item, name, refs)]));
      return [childKey, safeValues];
    }
    return [childKey, redactValue(childValue, childKey, refs)];
  }));
  return value;
}

export function parseMcpConfig(input: Record<string, unknown>, pluginId: string): NormalizedMcpServer[] {
  const source = input.mcpServers && typeof input.mcpServers === 'object' && !Array.isArray(input.mcpServers) ? input.mcpServers as Record<string, unknown> : input;
  const servers: NormalizedMcpServer[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('MCP_CONFIG_INVALID', `MCP Server ${name} 配置必须是对象`);
    const config = value as Record<string, unknown>;
    const type = typeof config.type === 'string' ? config.type : undefined;
    const hasUrl = typeof config.url === 'string';
    const transport = hasUrl || type === 'streamable-http' || type === 'http' ? 'streamable-http' : type && type !== 'stdio' ? undefined : 'stdio';
    if (!transport) fail('MCP_CONFIG_INVALID', `MCP Server ${name} 使用不支持的传输类型：${type}`);
    const envRefs: Record<string, string> = {};
    const headerRefs: Record<string, string> = {};
    const redactedConfig = redactValue(config, '', {}) as Record<string, unknown>;
    if (config.env && typeof config.env === 'object' && !Array.isArray(config.env)) {
      for (const [envName, value] of Object.entries(config.env as Record<string, unknown>)) { const ref = envReference(value); if (ref) envRefs[envName] = ref; }
    }
    if (transport === 'stdio') {
      if (typeof config.command !== 'string' || !config.command.trim()) fail('MCP_CONFIG_INVALID', `stdio Server ${name} 缺少 command`);
      if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(item => typeof item !== 'string'))) fail('MCP_CONFIG_INVALID', `stdio Server ${name} args 必须是字符串数组`);
      if (config.cwd !== undefined && typeof config.cwd !== 'string') fail('MCP_CONFIG_INVALID', `stdio Server ${name} cwd 必须是字符串`);
    } else {
      let url: URL;
      try { url = new URL(config.url as string); } catch { fail('MCP_CONFIG_INVALID', `HTTP Server ${name} URL 无效`); }
      if (url!.username || url!.password || [...url!.searchParams.keys()].some(key => /(token|secret|password|api.?key|authorization|credential)/i.test(key))) fail('MCP_CONFIG_INVALID', `HTTP Server ${name} URL 含内嵌凭据，请改用受控凭据引用`);
      const local = ['localhost', '127.0.0.1', '::1'].includes(url!.hostname);
      if (url!.protocol !== 'https:' && !local) fail('MCP_CONFIG_INVALID', `HTTP Server ${name} 必须使用 HTTPS（本地开发地址除外）`);
      if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) for (const [header, headerValue] of Object.entries(config.headers as Record<string, unknown>)) { const ref = envReference(headerValue); if (ref) headerRefs[header] = ref; }
    }
    servers.push({ id: `${pluginId}:${name}`, pluginId, name, transport, command: typeof config.command === 'string' ? config.command : undefined, args: Array.isArray(config.args) ? config.args as string[] : undefined, cwd: typeof config.cwd === 'string' ? config.cwd : undefined, url: typeof config.url === 'string' ? config.url : undefined, envRefs: Object.keys(envRefs).length ? envRefs : undefined, httpHeaderRefs: Object.keys(headerRefs).length ? headerRefs : undefined, enabled: false, requiresUserTrust: true, redactedConfig });
  }
  return servers;
}

function inspectFiles(files: PluginFile[], rootPath: string, sourceType: 'zip' | 'directory'): PluginPackageInspection {
  const map = new Map<string, PluginFile>();
  const diagnostics: PluginDiagnostic[] = [];
  const executableResources: string[] = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    const key = path.toLowerCase();
    if ([...map.keys()].some(existing => existing.toLowerCase() === key)) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `插件包含重复目标路径：${path}`);
    if (file.isDirectory) continue;
    map.set(path, { ...file, path });
    if (file.mode !== undefined && (file.mode & 0o111) !== 0) executableResources.push(path);
    if (/\.(exe|cmd|bat|ps1|sh|com)$/i.test(path)) executableResources.push(path);
  }
  const filePaths = [...map.keys()].map(path => path.toLowerCase());
  for (const path of filePaths) {
    const segments = path.split('/');
    for (let index = 1; index < segments.length; index++) if (map.has(segments.slice(0, index).join('/'))) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `插件文件与目录路径冲突：${path}`);
    if (filePaths.some(other => other !== path && other.startsWith(`${path}/`))) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `插件文件与子路径冲突：${path}`);
  }
  const manifest = parseManifest(map, rootPath, diagnostics);
  const pluginId = `${manifest.name}@${manifest.version}`;
  const skills = discoverSkills(map, pluginId);
  const mcpPortable = map.get('mcp.json');
  const mcpCompat = map.get('.mcp.json');
  if (mcpPortable && mcpCompat && canonicalJson(parseJson(mcpPortable.bytes, 'mcp.json')) !== canonicalJson(parseJson(mcpCompat.bytes, '.mcp.json'))) diagnostics.push({ code: 'MCP_CONFIG_CONFLICT', message: 'portable 与兼容 MCP 配置内容冲突，已采用 mcp.json 并保留诊断', paths: ['mcp.json', '.mcp.json'], severity: 'error' });
  const mcpServers = mcpPortable || mcpCompat ? parseMcpConfig(parseJson((mcpPortable ?? mcpCompat!).bytes, mcpPortable ? 'mcp.json' : '.mcp.json'), pluginId) : [];
  const hooks = [...map.keys()].filter(path => path.startsWith('hooks/') || path.startsWith('.codex-plugin/hooks/'));
  for (const path of ['plugin.json', '.codex-plugin/plugin.json', 'mcp.json', '.mcp.json']) {
    const file = map.get(path);
    if (!file) continue;
    const redacted = redactValue(parseJson(file.bytes, path), '', {}) as Record<string, unknown>;
    map.set(path, { ...file, bytes: new TextEncoder().encode(JSON.stringify(redacted, null, 2)) });
  }
  return { rootPath, sourceType, files: [...map.values()], manifest, skills, mcpServers, hooks, executableResources: [...new Set(executableResources)], diagnostics };
}

function readU32(view: DataView, offset: number): number { return view.getUint32(offset, true); }
function readU16(view: DataView, offset: number): number { return view.getUint16(offset, true); }

function parseZipEntries(bytes: Uint8Array, limits: Required<PluginArchiveLimits>): ZipEntry[] {
  if (bytes.byteLength > limits.maxArchiveBytes) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', 'ZIP 压缩包超过大小限制');
  if (bytes.byteLength < 22) fail('PLUGIN_ARCHIVE_INVALID', 'ZIP 文件过短');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const start = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= start; offset--) if (readU32(view, offset) === 0x06054b50 && offset + 22 + readU16(view, offset + 20) === bytes.byteLength) { eocd = offset; break; }
  if (eocd < 0) fail('PLUGIN_ARCHIVE_INVALID', 'ZIP 缺少有效结束目录');
  if (readU16(view, eocd + 4) !== 0 || readU16(view, eocd + 6) !== 0) fail('PLUGIN_ARCHIVE_INVALID', '不支持多磁盘 ZIP');
  const count = readU16(view, eocd + 10); const size = readU32(view, eocd + 12); const offset = readU32(view, eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail('PLUGIN_ARCHIVE_INVALID', '不支持 Zip64');
  if (count > limits.maxFiles) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', 'ZIP 文件数超过限制');
  if (offset + size > eocd || offset + size > bytes.byteLength) fail('PLUGIN_ARCHIVE_INVALID', 'ZIP 中央目录越界');
  const entries: ZipEntry[] = []; const targets = new Set<string>(); let expanded = 0;
  let cursor = offset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || readU32(view, cursor) !== 0x02014b50) fail('PLUGIN_ARCHIVE_INVALID', 'ZIP 中央目录损坏');
    const madeBy = readU16(view, cursor + 4); const flags = readU16(view, cursor + 8); const compression = readU16(view, cursor + 10);
    const crc = readU32(view, cursor + 16); const compressedSize = readU32(view, cursor + 20); const expandedSize = readU32(view, cursor + 24); const nameLength = readU16(view, cursor + 28); const extraLength = readU16(view, cursor + 30); const commentLength = readU16(view, cursor + 32); const localOffset = readU32(view, cursor + 42);
    if (cursor + 46 + nameLength + extraLength + commentLength > offset + size) fail('PLUGIN_ARCHIVE_INVALID', 'ZIP 条目越界');
    let rawName: string;
    try { rawName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch (error) { fail('PLUGIN_ARCHIVE_INVALID', 'ZIP 文件名编码无效', String(error)); }
    const path = normalizePath(rawName.replace(/\/$/, '')); const isDirectory = rawName.endsWith('/'); const target = path.toLowerCase();
    if (targets.has(target)) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `ZIP 包含重复目标路径：${path}`); targets.add(target);
    if (flags & 0x2041) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 条目已加密或使用不支持的标记：${path}`);
    if (compression !== 0 && compression !== 8) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 条目压缩方式不支持：${path}`);
    if (compressedSize === 0 && expandedSize > 0) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', `ZIP 条目压缩比异常：${path}`);
    if (!isDirectory && expandedSize > limits.maxFileBytes) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', `ZIP 单文件超过大小限制：${path}`);
    if (!isDirectory && compressedSize > 0 && expandedSize / compressedSize > limits.maxCompressionRatio) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', `ZIP 压缩比超过限制：${path}`);
    expanded += expandedSize; if (expanded > limits.maxExpandedBytes) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', 'ZIP 解压后总大小超过限制');
    if (localOffset >= offset || localOffset + 30 > bytes.byteLength || readU32(view, localOffset) !== 0x04034b50) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 本地条目无效：${path}`);
    const localNameLength = readU16(view, localOffset + 26); const localExtraLength = readU16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > offset || dataEnd > bytes.byteLength) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 文件数据越界：${path}`);
    let localName: string;
    try { localName = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)); }
    catch (error) { fail('PLUGIN_ARCHIVE_INVALID', 'ZIP 本地文件名编码无效', String(error)); }
    const localFlags = readU16(view, localOffset + 6);
    if (normalizePath(localName.replace(/\/$/, '')) !== path || readU16(view, localOffset + 8) !== compression || localFlags !== flags) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 本地条目与中央目录不一致：${path}`);
    let localEnd = dataEnd;
    if (flags & 8) {
      let descriptorOffset = dataEnd;
      if (descriptorOffset + 4 <= offset && readU32(view, descriptorOffset) === 0x08074b50) descriptorOffset += 4;
      if (descriptorOffset + 12 > offset || readU32(view, descriptorOffset) !== crc || readU32(view, descriptorOffset + 4) !== compressedSize || readU32(view, descriptorOffset + 8) !== expandedSize) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 数据描述符不一致：${path}`);
      localEnd = descriptorOffset + 12;
    } else if (readU32(view, localOffset + 14) !== crc || readU32(view, localOffset + 18) !== compressedSize || readU32(view, localOffset + 22) !== expandedSize) {
      fail('PLUGIN_ARCHIVE_INVALID', `ZIP 本地条目大小或 CRC 不一致：${path}`);
    }
    const platform = madeBy >>> 8; const mode = platform === 3 ? readU32(view, cursor + 38) >>> 16 : undefined; const type = mode === undefined ? 0 : mode & 0xf000;
    if (mode !== undefined && (type === 0xa000 || (!isDirectory && type !== 0 && type !== 0x8000))) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 含符号链接或特殊文件：${path}`);
    entries.push({ path, compressedSize, expandedSize, crc, compression, localOffset, dataOffset, localEnd, isDirectory, mode });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== offset + size || entries.length > limits.maxFiles) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', 'ZIP 文件数或中央目录长度无效');
  const localEntries = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 1; index < localEntries.length; index++) if (localEntries[index - 1].localEnd > localEntries[index].localOffset) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 本地条目数据范围重叠：${localEntries[index].path}`);
  return entries;
}

export function validateZipArchive(input: Uint8Array | Buffer, options?: PluginArchiveLimits): PluginFile[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const limits = limitsOf(options); const entries = parseZipEntries(bytes, limits);
  const files: PluginFile[] = []; let total = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let content: Uint8Array;
    try {
      content = entry.compression === 0 ? new Uint8Array(compressed) : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: Math.min(limits.maxFileBytes, limits.maxExpandedBytes - total) }));
    } catch (error) {
      if (error instanceof Error && /maxOutputLength|larger than/i.test(error.message)) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', `ZIP 解压结果超过限制：${entry.path}`);
      fail('PLUGIN_ARCHIVE_INVALID', `ZIP 条目解压失败：${entry.path}`, String(error));
    }
    if (content.byteLength !== entry.expandedSize) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 条目声明大小与解压大小不符：${entry.path}`);
    if (crc32(content) !== entry.crc) fail('PLUGIN_ARCHIVE_INVALID', `ZIP 条目 CRC 校验失败：${entry.path}`);
    if (content.byteLength > limits.maxFileBytes) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', `ZIP 单文件超过大小限制：${entry.path}`);
    total += content.byteLength; if (total > limits.maxExpandedBytes) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', 'ZIP 解压后总大小超过限制');
    files.push({ path: entry.path, bytes: content, mode: entry.mode });
  }
  return files;
}

export async function validatePluginDirectory(rootPath: string, options?: PluginArchiveLimits): Promise<PluginFile[]> {
  const limits = limitsOf(options); const absoluteRoot = resolve(rootPath); const rootReal = await realpath(absoluteRoot); const files: PluginFile[] = []; let total = 0;
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name); const stat = await lstat(full);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `目录包含符号链接或特殊文件：${full}`);
      const target = await realpath(full); const rel = relative(rootReal, target); if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(rootReal, rel) !== target) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `目录路径越界：${full}`);
      if (stat.isDirectory()) await walk(full);
      else {
        if (stat.nlink > 1) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `目录包含硬链接文件：${full}`);
        if (files.length >= limits.maxFiles) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', '插件文件数超过限制');
        if (stat.size > limits.maxFileBytes) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', `插件单文件超过大小限制：${full}`);
        total += stat.size; if (total > limits.maxExpandedBytes) fail('PLUGIN_ARCHIVE_LIMIT_EXCEEDED', '插件总大小超过限制');
        const content = new Uint8Array(await readFile(full));
        const after = await lstat(full);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('PLUGIN_PATH_TRAVERSAL_BLOCKED', `目录文件在校验期间发生变化：${full}`);
        files.push({ path: normalizePath(relative(rootReal, target)), bytes: content, mode: stat.mode });
      }
    }
  }
  await walk(rootReal); return files;
}

export async function inspectPluginDirectory(rootPath: string, options?: PluginArchiveLimits): Promise<PluginPackageInspection> {
  const files = await validatePluginDirectory(rootPath, options); return inspectFiles(files, resolve(rootPath), 'directory');
}

export function inspectPluginArchive(input: Uint8Array | Buffer, options?: PluginArchiveLimits): PluginPackageInspection {
  return inspectFiles(validateZipArchive(input, options), '<archive>', 'zip');
}

export interface MarketplacePluginInput { name: string; relativePath?: string; category?: string }
export interface MarketplaceManifest { name: string; interface: { displayName: string }; plugins: Array<{ name: string; source: { source: 'local'; path: string }; policy: { installation: 'AVAILABLE'; authentication: 'ON_INSTALL' }; category: string }> }

export function createMarketplaceManifest(plugins: MarketplacePluginInput[], marketplaceName = 'jinggong-local', displayName = '精工本地插件'): MarketplaceManifest {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(marketplaceName)) fail('PLUGIN_MANIFEST_INVALID', 'Marketplace name 格式无效');
  const seen = new Set<string>();
  return { name: marketplaceName, interface: { displayName }, plugins: plugins.map(plugin => {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(plugin.name) || seen.has(plugin.name)) fail('PLUGIN_DUPLICATE_NAME', `Marketplace Plugin name 无效或重复：${plugin.name}`);
    seen.add(plugin.name); const path = plugin.relativePath ?? `./plugins/${plugin.name}`; if (!path.startsWith('./') || path.includes('..')) fail('PLUGIN_MANIFEST_INVALID', `Marketplace 插件路径必须是受控相对路径：${path}`);
    return { name: plugin.name, source: { source: 'local', path }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: plugin.category ?? 'Engineering' };
  }) };
}

export type CodexPluginAction = 'version' | 'help' | 'marketplace-add' | 'marketplace-list' | 'marketplace-remove' | 'plugin-add' | 'plugin-list' | 'plugin-remove';
export interface CodexPluginCommand { action: CodexPluginAction; args: string[]; marketplaceName?: string; pluginName?: string }
export function buildCodexPluginCommand(action: CodexPluginAction, value?: string): CodexPluginCommand {
  const json = ['marketplace-add', 'marketplace-list', 'marketplace-remove', 'plugin-add', 'plugin-list', 'plugin-remove'].includes(action) ? ['--json'] : [];
  const requiredValue = () => {
    if (!value?.trim()) fail('PLUGIN_MANIFEST_INVALID', `Codex ${action} 命令缺少目标参数`);
    return value;
  };
  switch (action) {
    case 'version': return { action, args: ['--version'] };
    case 'help': return { action, args: ['plugin', '--help'] };
    case 'marketplace-add': return { action, args: ['plugin', 'marketplace', 'add', requiredValue(), '--json'] };
    case 'marketplace-list': return { action, args: ['plugin', 'marketplace', 'list', ...json] };
    case 'marketplace-remove': return { action, args: ['plugin', 'marketplace', 'remove', requiredValue(), '--json'], marketplaceName: value };
    case 'plugin-add': return { action, args: ['plugin', 'add', requiredValue(), '--json'], pluginName: value };
    case 'plugin-list': return { action, args: ['plugin', 'list', ...json] };
    case 'plugin-remove': return { action, args: ['plugin', 'remove', requiredValue(), '--json'], pluginName: value };
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildCodexPluginCommand,
  createMarketplaceManifest,
  inspectPluginArchive,
  inspectPluginDirectory,
  type NormalizedMcpServer,
  type PluginPackageInspection,
} from '../../../../packages/plugin-manager/src';
import type {
  PluginDetail,
  PluginImportResult,
  PluginMcpConfigRedacted,
  PluginMcpHealthResult,
  PluginMcpServerRecord,
  PluginRecord,
  PluginReview,
  PluginSkillPreview,
  PluginSkillRecord,
  PluginValidationResult,
  PluginVersionRecord,
  RuntimePluginBindingRecord,
  RuntimePluginSyncResult,
  SessionPluginSnapshot,
  PluginAuditRecord,
  CodexPluginImportSummary,
} from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import type { CredentialVault } from './credentials';

type RuntimeEnvironment = (home: string, apiKey?: string) => NodeJS.ProcessEnv;

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_SKILL_PREVIEW = 128 * 1024;
const MARKETPLACE_NAME = 'jinggong-local';
const profileLocks = new Map<string, Promise<void>>();

function timestamp(): string { return new Date().toISOString(); }
function slug(value: string): string {
  const result = value.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return (result || 'plugin').slice(0, 48);
}
function hashFiles(files: PluginPackageInspection['files']): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path).update('\0').update(file.bytes).update('\0');
  }
  return hash.digest('hex');
}
function safeProfile(value: string): string {
  if (!PROFILE_ID.test(value)) throw new Error('Runtime Profile 标识无效');
  return value;
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function audit(pluginId: string | undefined, action: PluginAuditRecord['action'], result: PluginAuditRecord['result'], detailRedacted: Record<string, unknown>, target?: string, runtimeKind?: 'codex' | 'jinggong' | 'claude_agent_sdk'): PluginAuditRecord {
  return { id: randomUUID(), action, ...(pluginId ? { pluginId } : {}), ...(runtimeKind ? { runtimeKind } : {}), actor: 'desktop-plugin-manager', ...(target ? { target } : {}), result, detailRedacted, createdAt: timestamp() };
}
function hasRedactedValue(value: unknown): boolean {
  if (value === '<redacted>') return true;
  if (Array.isArray(value)) return value.some(hasRedactedValue);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasRedactedValue);
  return false;
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/(Bearer\s+)[^\s"']+/gi, '$1[已脱敏]').slice(0, 1000);
}

export interface PluginManagerServiceOptions {
  store: LocalStore;
  dataRoot: string;
  executable: string;
  environment: RuntimeEnvironment;
  /** MCP 凭据只通过主进程 Vault 访问，服务层不接收或返回明文。 */
  credentialVault?: CredentialVault;
  /** 可选 Codex Home；未提供时自动读取精工运行时、CODEX_HOME 与用户 .codex。 */
  codexHomes?: string[];
  commandRunner?: (executable: string, args: string[], home: string, environment: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;
}

interface CodexInstalledPlugin {
  pluginId: string;
  name: string;
  marketplaceName: string;
  version: string;
  installed: true;
  enabled: boolean;
  source: Record<string, unknown>;
}

export class PluginManagerService {
  private readonly store: LocalStore;
  private readonly dataRoot: string;
  private readonly executable: string;
  private readonly environment: RuntimeEnvironment;
  private readonly credentialVault?: CredentialVault;
  private readonly commandRunner?: PluginManagerServiceOptions['commandRunner'];
  private readonly codexHomes: string[];

  constructor(options: PluginManagerServiceOptions) {
    this.store = options.store;
    this.dataRoot = path.resolve(options.dataRoot);
    this.executable = path.resolve(options.executable);
    this.environment = options.environment;
    this.credentialVault = options.credentialVault;
    this.commandRunner = options.commandRunner;
    const userHome = process.env.USERPROFILE ?? process.env.HOME;
    this.codexHomes = [...new Set((options.codexHomes ?? [
      path.join(this.dataRoot, 'runtime', 'homes', 'codex'),
      process.env.CODEX_HOME,
      userHome ? path.join(userHome, '.codex') : undefined,
    ]).filter((home): home is string => !!home && home.trim().length > 0).map(home => path.resolve(home)))];
  }

  homeForProfile(profileId: string): string {
    return path.join(this.dataRoot, 'plugins', 'profiles', safeProfile(profileId));
  }

  private storeRoot(): string { return path.join(this.dataRoot, 'plugins', 'store'); }
  private marketplaceRoot(profileId: string): string { return path.join(this.homeForProfile(profileId), 'marketplace', 'codex-local'); }
  private nativePluginName(plugin: PluginRecord): string { return `${slug(plugin.name).slice(0, 40)}-${plugin.contentHash.slice(0, 8)}`; }
  private async ensureManagedDirectory(...parts: string[]): Promise<string> {
    await mkdir(this.dataRoot, { recursive: true });
    const dataRootReal = await realpath(this.dataRoot);
    let current = this.dataRoot;
    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current);
        stat = await lstat(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('精工插件管理目录不能包含符号链接');
      const resolved = await realpath(current);
      if (!inside(dataRootReal, resolved)) throw new Error('精工插件管理目录路径越界');
    }
    return current;
  }
  private async ensureProfileHome(profileId: string): Promise<string> {
    return this.ensureManagedDirectory('plugins', 'profiles', safeProfile(profileId));
  }
  private async withProfileLock<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.homeForProfile(profileId)).toLowerCase();
    const previous = profileLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    profileLocks.set(key, queued);
    await previous.catch(() => undefined);
    try { return await action(); }
    finally {
      release();
      if (profileLocks.get(key) === queued) profileLocks.delete(key);
    }
  }
  private pluginRoot(plugin: PluginRecord): string {
    const pluginsRoot = path.join(this.dataRoot, 'plugins');
    const pluginsStat = lstatSync(pluginsRoot, { throwIfNoEntry: false });
    const storeStat = lstatSync(this.storeRoot(), { throwIfNoEntry: false });
    if (!pluginsStat?.isDirectory() || pluginsStat.isSymbolicLink() || !storeStat?.isDirectory() || storeStat.isSymbolicLink()) throw new Error('插件 Store 根目录无效');
    const lexicalRoot = path.resolve(plugin.installPath);
    if (!inside(this.storeRoot(), lexicalRoot)) throw new Error('插件安装路径不在精工管理的 Store 内');
    const stat = lstatSync(lexicalRoot, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error('插件安装目录无效');
    const root = realpathSync(lexicalRoot);
    const managedStore = realpathSync(this.storeRoot());
    if (!inside(managedStore, root)) throw new Error('插件安装目录真实路径不在精工管理的 Store 内');
    return root;
  }
  private getPlugin(id: string): PluginRecord {
    const plugin = this.store.getPlugin(id);
    if (!plugin) throw new Error('插件不存在');
    return plugin;
  }
  private async inspect(plugin: PluginRecord): Promise<PluginPackageInspection> {
    const root = this.pluginRoot(plugin);
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('插件 Store 根目录不可用或是符号链接');
    const storeReal = await realpath(this.storeRoot());
    const rootReal = await realpath(root);
    if (!inside(storeReal, rootReal)) throw new Error('插件 Store 真实路径越界');
    return inspectPluginDirectory(rootReal);
  }
  private audit(record: PluginAuditRecord): void { this.store.appendPluginAudit(record); }
  private hasTrust(pluginId: string, scope: 'install' | 'execute_mcp'): boolean {
    return this.store.listPluginAudits({ pluginId, limit: 1000 }).some(item => item.action === 'trust' && item.result === 'success' && item.detailRedacted.scope === scope);
  }
  private assertInstallable(plugin: PluginRecord): void {
    if (plugin.trustStatus !== 'trusted') throw new Error('插件尚未获得安装信任');
    if (!this.hasTrust(plugin.id, 'install')) throw new Error('插件尚未获得安装范围信任');
    const mcp = this.store.listPluginMcpServers(plugin.id);
    if (mcp.length && !this.hasTrust(plugin.id, 'execute_mcp')) throw new Error('插件包含 MCP Server，请先单独确认 MCP 执行信任');
    if (mcp.some(server => server.credentialRefs.length || hasRedactedValue(server.configRedacted))) throw new Error('插件 MCP 含凭据引用或脱敏凭据；当前版本尚未接入凭据库，已阻止安装');
  }

  async importPlugin(input: { path: string; sourceType: 'zip' | 'folder' | 'local_marketplace' }): Promise<PluginImportResult> {
    const managedStore = await this.ensureManagedDirectory('plugins', 'store');
    const source = path.resolve(input.path);
    const inspection = input.sourceType === 'zip'
      ? inspectPluginArchive(await readFile(source))
      : await inspectPluginDirectory(source);
    const contentHash = hashFiles(inspection.files);
    const pluginId = `${slug(inspection.manifest.name)}-${contentHash.slice(0, 16)}`;
    const managedPluginRoot = await this.ensureManagedDirectory('plugins', 'store', pluginId);
    const installPath = path.join(managedPluginRoot, contentHash);
    const existing = this.store.getPlugin(pluginId);
    if (existing && existing.contentHash === contentHash) return { plugin: existing, warnings: inspection.diagnostics.map(item => item.message) };
    const stageRoot = path.join(this.storeRoot(), '.staging', `${pluginId}-${randomUUID()}`);
    await this.ensureManagedDirectory('plugins', 'store', '.staging');
    await mkdir(stageRoot, { recursive: false });
    try {
      for (const file of inspection.files) {
        const destination = path.resolve(stageRoot, file.path);
        if (!inside(stageRoot, destination)) throw new Error('插件文件路径越界');
        await mkdir(path.dirname(destination), { recursive: true });
        const parentReal = await realpath(path.dirname(destination));
        if (!inside(await realpath(stageRoot), parentReal)) throw new Error('插件文件父目录路径越界');
        await writeFile(destination, file.bytes, { flag: 'wx' });
      }
      try { await lstat(installPath); throw new Error('相同 Hash 的插件目录已存在但未登记，已拒绝覆盖'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(stageRoot, installPath);
    } catch (error) {
      await rm(stageRoot, { recursive: true, force: true });
      throw error;
    }
    const now = timestamp();
    const plugin: PluginRecord = {
      id: pluginId,
      name: inspection.manifest.name,
      version: inspection.manifest.version,
      description: inspection.manifest.description,
      ...(inspection.manifest.author ? { author: inspection.manifest.author } : {}),
      sourceType: input.sourceType,
      sourcePath: source,
      manifestPath: path.join(installPath, inspection.manifest.sourceManifest === 'portable' ? 'plugin.json' : '.codex-plugin/plugin.json'),
      installPath,
      manifestFormat: inspection.manifest.sourceManifest,
      contentHash,
      status: 'imported',
      trustStatus: 'untrusted',
      enabled: false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.store.savePlugin(plugin);
      const version: PluginVersionRecord = { id: `${pluginId}:version-${contentHash.slice(0, 16)}`, pluginId, version: plugin.version, installPath, contentHash, installedAt: now, isActive: true };
      this.store.savePluginVersion(version);
      for (const skill of inspection.skills) {
        const id = `${pluginId}:${slug(skill.name)}`;
        this.store.savePluginSkill({ id, pluginId, name: skill.name, description: skill.description, skillDir: skill.skillDir, skillFile: skill.skillFile, contentHash: skill.contentHash, metadata: { compatibility: typeof skill.metadata.compatibility === 'string' ? skill.metadata.compatibility : undefined, author: typeof skill.metadata.author === 'string' ? skill.metadata.author : undefined, tags: Array.isArray(skill.metadata.tags) ? skill.metadata.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 50) : undefined }, enabled: true });
      }
      for (const server of inspection.mcpServers) this.store.savePluginMcpServer(this.mcpRecord(pluginId, server));
      this.audit(audit(pluginId, 'import', 'success', { sourceType: input.sourceType, fileCount: inspection.files.length, executableCount: inspection.executableResources.length }));
    } catch (error) {
      try { if (this.store.getPlugin(pluginId)) this.store.deletePlugin(pluginId); } catch { /* 保留原始导入错误 */ }
      await rm(installPath, { recursive: true, force: true });
      throw error;
    }
    return { plugin, warnings: inspection.diagnostics.map(item => item.message).concat(inspection.hooks.length ? ['发现 Hooks；P0 只解析，不执行。'] : []) };
  }

  /** 扫描并导入 Codex Home 中已缓存的标准插件；只复制到精工 Store，不执行插件代码。 */
  async importCodexPlugins(): Promise<CodexPluginImportSummary> {
    const roots: string[] = [];
    const seen = new Set<string>();
    const maxDepth = 8;
    const maxRoots = 500;
    const walk = async (root: string, depth: number): Promise<void> => {
      if (roots.length >= maxRoots || depth > maxDepth) return;
      let stat;
      try { stat = await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const resolved = path.resolve(root).toLowerCase();
      if (seen.has(resolved)) return;
      const manifest = path.join(root, '.codex-plugin', 'plugin.json');
      const portable = path.join(root, 'plugin.json');
      if (await this.pathIsFile(manifest) || await this.pathIsFile(portable)) { seen.add(resolved); roots.push(root); return; }
      if (depth === maxDepth) return;
      let entries: string[];
      try { entries = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) await walk(path.join(root, entry), depth + 1);
    };
    for (const home of this.codexHomes) {
      for (const relative of ['plugins/cache', 'plugins', 'marketplace']) await walk(path.join(home, relative), 0);
      if (roots.length >= maxRoots) break;
    }
    const imported: CodexPluginImportSummary['imported'] = [];
    const skipped: CodexPluginImportSummary['skipped'] = [];
    for (const root of roots) {
      try { imported.push(await this.importPlugin({ path: root, sourceType: 'local_marketplace' })); }
      catch (error) { skipped.push({ path: root, error: safeError(error) }); }
    }
    return { imported, skipped, scanned: roots.length };
  }

  private async pathIsFile(target: string): Promise<boolean> {
    try { const stat = await lstat(target); return stat.isFile() && !stat.isSymbolicLink(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  private mcpRecord(pluginId: string, server: NormalizedMcpServer): PluginMcpServerRecord {
    const redacted = server.redactedConfig;
    const unresolved: string[] = [];
    for (const [name, value] of Object.entries((redacted.env ?? {}) as Record<string, unknown>)) if (value === '<redacted>') unresolved.push(`env:${name}`);
    for (const [name, value] of Object.entries((redacted.headers ?? {}) as Record<string, unknown>)) if (value === '<redacted>') unresolved.push(`header:${name}`);
    const credentialRefs = [...new Set([...Object.values(server.envRefs ?? {}), ...Object.values(server.httpHeaderRefs ?? {}), ...unresolved])];
    const configRedacted: PluginMcpConfigRedacted = server.transport === 'stdio'
      ? { transport: 'stdio', command: typeof redacted.command === 'string' ? redacted.command : '', args: Array.isArray(redacted.args) ? redacted.args.filter((arg): arg is string => typeof arg === 'string') : [], ...(typeof redacted.cwd === 'string' ? { cwd: redacted.cwd } : {}), ...(redacted.env && typeof redacted.env === 'object' ? { envVarNames: Object.keys(redacted.env as Record<string, unknown>) } : {}) }
      : { transport: 'streamable-http', url: server.url ?? '', ...(server.httpHeaderRefs ? { headerNames: Object.keys(server.httpHeaderRefs) } : {}) };
    return { id: `${pluginId}:${slug(server.name)}`, pluginId, serverName: server.name, transport: server.transport, configRedacted, credentialRefs, configuredCredentialRefs: [], enabled: false, healthStatus: 'unknown' };
  }

  async listPlugins(): Promise<PluginRecord[]> { return this.store.listPlugins(); }
  async getSessionPluginSnapshot(sessionId: string): Promise<SessionPluginSnapshot | null> { return this.store.getSessionPluginSnapshot(sessionId) ?? null; }
  async getPluginDetail(pluginId: string): Promise<PluginDetail> {
    const plugin = this.getPlugin(pluginId);
    const inspection = await this.inspect(plugin);
    const contentHash = hashFiles(inspection.files);
    if (contentHash !== plugin.contentHash) throw new Error('插件内容 Hash 已变化，无法生成可信审阅详情');
    const review: PluginReview = {
      sourceType: plugin.sourceType,
      ...(plugin.sourcePath ? { sourcePath: plugin.sourcePath } : {}),
      contentHash,
      manifest: { format: inspection.manifest.sourceManifest, path: plugin.manifestPath, sha256: inspection.manifest.rawManifestHash, raw: inspection.manifest.raw },
      diagnostics: inspection.diagnostics,
      skills: inspection.skills.map(skill => ({ id: `${pluginId}:${slug(skill.name)}`, name: skill.name, description: skill.description, skillFile: skill.skillFile, contentHash: skill.contentHash, resources: skill.resources })),
      mcpServers: inspection.mcpServers,
      hooks: inspection.hooks,
      executableResources: inspection.executableResources,
    };
    return { plugin, versions: this.store.listPluginVersions(pluginId), skills: this.store.listPluginSkills(pluginId), mcpServers: this.store.listPluginMcpServers(pluginId), runtimeBindings: this.store.listRuntimePluginBindings(pluginId), review };
  }
  async validatePlugin(pluginId: string): Promise<PluginValidationResult> {
    const plugin = this.getPlugin(pluginId);
    try {
      const inspected = await this.inspect(plugin);
      const errors = inspected.diagnostics.filter(item => item.severity === 'error').map(item => item.message);
      const warnings = inspected.diagnostics.filter(item => item.severity === 'warning').map(item => item.message);
      if (hashFiles(inspected.files) !== plugin.contentHash) errors.push('插件内容 Hash 已变化，可能被外部修改');
      const valid = errors.length === 0;
      this.audit(audit(pluginId, 'runtime-sync', valid ? 'success' : 'failure', { valid, errorCount: errors.length, warningCount: warnings.length }));
      return { valid, errors, warnings };
    } catch (error) {
      const message = safeError(error); this.audit(audit(pluginId, 'runtime-sync', 'failure', { valid: false, error: message })); return { valid: false, errors: [message], warnings: [] };
    }
  }
  async trustPlugin(pluginId: string, trustScope: 'install' | 'execute_mcp'): Promise<void> {
    const plugin = this.getPlugin(pluginId);
    if (plugin.trustStatus === 'revoked') throw new Error('插件信任已撤销，不能直接恢复');
    if (trustScope === 'execute_mcp' && !this.store.listPluginMcpServers(pluginId).length) throw new Error('插件不包含 MCP Server，无需设置 MCP 执行信任');
    const validation = await this.validatePlugin(pluginId);
    if (!validation.valid) throw new Error(`插件校验失败：${validation.errors.join('；')}`);
    const installTrusted = trustScope === 'install' || this.hasTrust(pluginId, 'install');
    this.store.savePlugin({ ...plugin, trustStatus: installTrusted ? 'trusted' : 'reviewed', updatedAt: timestamp() });
    this.audit(audit(pluginId, 'trust', 'success', { scope: trustScope }));
  }
  async enablePlugin(pluginId: string, enabled: boolean): Promise<void> {
    const plugin = this.getPlugin(pluginId);
    if (enabled) {
      const validation = await this.validatePlugin(pluginId);
      if (!validation.valid) throw new Error(`插件校验失败：${validation.errors.join('；')}`);
      this.assertInstallable(plugin);
    } else {
      const managerBinding = this.store.listRuntimePluginBindings(pluginId).find(binding => binding.runtimeKind === 'codex' && binding.profileId === 'plugin-manager' && binding.installState !== 'not-installed');
      if (managerBinding) {
        const remaining = this.store.listPlugins().filter(item => item.id !== pluginId && item.enabled && item.trustStatus === 'trusted');
        try {
          const sync = await this.syncSelected('plugin-manager', remaining);
          if (sync.errors.length) throw new Error(sync.errors.join('；'));
        }
        catch (error) {
          this.audit(audit(pluginId, 'disable', 'failure', { profileId: 'plugin-manager', stage: 'profile-sync' }, managerBinding.nativePluginId, 'codex'));
          throw new Error(`Codex 插件禁用失败：${safeError(error)}`);
        }
      }
    }
    const next: PluginRecord = { ...plugin, enabled, status: enabled ? (plugin.status === 'disabled' ? 'imported' : plugin.status) : 'disabled', updatedAt: timestamp() };
    this.store.savePlugin(next);
    this.audit(audit(pluginId, enabled ? 'enable' : 'disable', 'success', { enabled }));
  }
  async listSkills(pluginId?: string): Promise<PluginSkillRecord[]> { return this.store.listPluginSkills(pluginId); }
  async previewSkill(skillId: string): Promise<PluginSkillPreview> {
    const skill = this.store.getPluginSkill(skillId); if (!skill) throw new Error('Skill 不存在');
    const plugin = this.getPlugin(skill.pluginId); const root = this.pluginRoot(plugin); const file = path.resolve(root, skill.skillFile);
    if (!inside(root, file)) throw new Error('Skill 文件路径越界');
    const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_PREVIEW * 8) throw new Error('Skill 文件不可预览');
    const bytes = await readFile(file); const truncated = bytes.byteLength > MAX_SKILL_PREVIEW;
    return { skill, content: bytes.subarray(0, MAX_SKILL_PREVIEW).toString('utf8'), truncated };
  }
  async listMcpServers(pluginId?: string): Promise<PluginMcpServerRecord[]> { return this.store.listPluginMcpServers(pluginId); }
  private mcpCredentialScope(server: PluginMcpServerRecord): string { return `mcp:${server.pluginId}:${server.id}`; }
  private assertMcpCredentialReference(server: PluginMcpServerRecord, reference: string): void {
    if (!server.credentialRefs.includes(reference)) throw new Error('凭据引用不属于该 MCP Server');
    if (!/^(env|header):[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(reference)) throw new Error('MCP 凭据引用格式无效');
  }
  async saveMcpCredential(serverId: string, reference: string, secret: string): Promise<void> {
    const server = this.store.getPluginMcpServer(serverId); if (!server) throw new Error('MCP Server 不存在');
    this.assertMcpCredentialReference(server, reference);
    if (!this.credentialVault) throw new Error('MCP 凭据库未配置，已拒绝保存');
    this.credentialVault.save(reference, secret, this.mcpCredentialScope(server));
    this.store.savePluginMcpServer({ ...server, configuredCredentialRefs: [...new Set([...(server.configuredCredentialRefs ?? []), reference])] });
    this.audit(audit(server.pluginId, 'mcp-credential-save', 'success', { serverId: server.id, reference }));
  }
  async clearMcpCredential(serverId: string, reference: string): Promise<void> {
    const server = this.store.getPluginMcpServer(serverId); if (!server) throw new Error('MCP Server 不存在');
    this.assertMcpCredentialReference(server, reference);
    if (!this.credentialVault) throw new Error('MCP 凭据库未配置，已拒绝删除');
    this.credentialVault.delete(reference, this.mcpCredentialScope(server));
    const configuredCredentialRefs = (server.configuredCredentialRefs ?? []).filter(item => item !== reference);
    if (server.enabled) {
      const checked = { ...server, configuredCredentialRefs, enabled: false, healthStatus: 'unknown' as const, lastError: undefined };
      this.store.savePluginMcpServer(checked);
      this.audit(audit(server.pluginId, 'mcp-disable', 'success', { serverId: server.id, reason: 'credential-cleared' }));
    } else this.store.savePluginMcpServer({ ...server, configuredCredentialRefs });
    this.audit(audit(server.pluginId, 'mcp-credential-clear', 'success', { serverId: server.id, reference }));
  }
  async setMcpServerEnabled(serverId: string, enabled: boolean): Promise<void> {
    const server = this.store.getPluginMcpServer(serverId); if (!server) throw new Error('MCP Server 不存在');
    if (enabled) {
      const plugin = this.getPlugin(server.pluginId);
      if (plugin.trustStatus === 'revoked' || !this.hasTrust(server.pluginId, 'execute_mcp')) throw new Error('插件尚未获得 MCP 执行信任');
      if (server.credentialRefs.length && !this.credentialVault) throw new Error('MCP 凭据库未配置，已拒绝启用');
      const missing = server.credentialRefs.filter(reference => !this.credentialVault?.has(reference, this.mcpCredentialScope(server)));
      if (missing.length) throw new Error(`MCP 凭据尚未配置：${missing.join('、')}`);
    }
    this.store.savePluginMcpServer({ ...server, enabled, ...(enabled ? { healthStatus: 'unknown' as const, lastError: undefined } : { healthStatus: 'unknown' as const, lastError: undefined }) });
    this.audit(audit(server.pluginId, enabled ? 'mcp-enable' : 'mcp-disable', 'success', { serverId: server.id, enabled, runtime: 'not-integrated' }));
  }
  async testMcpServer(serverId: string): Promise<PluginMcpHealthResult> {
    const server = this.store.getPluginMcpServer(serverId); if (!server) throw new Error('MCP Server 不存在');
    const checkedAt = timestamp(); const error = '当前版本仅完成 Codex MCP 配置识别；主动 MCP 连接测试尚未接入，HTTP 端到端工具发现未验证';
    this.store.savePluginMcpServer({ ...server, healthStatus: 'unavailable', lastCheckedAt: checkedAt, lastError: error });
    this.audit(audit(server.pluginId, 'mcp-test', 'cancelled', { status: 'unavailable', transport: server.transport }));
    return { status: 'unavailable', error, checkedAt };
  }

  async updateSessionPluginSelection(input: { sessionId?: string; profileId: string; pluginIds: string[]; skillIds: string[] }): Promise<SessionPluginSnapshot> {
    const profileId = safeProfile(input.profileId); const plugins = input.pluginIds.map(id => this.getPlugin(id));
    if (input.sessionId && profileId !== `session-${input.sessionId}`) throw new Error('Session Profile 标识必须与 Session 一致');
    if (new Set(input.pluginIds).size !== input.pluginIds.length) throw new Error('插件不能重复');
    for (const plugin of plugins) { if (!plugin.enabled || plugin.trustStatus !== 'trusted') throw new Error(`插件 ${plugin.name} 尚未启用或信任`); this.assertInstallable(plugin); }
    const selectedSkillIds = input.skillIds.length ? input.skillIds : plugins.flatMap(plugin => this.store.listPluginSkills(plugin.id).filter(skill => skill.enabled).map(skill => skill.id));
    if (new Set(selectedSkillIds).size !== selectedSkillIds.length) throw new Error('Skill 不能重复');
    const skills = selectedSkillIds.map(id => this.store.getPluginSkill(id)).filter((skill): skill is PluginSkillRecord => !!skill);
    if (skills.length !== selectedSkillIds.length || skills.some(skill => !skill.enabled || !plugins.some(plugin => plugin.id === skill.pluginId))) throw new Error('Skill 未启用或选择不属于所选插件');
    const previous = input.sessionId ? this.store.getSessionPluginSnapshot(input.sessionId) : undefined;
    if (previous) throw new Error('会话插件快照已冻结，不能覆盖');
    const entries = plugins.map(plugin => ({ pluginId: plugin.id, name: plugin.name, version: plugin.version, contentHash: plugin.contentHash, skillIds: skills.filter(skill => skill.pluginId === plugin.id).map(skill => skill.id), skillNames: skills.filter(skill => skill.pluginId === plugin.id).map(skill => skill.name), mcpServerIds: this.store.listPluginMcpServers(plugin.id).map(server => server.id) }));
    const body = { pluginIds: plugins.map(plugin => plugin.id), skillIds: selectedSkillIds, entries };
    const snapshotHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const snapshot: SessionPluginSnapshot = { sessionId: input.sessionId ?? `profile-${profileId}`, profileId, profileRevision: 1, runtimeKind: 'codex', effectiveScope: input.sessionId ? 'session' : 'runtime-profile', pluginIds: body.pluginIds, skillIds: body.skillIds, plugins: entries, snapshotHash, createdAt: timestamp() };
    if (input.sessionId) this.store.saveSessionPluginSnapshot(snapshot);
    this.audit(audit(undefined, 'session-selection', 'success', { profileId, pluginCount: plugins.length, skillCount: skills.length }, input.sessionId));
    return snapshot;
  }

  private async runCodex(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const managedHome = await this.ensureProfileHome(path.basename(path.resolve(home)));
    if (path.resolve(home) !== managedHome) throw new Error('Codex Profile Home 必须位于精工 dataRoot 下');
    if (this.commandRunner) return this.commandRunner(this.executable, args, managedHome, this.environment(managedHome));
    return await new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { cwd: managedHome, env: this.environment(managedHome), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; const limit = 1024 * 1024;
      child.stdout?.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-limit); }); child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-limit); });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Codex Plugin 命令超时')); }, 60_000); timer.unref();
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code: typeof code === 'number' ? code : signal ? 1 : 0, stdout, stderr }); });
    });
  }
  private async readCodexPluginList(profileId: string): Promise<CodexInstalledPlugin[]> {
    const home = await this.ensureProfileHome(profileId);
    const result = await this.runCodex(home, buildCodexPluginCommand('plugin-list').args);
    if (result.code !== 0) throw new Error(`Codex Profile 状态读取失败：${safeError(result.stderr || result.stdout)}`);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error('Codex Plugin list JSON 无法解析，未更新本地绑定状态'); }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Codex Plugin list JSON 结构无效，未更新本地绑定状态');
      const root = parsed as Record<string, unknown>;
      if (!Array.isArray(root.installed) || !Array.isArray(root.available)) throw new Error('Codex Plugin list 缺少 installed/available 数组，未更新本地绑定状态');
      const ids = new Set<string>();
      const installed: CodexInstalledPlugin[] = [];
      for (const raw of root.installed) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Codex Plugin list installed 项无效，未更新本地绑定状态');
        const item = raw as Record<string, unknown>;
        const source = item.source && typeof item.source === 'object' && !Array.isArray(item.source) ? item.source as Record<string, unknown> : undefined;
        if (typeof item.pluginId !== 'string' || !item.pluginId || typeof item.name !== 'string' || typeof item.marketplaceName !== 'string' || typeof item.version !== 'string' || item.installed !== true || typeof item.enabled !== 'boolean' || !source || typeof source.source !== 'string' || (source.path !== undefined && typeof source.path !== 'string')) throw new Error('Codex Plugin list installed 项字段不完整，未更新本地绑定状态');
        if (ids.has(item.pluginId)) throw new Error('Codex Plugin list 存在重复 pluginId，未更新本地绑定状态');
        ids.add(item.pluginId);
        installed.push({ pluginId: item.pluginId, name: item.name, marketplaceName: item.marketplaceName, version: item.version, installed: true, enabled: item.enabled, source });
      }
      return installed;
    } catch (error) {
      this.audit(audit(undefined, 'runtime-sync', 'failure', { profileId, stage: 'plugin-list-readback', error: safeError(error) }, undefined, 'codex'));
      throw error;
    }
  }
  private reconcileCodexBindings(profileId: string, installed: CodexInstalledPlugin[], expectedPlugins: PluginRecord[] = []): void {
    const byNativeId = new Map(installed.map(item => [item.pluginId, item]));
    const bindings = this.store.listRuntimePluginBindings().filter(binding => binding.runtimeKind === 'codex' && binding.profileId === profileId);
    const expectedPaths = new Map<string, string>();
    for (const binding of bindings) if (binding.nativePluginId && binding.nativePath) expectedPaths.set(binding.nativePluginId, binding.nativePath);
    for (const plugin of expectedPlugins) expectedPaths.set(`${this.nativePluginName(plugin)}@${MARKETPLACE_NAME}`, path.join(this.marketplaceRoot(profileId), 'plugins', this.nativePluginName(plugin)));
    for (const [nativePluginId, expectedPath] of expectedPaths) {
      const native = byNativeId.get(nativePluginId);
      if (!native) continue;
      const actualPath = native.source.path;
      if (native.source.source !== 'local' || typeof actualPath !== 'string' || path.resolve(actualPath).toLowerCase() !== path.resolve(expectedPath).toLowerCase()) throw new Error(`Codex Profile ${profileId} 的 Plugin list 来源与受控绑定不匹配，未更新本地状态`);
    }
    for (const binding of bindings) {
      if (!binding.nativePluginId) continue;
      const native = byNativeId.get(binding.nativePluginId);
      const installState = native ? (native.enabled ? 'installed' : 'disabled') : 'not-installed';
      if (binding.installState !== installState) this.store.saveRuntimePluginBinding({ ...binding, installState, lastSyncAt: timestamp(), lastError: undefined });
    }
    for (const plugin of expectedPlugins) {
      const nativePluginId = `${this.nativePluginName(plugin)}@${MARKETPLACE_NAME}`;
      const native = byNativeId.get(nativePluginId);
      if (!native) continue;
      this.store.saveRuntimePluginBinding({ id: `${plugin.id}:codex:${profileId}`, pluginId: plugin.id, runtimeKind: 'codex', profileId, nativePluginId, nativePath: path.join(this.marketplaceRoot(profileId), 'plugins', this.nativePluginName(plugin)), installState: native.enabled ? 'installed' : 'disabled', lastSyncAt: timestamp() });
    }
  }
  private async buildMarketplace(root: string, plugins: PluginRecord[]): Promise<void> {
    await mkdir(path.join(root, '.agents', 'plugins'), { recursive: true });
    await mkdir(path.join(root, 'plugins'), { recursive: true });
    const entries: Array<{ name: string; relativePath: string }> = [];
    for (const plugin of plugins) {
      const name = this.nativePluginName(plugin); const destination = path.join(root, 'plugins', name);
      if (!inside(root, destination)) throw new Error('Marketplace 插件路径越界');
      await cp(this.pluginRoot(plugin), destination, { recursive: true, force: true, verbatimSymlinks: true }); entries.push({ name, relativePath: `./plugins/${name}` });
    }
    await writeFile(path.join(root, '.agents', 'plugins', 'marketplace.json'), JSON.stringify(createMarketplaceManifest(entries, MARKETPLACE_NAME, '精工本地插件'), null, 2), 'utf8');
  }
  private async beginMarketplaceUpdate(profileId: string, plugins: PluginRecord[]): Promise<{ root: string; backup: string; hadPrevious: boolean }> {
    const parent = await this.ensureManagedDirectory('plugins', 'profiles', safeProfile(profileId), 'marketplace');
    const root = path.join(parent, 'codex-local');
    const suffix = randomUUID();
    const staging = path.join(parent, `.codex-local-staging-${suffix}`);
    const backup = path.join(parent, `.codex-local-backup-${suffix}`);
    let hadPrevious = false;
    try {
      await mkdir(staging, { recursive: false });
      await this.buildMarketplace(staging, plugins);
      try {
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('现有 Marketplace 根目录不是受控普通目录');
        hadPrevious = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (hadPrevious) await rename(root, backup);
      try { await rename(staging, root); }
      catch (error) {
        if (hadPrevious) await rename(backup, root);
        throw error;
      }
      return { root, backup, hadPrevious };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  private async rollbackMarketplaceUpdate(
    profileId: string,
    transaction: { root: string; backup: string; hadPrevious: boolean },
    initialPlugins: CodexInstalledPlugin[],
    previousBindings: RuntimePluginBindingRecord[],
    desiredPlugins: PluginRecord[],
  ): Promise<void> {
    const failures: string[] = [];
    try {
      await rm(transaction.root, { recursive: true, force: true });
      if (transaction.hadPrevious) await rename(transaction.backup, transaction.root);
    } catch (error) { failures.push(`恢复 Marketplace 目录：${safeError(error)}`); }

    const home = this.homeForProfile(profileId);
    try {
      if (transaction.hadPrevious) {
        const add = await this.runCodex(home, buildCodexPluginCommand('marketplace-add', transaction.root).args);
        if (add.code !== 0 && !/already|exist|duplicate/i.test(`${add.stdout}\n${add.stderr}`)) throw new Error(safeError(add.stderr || add.stdout));
      } else {
        const remove = await this.runCodex(home, buildCodexPluginCommand('marketplace-remove', MARKETPLACE_NAME).args);
        if (remove.code !== 0 && !/not found|does not exist|unknown|no marketplace|not configured|not installed/i.test(`${remove.stdout}\n${remove.stderr}`)) throw new Error(safeError(remove.stderr || remove.stdout));
      }
    } catch (error) { failures.push(`恢复 Codex Marketplace：${safeError(error)}`); }

    const initialIds = new Set(initialPlugins.filter(item => item.marketplaceName === MARKETPLACE_NAME).map(item => item.pluginId));
    for (const plugin of desiredPlugins) {
      const pluginId = `${this.nativePluginName(plugin)}@${MARKETPLACE_NAME}`;
      if (initialIds.has(pluginId)) continue;
      try {
        const result = await this.runCodex(home, buildCodexPluginCommand('plugin-remove', pluginId).args);
        if (result.code !== 0 && !/not found|does not exist|unknown/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error(safeError(result.stderr || result.stdout));
      } catch (error) { failures.push(`移除回滚期间新增的 ${pluginId}：${safeError(error)}`); }
    }
    for (const binding of previousBindings) {
      if (!binding.nativePluginId || !initialIds.has(binding.nativePluginId)) continue;
      try {
        const result = await this.runCodex(home, buildCodexPluginCommand('plugin-add', binding.nativePluginId).args);
        if (result.code !== 0 && !/already|exist|duplicate/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error(safeError(result.stderr || result.stdout));
      } catch (error) { failures.push(`恢复先前插件 ${binding.nativePluginId}：${safeError(error)}`); }
    }

    try {
      const live = await this.readCodexPluginList(profileId);
      const liveManaged = live.filter(item => item.marketplaceName === MARKETPLACE_NAME).map(item => item.pluginId).sort();
      const expectedManaged = [...initialIds].sort();
      if (JSON.stringify(liveManaged) !== JSON.stringify(expectedManaged)) throw new Error('Codex 当前插件列表与更新前不一致');
    } catch (error) { failures.push(`验证回滚后的 Codex 状态：${safeError(error)}`); }
    if (failures.length) throw new Error(`Marketplace 更新失败，回滚未能完整验证：${failures.join('；')}`);
  }
  private async commitMarketplaceUpdate(transaction: { root: string; backup: string; hadPrevious: boolean }, removeMarketplace: boolean): Promise<void> {
    if (removeMarketplace) await rm(transaction.root, { recursive: true, force: true });
    if (transaction.hadPrevious) await rm(transaction.backup, { recursive: true, force: true }).catch(() => undefined);
  }
  private async syncSelected(profileId: string, plugins: PluginRecord[]): Promise<RuntimePluginSyncResult> {
    return this.withProfileLock(profileId, () => this.syncSelectedLocked(profileId, plugins));
  }
  private async syncSelectedLocked(profileId: string, plugins: PluginRecord[]): Promise<RuntimePluginSyncResult> {
    const home = await this.ensureProfileHome(profileId);
    for (const plugin of plugins) this.assertInstallable(plugin);
    for (const plugin of plugins) {
      const inspected = await this.inspect(plugin);
      if (hashFiles(inspected.files) !== plugin.contentHash) throw new Error(`插件 ${plugin.name} 内容 Hash 已变化，已阻止安装`);
    }
    const initialLive = await this.readCodexPluginList(profileId);
    const selectedIds = new Set(plugins.map(plugin => plugin.id));
    const previousBindings = this.store.listRuntimePluginBindings().filter(binding => binding.runtimeKind === 'codex' && binding.profileId === profileId && (binding.installState === 'installed' || binding.installState === 'disabled'));
    const transaction = await this.beginMarketplaceUpdate(profileId, plugins);
    let committed = false;
    try {
      if (plugins.length) {
        const marketplace = await this.runCodex(home, buildCodexPluginCommand('marketplace-add', transaction.root).args);
        if (marketplace.code !== 0 && !/already|exist|duplicate/i.test(`${marketplace.stdout}\n${marketplace.stderr}`)) throw new Error(`Codex Marketplace 添加失败：${safeError(marketplace.stderr || marketplace.stdout)}`);
        for (const plugin of plugins) {
          const pluginName = `${this.nativePluginName(plugin)}@${MARKETPLACE_NAME}`;
          const result = await this.runCodex(home, buildCodexPluginCommand('plugin-add', pluginName).args);
          if (result.code !== 0 && !/already|exist|duplicate/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error(`${plugin.name}：${safeError(result.stderr || result.stdout)}`);
        }
      }
      for (const binding of previousBindings) {
        if (selectedIds.has(binding.pluginId) || !binding.nativePluginId) continue;
        const removed = await this.runCodex(home, buildCodexPluginCommand('plugin-remove', binding.nativePluginId).args);
        if (removed.code !== 0 && !/not found|does not exist|unknown/i.test(`${removed.stdout}\n${removed.stderr}`)) throw new Error(`卸载 ${binding.nativePluginId}：${safeError(removed.stderr || removed.stdout)}`);
      }
      if (!plugins.length) {
        const marketplace = await this.runCodex(home, buildCodexPluginCommand('marketplace-remove', MARKETPLACE_NAME).args);
        if (marketplace.code !== 0 && !/not found|does not exist|unknown|no marketplace|not configured|not installed/i.test(`${marketplace.stdout}\n${marketplace.stderr}`)) throw new Error(`Codex Marketplace 卸载失败：${safeError(marketplace.stderr || marketplace.stdout)}`);
      }
      const live = await this.readCodexPluginList(profileId);
      const missing = plugins.filter(plugin => !byExpectedId(live, `${this.nativePluginName(plugin)}@${MARKETPLACE_NAME}`));
      if (missing.length) throw new Error(`Codex Profile 回读缺少插件：${missing.map(plugin => plugin.name).join('、')}`);
      const retained = previousBindings.filter(binding => !selectedIds.has(binding.pluginId) && binding.nativePluginId && byExpectedId(live, binding.nativePluginId));
      if (retained.length) throw new Error(`Codex Profile 回读仍包含待移除插件：${retained.map(binding => binding.nativePluginId).join('、')}`);
      this.reconcileCodexBindings(profileId, live, plugins);
      await this.commitMarketplaceUpdate(transaction, plugins.length === 0);
      committed = true;
      for (const binding of previousBindings) if (!selectedIds.has(binding.pluginId) && binding.nativePluginId) this.audit(audit(binding.pluginId, 'uninstall', 'success', { profileId, reason: 'selection-sync' }, binding.nativePluginId, 'codex'));
      for (const plugin of plugins) this.audit(audit(plugin.id, 'install', 'success', { profileId }, `${this.nativePluginName(plugin)}@${MARKETPLACE_NAME}`, 'codex'));
      const result: RuntimePluginSyncResult = { profileId, installed: plugins.length, errors: [], syncedAt: timestamp() };
      this.audit(audit(undefined, 'runtime-sync', 'success', { profileId, installed: plugins.length, errorCount: 0 }, undefined, 'codex'));
      return result;
    } catch (error) {
      if (committed) throw error;
      try { await this.rollbackMarketplaceUpdate(profileId, transaction, initialLive, previousBindings, plugins); }
      catch (rollbackError) { throw new Error(`${safeError(error)}；${safeError(rollbackError)}`); }
      throw error;
    }
  }
  async installForCodex(pluginId: string, profileId: string): Promise<RuntimePluginBindingRecord> {
    const plugin = this.getPlugin(pluginId); safeProfile(profileId); this.assertInstallable(plugin);
    if (profileId === 'plugin-manager' && !plugin.enabled) throw new Error('Codex Plugin Manager Profile 不能安装已禁用插件');
    await this.syncCodexProfile(profileId);
    const binding = this.store.listRuntimePluginBindings(pluginId).find(item => item.profileId === profileId && item.runtimeKind === 'codex');
    if (!binding) throw new Error('Codex 插件安装未返回绑定记录');
    return binding;
  }
  async uninstallFromCodex(pluginId: string, profileId: string): Promise<void> {
    const plugin = this.getPlugin(pluginId); profileId = safeProfile(profileId);
    await this.withProfileLock(profileId, async () => {
      const binding = this.store.listRuntimePluginBindings(pluginId).find(item => item.profileId === profileId && item.runtimeKind === 'codex');
      const remaining = this.store.listRuntimePluginBindings().filter(item => item.runtimeKind === 'codex' && item.profileId === profileId && (item.installState === 'installed' || item.installState === 'disabled') && item.pluginId !== pluginId)
        .map(item => this.store.getPlugin(item.pluginId)).filter((item): item is PluginRecord => !!item);
      await this.syncSelectedLocked(profileId, remaining);
      if (!binding?.nativePluginId) this.store.saveRuntimePluginBinding({ id: `${plugin.id}:codex:${profileId}`, pluginId, runtimeKind: 'codex', profileId, installState: 'not-installed', lastSyncAt: timestamp() });
      this.audit(audit(pluginId, 'uninstall', 'success', { profileId }, binding?.nativePluginId, 'codex'));
    });
  }
  async syncCodexProfile(profileId: string): Promise<RuntimePluginSyncResult> {
    safeProfile(profileId);
    let pluginIds: string[];
    if (profileId === 'plugin-manager') pluginIds = this.store.listPlugins().filter(plugin => plugin.enabled && plugin.trustStatus === 'trusted').map(plugin => plugin.id);
    else {
      const session = this.store.listSessions().find(item => `session-${item.id}` === profileId);
      const snapshot = session ? this.store.getSessionPluginSnapshot(session.id) : undefined;
      if (!session || !snapshot || snapshot.profileId !== profileId || snapshot.runtimeKind !== 'codex' || snapshot.effectiveScope !== 'session') throw new Error('Codex Session Profile 缺少有效插件快照');
      const body = { pluginIds: snapshot.pluginIds, skillIds: snapshot.skillIds, entries: snapshot.plugins };
      if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== snapshot.snapshotHash) throw new Error('Codex Session Profile 快照 Hash 无效');
      if (new Set(snapshot.pluginIds).size !== snapshot.pluginIds.length || new Set(snapshot.skillIds).size !== snapshot.skillIds.length || snapshot.plugins.length !== snapshot.pluginIds.length) throw new Error('Codex Session Profile 快照内容不一致');
      const entries = new Map(snapshot.plugins.map(entry => [entry.pluginId, entry]));
      const entrySkillIds = snapshot.plugins.flatMap(entry => entry.skillIds);
      if ([...entries.keys()].some(id => !snapshot.pluginIds.includes(id)) || snapshot.pluginIds.some(id => !entries.has(id)) || new Set(entrySkillIds).size !== entrySkillIds.length || entrySkillIds.length !== snapshot.skillIds.length || entrySkillIds.some(id => !snapshot.skillIds.includes(id))) throw new Error('Codex Session Profile 快照插件或 Skill 列表不一致');
      for (const entry of snapshot.plugins) {
        const plugin = this.getPlugin(entry.pluginId);
        if (plugin.contentHash !== entry.contentHash || plugin.version !== entry.version) throw new Error(`Codex Session Profile 插件 ${entry.pluginId} 版本或内容已变化`);
        const pluginSkills = this.store.listPluginSkills(plugin.id);
        const pluginMcps = this.store.listPluginMcpServers(plugin.id);
        if (entry.skillIds.some(id => !pluginSkills.some(skill => skill.id === id)) || entry.mcpServerIds.some(id => !pluginMcps.some(server => server.id === id))) throw new Error(`Codex Session Profile 插件 ${entry.pluginId} 的 Skill 或 MCP Store 记录已变化`);
      }
      pluginIds = snapshot.pluginIds;
    }
    const plugins = pluginIds.map(id => this.getPlugin(id));
    if (plugins.some(plugin => plugin.trustStatus !== 'trusted' || (profileId === 'plugin-manager' && !plugin.enabled))) throw new Error('Codex Profile 选择中包含未启用或未信任的插件');
    return this.syncSelected(profileId, plugins);
  }
}

function byExpectedId(installed: CodexInstalledPlugin[], pluginId: string): boolean { return installed.some(item => item.pluginId === pluginId); }


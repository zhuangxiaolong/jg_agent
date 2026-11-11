import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath, stat, lstat } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export type WorkspaceRepositoryRole = 'frontend' | 'backend' | 'common' | 'service' | 'test' | 'deployment' | 'docs' | 'other';
export type WorkspaceAccess = 'read' | 'write';

export interface WorkspaceRepository {
  id: string;
  alias: string;
  name: string;
  rootPath: string;
  role: WorkspaceRepositoryRole;
  primary: boolean;
  access: WorkspaceAccess;
  description?: string;
  defaultBranch?: string;
  currentBranch?: string;
  remoteUrl?: string;
  status?: 'clean' | 'dirty' | 'conflicted' | 'unavailable';
}

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  system?: string;
  instructions?: string;
  primaryRepositoryId?: string;
  repositories: WorkspaceRepository[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceContextRepository {
  alias: string;
  role: WorkspaceRepositoryRole;
  rootPath: string;
  access: WorkspaceAccess;
  primary: boolean;
  description?: string;
  branch?: string;
  status?: WorkspaceRepository['status'];
}

export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  workspaceDescription?: string;
  instructions?: string;
  repositories: WorkspaceContextRepository[];
}

export interface GitRepositoryInspection {
  rootPath: string;
  name: string;
  currentBranch: string;
  defaultBranch?: string;
  remoteUrl?: string;
  status: WorkspaceRepository['status'];
}

function cleanText(value: string | undefined, field: string, max: number, required = false, multiline = false): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${field}不能为空`);
    return undefined;
  }
  const text = multiline ? value.replace(/\r\n?/g, '\n').trim() : value.trim();
  if (required && !text) throw new Error(`${field}不能为空`);
  if (text.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(text)) throw new Error(`${field}格式无效`);
  return text || undefined;
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function optionalText(value: string | undefined, field: string, maximum: number): string | undefined {
  return cleanText(value, field, maximum, false, true);
}

/** 校验工作区仓库别名、路径和读写范围，拒绝重复别名或重复实际仓库。 */
export function validateWorkspace(input: Workspace): Workspace {
  if (!input || typeof input !== 'object') throw new Error('工作区格式无效');
  const name = cleanText(input.name, '工作区名称', 100, true)!;
  if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error('工作区 ID 无效');
  if (!Array.isArray(input.repositories)) throw new Error('工作区仓库列表格式无效');
  const aliases = new Set<string>();
  const roots = new Set<string>();
  const ids = new Set<string>();
  let primaryCount = 0;
  const repositories = input.repositories.map(repository => {
    if (!repository || typeof repository !== 'object' || typeof repository.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(repository.id)) throw new Error('仓库 ID 无效');
    if (ids.has(repository.id)) throw new Error(`工作区仓库 ID 重复：${repository.id}`);
    ids.add(repository.id);
    const alias = cleanText(repository.alias, '仓库别名', 64, true)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) throw new Error(`仓库别名无效：${alias}`);
    const aliasKey = alias.toLowerCase();
    if (aliases.has(aliasKey)) throw new Error(`工作区仓库别名重复：${alias}`);
    aliases.add(aliasKey);
    if (typeof repository.rootPath !== 'string' || !repository.rootPath.trim() || !path.isAbsolute(repository.rootPath)) throw new Error('仓库根目录必须是绝对路径');
    const rootPath = path.resolve(repository.rootPath);
    if (roots.has(canonical(rootPath))) throw new Error(`工作区内重复添加仓库：${rootPath}`);
    roots.add(canonical(rootPath));
    if (!['frontend', 'backend', 'common', 'service', 'test', 'deployment', 'docs', 'other'].includes(repository.role)) throw new Error(`仓库角色无效：${String(repository.role)}`);
    if (repository.access !== 'read' && repository.access !== 'write') throw new Error('仓库读写意图无效');
    if (typeof repository.primary !== 'boolean') throw new Error('主仓库标记无效');
    if (repository.primary) primaryCount++;
    if (repository.status !== undefined && !['clean', 'dirty', 'conflicted', 'unavailable'].includes(repository.status)) throw new Error('仓库状态无效');
    return {
      id: repository.id,
      alias,
      name: cleanText(repository.name, '仓库名称', 160, true)!,
      rootPath,
      role: repository.role,
      primary: repository.primary,
      access: repository.access,
      ...(optionalText(repository.description, '仓库说明', 2000) ? { description: optionalText(repository.description, '仓库说明', 2000) } : {}),
      ...(optionalText(repository.defaultBranch, '默认分支', 200) ? { defaultBranch: optionalText(repository.defaultBranch, '默认分支', 200) } : {}),
      ...(optionalText(repository.currentBranch, '当前分支', 200) ? { currentBranch: optionalText(repository.currentBranch, '当前分支', 200) } : {}),
      ...(repository.remoteUrl ? { remoteUrl: sanitizeRemoteUrl(repository.remoteUrl) } : {}),
      ...(repository.status ? { status: repository.status } : {}),
    };
  });
  if (primaryCount > 1) throw new Error('工作区只能有一个主仓库');
  const primaryRepositoryId = input.primaryRepositoryId ?? repositories.find(item => item.primary)?.id ?? repositories[0]?.id;
  if (primaryRepositoryId && !repositories.some(item => item.id === primaryRepositoryId)) throw new Error('主仓库不存在');
  const markedPrimary = repositories.find(item => item.primary);
  if (markedPrimary && markedPrimary.id !== primaryRepositoryId) throw new Error('主仓库标记与主仓库 ID 不一致');
  const createdAt = cleanText(input.createdAt, '创建时间', 40, true)!;
  const updatedAt = cleanText(input.updatedAt, '更新时间', 40, true)!;
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('工作区时间格式无效');
  return {
    id: input.id,
    name,
    ...(optionalText(input.description, '工作区描述', 4000) ? { description: optionalText(input.description, '工作区描述', 4000) } : {}),
    ...(optionalText(input.system, '业务系统标签', 100) ? { system: optionalText(input.system, '业务系统标签', 100) } : {}),
    ...(optionalText(input.instructions, '工作区说明', 20000) ? { instructions: optionalText(input.instructions, '工作区说明', 20000) } : {}),
    primaryRepositoryId,
    repositories: repositories.map(item => ({ ...item, primary: item.id === primaryRepositoryId })),
    createdAt,
    updatedAt,
  };
}

export function buildWorkspaceContext(workspace: Workspace): WorkspaceContext {
  const checked = validateWorkspace(workspace);
  const repositories = checked.repositories.map(repository => ({
    alias: repository.alias,
    role: repository.role,
    rootPath: repository.rootPath,
    access: repository.access,
    primary: repository.id === checked.primaryRepositoryId,
    ...(repository.description ? { description: repository.description } : {}),
    ...(repository.currentBranch ? { branch: repository.currentBranch } : {}),
    ...(repository.status ? { status: repository.status } : {}),
  }));
  return {
    workspaceId: checked.id,
    workspaceName: checked.name,
    ...(checked.description ? { workspaceDescription: checked.description } : {}),
    ...(checked.instructions ? { instructions: checked.instructions } : {}),
    repositories,
  };
}

/** 通过 Git 只读命令识别仓库根目录和状态；不会修改仓库内容。 */
export async function inspectGitRepository(selectedPath: string): Promise<GitRepositoryInspection> {
  let selected: string;
  try {
    await assertNoLinkSegments(path.resolve(selectedPath));
    selected = await realpath(path.resolve(selectedPath));
    const selectedStat = await stat(selected);
    if (!selectedStat.isDirectory()) throw new Error('所选路径不是目录');
  } catch {
    throw new Error('所选目录不存在或不可访问');
  }
  const run = async (cwd: string, args: string[]) => (await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true, maxBuffer: 1024 * 1024 })).stdout.trim();
  let rootPath: string;
  try { rootPath = await realpath(path.resolve(await run(selected, ['rev-parse', '--show-toplevel']))); }
  catch { throw new Error('所选目录不是 Git 仓库，或 Git 不可用'); }
  try {
    await assertNoLinkSegments(rootPath);
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory()) throw new Error('Git 仓库根目录不是目录');
  } catch (error) {
    if (error instanceof Error && (error.message.includes('符号链接') || error.message.includes('junction') || error.message.includes('不是目录'))) throw error;
    throw new Error('Git 仓库根目录不可访问');
  }
  const output = async (args: string[]) => {
    try { return await run(rootPath, args); }
    catch { return ''; }
  };
  const currentBranch = await output(['branch', '--show-current']);
  const status = await output(['status', '--porcelain=v1']);
  const remotes = await output(['remote', '-v']);
  const origin = remotes.split(/\r?\n/).find(line => /\s+\(fetch\)$/.test(line));
  const remoteUrl = sanitizeRemoteUrl(origin?.replace(/\s+\(fetch\)$/, '').replace(/^\S+\s+/, '') || undefined);
  const symbolic = await output(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const defaultBranch = symbolic.replace(/^origin\//, '') || undefined;
  return { rootPath, name: path.basename(rootPath), currentBranch: currentBranch || '(detached)', ...(defaultBranch ? { defaultBranch } : {}), ...(remoteUrl ? { remoteUrl } : {}), status: status ? (/^(?:UU|AA|DD|AU|UD|UA|DU|DD)/m.test(status) ? 'conflicted' : 'dirty') : 'clean' };
}

async function assertNoLinkSegments(absolutePath: string): Promise<void> {
  const segments: string[] = [];
  let current = path.resolve(absolutePath);
  while (true) {
    segments.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const segment of segments.reverse()) {
    const info = await lstat(segment);
    if (info.isSymbolicLink()) throw new Error('仓库路径不能经过符号链接或 junction');
  }
}

/** 仓库地址可能含有用户名、口令或访问令牌；元数据只保留不含凭据的地址。 */
export function sanitizeRemoteUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const remote = value.trim();
  if (!remote || /[\x00-\x1f\x7f]/.test(remote)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const url = new URL(remote);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch { return undefined; }
  }
  // SCP 风格地址：丢弃 user@ 前缀，避免把自定义认证用户名保存到工作区数据库。
  return remote.replace(/^([^/@:]+)@(?=[^/:]+:)/, '');
}

export function workspacePromptContext(context: WorkspaceContext): string {
  const lines = [
    `【工作区】${context.workspaceName}（ID：${context.workspaceId}）`,
    context.workspaceDescription ? `说明：${context.workspaceDescription}` : '',
    '【工作区仓库元数据（不构成 Runtime 文件访问授权）】',
    ...context.repositories.map(repository => `- [${repository.alias}] ${repository.role}${repository.primary ? '；主仓库' : ''}${repository.branch ? `；分支：${repository.branch}` : ''}`),
    context.instructions ? `【工作区开发说明】\n${context.instructions}` : '',
    '当前 Runtime 的文件访问范围仍由会话工作目录和 Runtime ACL 决定；以上工作区元数据不会扩大访问范围。',
  ];
  return lines.filter(Boolean).join('\n');
}

export { WorkspaceService, workspaceRuntimeCapability } from './service';
export type { AddWorkspaceRepositoryInput, CreateWorkspaceInput, WorkspaceMetadataStore, WorkspaceServiceOptions, WorkspaceRuntimeCapability } from './service';

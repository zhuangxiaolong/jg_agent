import { randomUUID } from 'node:crypto';
import { inspectGitRepository, sanitizeRemoteUrl, validateWorkspace, type Workspace, type WorkspaceRepository, type WorkspaceRepositoryRole } from './index';

/** LocalStore 提供的独立 Workspace JSON 元数据接口。 */
export interface WorkspaceMetadataStore {
  listWorkspaces<T>(): T[];
  getWorkspace<T>(id: string): T | undefined;
  saveWorkspace<T extends { id: string }>(workspace: T): void;
  deleteWorkspace(id: string): void;
}

export interface CreateWorkspaceInput {
  name: string;
  repositoryPath?: string;
  description?: string;
  system?: string;
  instructions?: string;
  alias?: string;
  role?: WorkspaceRepositoryRole;
  access?: WorkspaceRepository['access'];
}

export interface AddWorkspaceRepositoryInput {
  selectedPath: string;
  alias?: string;
  role?: WorkspaceRepositoryRole;
  access?: WorkspaceRepository['access'];
  description?: string;
}

export interface WorkspaceServiceOptions {
  /** 工作区关联正在被任务使用时，由桌面主进程注入检查器并阻止编辑/删除。 */
  isWorkspaceBusy?: (workspaceId: string) => boolean;
}

function normalizedRoot(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function checkedWorkspace(value: Workspace): Workspace {
  const workspace = validateWorkspace(value);
  if (Buffer.byteLength(JSON.stringify(workspace), 'utf8') > 1024 * 1024) throw new Error('工作区元数据超过 1 MiB 上限');
  return workspace;
}

/** 管理工作区配置；仓库目录通过只读 Git 查询识别，移除只解除关联。 */
export class WorkspaceService {
  constructor(private readonly store: WorkspaceMetadataStore, private readonly options: WorkspaceServiceOptions = {}) {}

  list(): Workspace[] {
    return this.store.listWorkspaces<Workspace>().map(checkedWorkspace);
  }

  getById(id: string): Workspace {
    const value = this.store.getWorkspace<Workspace>(id);
    if (!value) throw new Error('工作区不存在');
    return checkedWorkspace(value);
  }

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const now = new Date().toISOString();
    const inspection = input.repositoryPath ? await inspectGitRepository(input.repositoryPath) : undefined;
    const repository: WorkspaceRepository | undefined = inspection ? {
      id: randomUUID(), alias: input.alias?.trim() || inspection.name, name: inspection.name,
      rootPath: inspection.rootPath, role: input.role ?? 'other', primary: true,
      access: input.access ?? 'read', currentBranch: inspection.currentBranch,
      defaultBranch: inspection.defaultBranch, remoteUrl: sanitizeRemoteUrl(inspection.remoteUrl), status: inspection.status,
    } : undefined;
    const workspace = checkedWorkspace({
      id: randomUUID(), name: input.name, description: input.description, system: input.system,
      instructions: input.instructions, primaryRepositoryId: repository?.id,
      repositories: repository ? [repository] : [], createdAt: now, updatedAt: now,
    });
    this.assertNameUnique(workspace.name);
    this.store.saveWorkspace(workspace);
    return workspace;
  }

  update(id: string, input: { name: string; description?: string; system?: string; instructions?: string }): Workspace {
    this.assertIdle(id);
    const current = this.getById(id);
    const updated = checkedWorkspace({ ...current, ...input, id, updatedAt: new Date().toISOString() });
    this.assertNameUnique(updated.name, id);
    this.store.saveWorkspace(updated);
    return updated;
  }

  async addRepository(id: string, input: AddWorkspaceRepositoryInput): Promise<Workspace> {
    this.assertIdle(id);
    const current = this.getById(id);
    const inspection = await inspectGitRepository(input.selectedPath);
    if (current.repositories.some(item => normalizedRoot(item.rootPath) === normalizedRoot(inspection.rootPath))) throw new Error('该仓库已加入此工作区');
    const repository: WorkspaceRepository = {
      id: randomUUID(), alias: input.alias?.trim() || inspection.name, name: inspection.name,
      rootPath: inspection.rootPath, role: input.role ?? 'other', primary: false,
      access: input.access ?? 'read', ...(input.description ? { description: input.description } : {}),
      currentBranch: inspection.currentBranch, defaultBranch: inspection.defaultBranch,
      remoteUrl: sanitizeRemoteUrl(inspection.remoteUrl), status: inspection.status,
    };
    const updated = checkedWorkspace({ ...current, updatedAt: new Date().toISOString(), repositories: [...current.repositories, repository] });
    this.store.saveWorkspace(updated);
    return updated;
  }

  updateRepository(id: string, repositoryId: string, input: Pick<WorkspaceRepository, 'alias' | 'role' | 'access'> & { description?: string }): Workspace {
    this.assertIdle(id);
    const current = this.getById(id);
    if (!current.repositories.some(item => item.id === repositoryId)) throw new Error('仓库不属于此工作区');
    const repositories = current.repositories.map(item => item.id === repositoryId ? { ...item, ...input } : item);
    const updated = checkedWorkspace({ ...current, updatedAt: new Date().toISOString(), repositories });
    this.store.saveWorkspace(updated);
    return updated;
  }

  setPrimaryRepository(id: string, repositoryId: string): Workspace {
    this.assertIdle(id);
    const current = this.getById(id);
    if (!current.repositories.some(item => item.id === repositoryId)) throw new Error('主仓库不属于此工作区');
    const updated = checkedWorkspace({ ...current, updatedAt: new Date().toISOString(), primaryRepositoryId: repositoryId });
    this.store.saveWorkspace(updated);
    return updated;
  }

  removeRepository(id: string, repositoryId: string): Workspace {
    this.assertIdle(id);
    const current = this.getById(id);
    if (!current.repositories.some(item => item.id === repositoryId)) throw new Error('仓库不属于此工作区');
    const repositories = current.repositories.filter(item => item.id !== repositoryId);
    const primaryRepositoryId = current.primaryRepositoryId === repositoryId ? repositories[0]?.id : current.primaryRepositoryId;
    const updated = checkedWorkspace({ ...current, updatedAt: new Date().toISOString(), repositories, primaryRepositoryId });
    this.store.saveWorkspace(updated);
    return updated;
  }

  delete(id: string): void {
    this.assertIdle(id);
    if (!this.store.getWorkspace<Workspace>(id)) throw new Error('工作区不存在');
    this.store.deleteWorkspace(id);
  }

  async refreshRepository(id: string, repositoryId: string): Promise<Workspace> {
    const current = this.getById(id);
    const target = current.repositories.find(item => item.id === repositoryId);
    if (!target) throw new Error('仓库不属于此工作区');
    try {
      const inspection = await inspectGitRepository(target.rootPath);
      if (normalizedRoot(inspection.rootPath) !== normalizedRoot(target.rootPath)) throw new Error('Git 根目录已变化，请移除后重新添加仓库');
      const repositories = current.repositories.map(item => item.id === repositoryId ? { ...item, currentBranch: inspection.currentBranch, defaultBranch: inspection.defaultBranch, remoteUrl: sanitizeRemoteUrl(inspection.remoteUrl), status: inspection.status } : item);
      const updated = checkedWorkspace({ ...current, updatedAt: new Date().toISOString(), repositories });
      this.store.saveWorkspace(updated);
      return updated;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Git 根目录已变化')) throw error;
      const repositories = current.repositories.map(item => item.id === repositoryId ? { ...item, status: 'unavailable' as const } : item);
      const updated = checkedWorkspace({ ...current, updatedAt: new Date().toISOString(), repositories });
      this.store.saveWorkspace(updated);
      return updated;
    }
  }

  private assertIdle(id: string): void {
    if (this.options.isWorkspaceBusy?.(id)) throw new Error('该工作区有任务正在执行，请停止或等待任务完成后再修改');
  }

  private assertNameUnique(name: string, exceptId?: string): void {
    if (this.list().some(item => item.id !== exceptId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error(`工作区名称已存在：${name}`);
  }
}

export interface WorkspaceRuntimeCapability {
  multiRepositoryExecution: false;
  reason: string;
}

/** Runtime 目前没有经验证的多根目录 ACL；工作区多仓库执行保持禁用。 */
export function workspaceRuntimeCapability(workspace: Workspace): WorkspaceRuntimeCapability {
  return {
    multiRepositoryExecution: false,
    reason: workspace.repositories.length > 1
      ? '当前 Runtime 仅证明单一会话工作目录的访问范围；多仓库 Runtime ACL 未验证，已禁用工作区多仓库执行。'
      : 'Workspace 执行尚未接入 Runtime 会话授权；请使用现有单项目会话入口。',
  };
}

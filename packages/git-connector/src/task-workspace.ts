import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Project, Session } from '../../domain/src';
import { GitConnector, type GitWorkspaceMetadata, type GitWorkspaceChanges } from './index';

type ParentSession = Pick<Session, 'id' | 'projectId' | 'workspacePath' | 'branch'>;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{40,64}$/;

export interface TaskWorkspaceRecord {
  version: 1; workspaceId: string; taskId: string; sessionId: string; projectId: string; projectPath: string;
  path: string; branch: string; baseBranch: string; baseCommit: string; repositoryId: string;
  createdAt: string; retained: true;
}
export interface TaskWorkspaceRepository {
  get(taskId: string): TaskWorkspaceRecord | undefined | Promise<TaskWorkspaceRecord | undefined>;
  save(record: TaskWorkspaceRecord): void | Promise<void>;
}
export interface TaskWorkspaceInspection {
  workspace: TaskWorkspaceRecord; metadata: GitWorkspaceMetadata; changes: GitWorkspaceChanges;
  stable: boolean; fingerprint: string;
}
export interface TaskIntegrationBlocker { code: string; message: string; paths?: string[] }
export interface TaskIntegrationEndpoint {
  branch: string; head: string | null; dirty: boolean | null; stateHash: string | null; fingerprint: string | null;
}
export interface TaskIntegrationPlan {
  version: 1; taskId: string; workspaceId: string; baseCommit: string; checkedAt: string;
  ready: boolean; requiresApproval: true; autoIntegration: false; approvalReason: string;
  source: TaskIntegrationEndpoint; target: TaskIntegrationEndpoint;
  changedFiles: Array<{ path: string; previousPath?: string; status: string; layer: string; contentHash: string }>;
  potentialConflictFiles: string[]; blockers: TaskIntegrationBlocker[]; fingerprint: string;
  limitations: string[];
}

/** 已生成的工作区即使记录保存失败也交回调用者保留，禁止用清理掩盖失败。 */
export class TaskWorkspaceCreationError extends Error {
  constructor(message: string, readonly workspace: TaskWorkspaceRecord) { super(message); this.name = 'TaskWorkspaceCreationError'; }
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function pathKey(value: string): string { const canonical = value.replaceAll('\\', '/'); return process.platform === 'win32' ? canonical.toLowerCase() : canonical; }
function samePath(left: string, right: string): boolean { return pathKey(resolve(left)) === pathKey(resolve(right)); }
function workspaceId(taskId: string): string { return `task-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`; }
function overlaps(left: string, right: string): boolean { const a = pathKey(left), b = pathKey(right); return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function endpoint(metadata?: GitWorkspaceMetadata, fingerprint?: string): TaskIntegrationEndpoint {
  return { branch: metadata?.branch ?? '', head: metadata?.head ?? null, dirty: metadata?.dirty ?? null, stateHash: metadata?.stateHash ?? null, fingerprint: fingerprint ?? null };
}

/** 任务工作区只负责创建、保留和人工集成前检查，不执行集成或清理。 */
export class TaskWorkspaceManager {
  private readonly records = new Map<string, TaskWorkspaceRecord>();

  constructor(private readonly git: GitConnector, private readonly repository?: TaskWorkspaceRepository) {}

  private async get(taskId: string): Promise<TaskWorkspaceRecord | undefined> {
    return this.repository ? this.repository.get(taskId) : this.records.get(taskId);
  }

  private async save(record: TaskWorkspaceRecord): Promise<void> {
    this.records.set(record.taskId, structuredClone(record));
    await this.repository?.save(structuredClone(record));
  }

  private async validateRecord(record: TaskWorkspaceRecord): Promise<void> {
    if (record.version !== 1 || !TASK_ID.test(record.taskId) || !TASK_ID.test(record.sessionId) || !TASK_ID.test(record.projectId)
      || record.workspaceId !== workspaceId(record.taskId) || !SHA.test(record.baseCommit) || !/^[a-f0-9]{64}$/.test(record.repositoryId)
      || record.retained !== true || !Number.isFinite(Date.parse(record.createdAt))) throw new Error('任务工作区映射无效');
    const location = this.git.managedWorkspaceLocation(record.workspaceId);
    if (!samePath(await realpath(record.path), await realpath(location.path)) || record.branch !== location.branch || !record.baseBranch.startsWith('agent/')) throw new Error('任务工作区路径或分支映射不一致');
  }

  async create(input: { taskId: string; project: Project; parentSession: ParentSession }): Promise<TaskWorkspaceRecord> {
    if (!TASK_ID.test(input.taskId) || !TASK_ID.test(input.parentSession.id)) throw new Error('任务或会话ID无效');
    const existing = await this.get(input.taskId);
    if (existing) {
      if (existing.sessionId !== input.parentSession.id || existing.projectId !== input.project.id || !samePath(existing.projectPath, input.project.path)) throw new Error('任务工作区已绑定其他会话或项目');
      await this.inspect(existing);
      return structuredClone(existing);
    }
    const project = await this.git.register(input.project.path);
    if (project.id !== input.project.id || input.parentSession.projectId !== project.id) throw new Error('父会话与任务项目不一致');
    const before = await this.git.inspectWorkspace(input.parentSession.workspacePath);
    const repositoryId = await this.git.repositoryIdentity(project.path);
    if (before.repositoryId !== repositoryId || before.branch !== input.parentSession.branch || before.branch !== `agent/${input.parentSession.id}`) throw new Error('父会话工作区不属于当前项目或分支已变化');
    if (before.dirty || before.unmergedFiles.length || before.unsafeIndexFiles.length || before.truncated) throw new Error('父会话工作区有未提交变更、冲突、隐藏索引标志或状态不完整，不能创建任务基准');
    const id = workspaceId(input.taskId);
    const created = await this.git.createWorkspace(project, id, before.branch);
    const record: TaskWorkspaceRecord = {
      version: 1, workspaceId: id, taskId: input.taskId, sessionId: input.parentSession.id,
      projectId: project.id, projectPath: project.path, path: created.path, branch: created.branch,
      baseBranch: before.branch, baseCommit: before.head, repositoryId, createdAt: new Date().toISOString(), retained: true,
    };
    try {
      const actual = await this.git.inspectWorkspace(created.path);
      record.baseCommit = actual.head;
      const after = await this.git.inspectWorkspace(input.parentSession.workspacePath);
      if (actual.repositoryId !== repositoryId || actual.head !== before.head || actual.dirty || actual.unmergedFiles.length || actual.unsafeIndexFiles.length || actual.truncated
        || after.stateHash !== before.stateHash || after.dirty || after.truncated) throw new Error('创建任务工作区期间父基准或新工作区发生变化，已保留工作区等待人工检查');
      await this.save(record);
      return structuredClone(record);
    } catch (error) {
      this.records.set(record.taskId, structuredClone(record));
      throw new TaskWorkspaceCreationError(error instanceof Error ? error.message : '任务工作区创建后检查失败，成果已保留', structuredClone(record));
    }
  }

  async inspect(record: TaskWorkspaceRecord): Promise<TaskWorkspaceInspection> {
    await this.validateRecord(record);
    const known = await this.get(record.taskId);
    if (known && hash(known) !== hash(record)) throw new Error('任务工作区映射与已保存记录不一致');
    const project = await this.git.register(record.projectPath);
    const repositoryId = await this.git.repositoryIdentity(project.path);
    const metadata = await this.git.inspectWorkspace(record.path);
    if (project.id !== record.projectId || repositoryId !== record.repositoryId || metadata.repositoryId !== repositoryId || metadata.branch !== record.branch) throw new Error('任务工作区仓库或分支身份已变化');
    const initialChanges = await this.git.changesSince(record.path, record.baseCommit);
    const changes = await this.git.changesSince(record.path, record.baseCommit);
    const after = await this.git.inspectWorkspace(record.path);
    const stable = metadata.stateHash === after.stateHash && changes.head === metadata.head && initialChanges.fingerprint === changes.fingerprint;
    return { workspace: structuredClone(record), metadata: after, changes, stable,
      fingerprint: hash({ workspaceId: record.workspaceId, baseCommit: record.baseCommit, stateHash: after.stateHash, changes: changes.fingerprint, stable }) };
  }

  async prepareIntegration(record: TaskWorkspaceRecord, targetSession: ParentSession): Promise<TaskIntegrationPlan> {
    const blockers: TaskIntegrationBlocker[] = [];
    const add = (code: string, message: string, paths?: string[]) => blockers.push({ code, message, ...(paths?.length ? { paths: [...new Set(paths)].sort() } : {}) });
    let source: TaskWorkspaceInspection | undefined, target: GitWorkspaceMetadata | undefined, targetChanges: GitWorkspaceChanges | undefined;
    try { source = await this.inspect(record); }
    catch { add('SOURCE_INSPECTION_FAILED', '任务工作区映射、仓库身份、冻结基准或路径检查失败，请人工检查保留的工作区'); }
    try {
      target = await this.git.inspectWorkspace(targetSession.workspacePath);
      if (targetSession.projectId !== record.projectId || target.repositoryId !== record.repositoryId) add('REPOSITORY_MISMATCH', '源任务与集成目标不属于同一项目仓库');
      if (targetSession.id !== record.sessionId || target.branch !== targetSession.branch || target.branch !== record.baseBranch) add('TARGET_IDENTITY_CHANGED', '集成目标必须为任务创建时的父会话受管分支');
      if (samePath(target.path, record.path)) add('SAME_WORKSPACE', '任务工作区不能集成到自身');
      if (target.dirty) add('TARGET_DIRTY', '目标存在未提交变更，必须先人工处理');
      if (target.unmergedFiles.length) add('TARGET_UNMERGED', '目标存在尚未解决的真实Git冲突', target.unmergedFiles);
      if (target.unsafeIndexFiles.length) add('TARGET_UNSAFE_INDEX', '目标含assume-unchanged或skip-worktree标志，无法信任dirty检查', target.unsafeIndexFiles);
      if (target.head !== record.baseCommit) add('BASE_DRIFT', '目标HEAD已偏离任务冻结基准，必须人工重新评估，未自动合并或覆盖');
      if (target.truncated) add('TARGET_TRUNCATED', '目标状态检查被截断，无法确认完整性');
      if (target.repositoryId === record.repositoryId) targetChanges = await this.git.changesSince(target.path, record.baseCommit);
    } catch { add('TARGET_INSPECTION_FAILED', '目标工作区、分支、冻结基准或路径检查失败'); }
    const changes = source?.changes.changes ?? [];
    const incomingPaths = [...new Set(changes.flatMap(change => [change.path, ...(change.previousPath ? [change.previousPath] : [])]))];
    const potentialConflictFiles = new Set<string>();
    if (source) {
      if (!source.stable) add('SOURCE_CHANGED', '检查期间源工作区发生变化，请重新检查');
      if (source.metadata.dirty) add('SOURCE_DIRTY', '源任务仍有未提交成果，diff可查看，但当前不能准备提交式集成');
      if (source.metadata.unmergedFiles.length) add('SOURCE_UNMERGED', '源任务存在尚未解决的真实Git冲突', source.metadata.unmergedFiles);
      if (source.metadata.unsafeIndexFiles.length) add('SOURCE_UNSAFE_INDEX', '源任务含assume-unchanged或skip-worktree标志，无法信任dirty检查', source.metadata.unsafeIndexFiles);
      if (!source.changes.baseIsAncestor) add('BASE_NOT_ANCESTOR', '冻结基准不是源任务HEAD的祖先，必须人工检查历史');
      if (source.metadata.truncated || source.changes.truncated) add('SOURCE_TRUNCATED', '源任务变更检查被截断，不能根据不完整diff批准集成');
      const unsafe = changes.filter(change => change.unsafeReasons.length).flatMap(change => [change.path, ...(change.previousPath ? [change.previousPath] : [])]);
      if (unsafe.length) add('SOURCE_UNSAFE_PATH', '源任务含敏感、越界、链接或特殊文件路径，未读取危险正文', unsafe);
      if (!changes.some(change => change.layer === 'committed')) add('NO_COMMITTED_CHANGES', '源任务没有基于冻结基准的已提交成果');
    }
    if (targetChanges) {
      if (targetChanges.truncated) add('TARGET_CHANGES_TRUNCATED', '目标基准变化检查被截断');
      const targetPaths = targetChanges.changes.flatMap(change => [change.path, ...(change.previousPath ? [change.previousPath] : [])]);
      for (const file of incomingPaths) if (targetPaths.some(targetFile => overlaps(file, targetFile))) potentialConflictFiles.add(file);
      if (potentialConflictFiles.size) add('POTENTIAL_PATH_CONFLICT', '双方修改存在同文件或文件/目录祖先重叠，仅表示潜在冲突，尚未执行merge验证', [...potentialConflictFiles]);
    }
    if (target && source) {
      const risks = await this.git.inspectIncomingPaths(target.path, incomingPaths).catch(() => [{ path: '（目标路径）', reason: '目标路径安全检查失败' }]);
      for (const risk of risks) add('TARGET_PATH_RISK', risk.reason, [risk.path]);
      const after = await this.git.inspectWorkspace(target.path).catch(() => undefined);
      const sourceAfter = await this.git.inspectWorkspace(record.path).catch(() => undefined);
      const finalTargetChanges = targetChanges ? await this.git.changesSince(target.path, record.baseCommit).catch(() => undefined) : undefined;
      if (!after || after.stateHash !== target.stateHash || !sourceAfter || sourceAfter.stateHash !== source.metadata.stateHash
        || (targetChanges && finalTargetChanges?.fingerprint !== targetChanges.fingerprint)) add('WORKSPACE_CHANGED', '预检期间源或目标状态或diff正文发生变化，请重新检查');
    }
    const sourceEndpoint = endpoint(source?.metadata, source?.fingerprint);
    const targetEndpoint = endpoint(target, targetChanges ? hash({ stateHash: target?.stateHash, changes: targetChanges.fingerprint }) : undefined);
    const changedFiles = changes.map(({ path, previousPath, status, layer, contentHash }) => ({ path, ...(previousPath ? { previousPath } : {}), status, layer, contentHash }));
    const plan = {
      version: 1 as const, taskId: record.taskId, workspaceId: record.workspaceId, baseCommit: record.baseCommit, checkedAt: new Date().toISOString(),
      ready: blockers.length === 0, requiresApproval: true as const, autoIntegration: false as const,
      approvalReason: '集成会修改父会话分支和文件，必须人工审批，并在实际操作前重新核对双端HEAD、dirty状态和指纹；本接口从未执行集成。',
      source: sourceEndpoint, target: targetEndpoint, changedFiles, potentialConflictFiles: [...potentialConflictFiles].sort(), blockers,
      limitations: ['仅执行只读预检，未执行merge/cherry-pick或质量验证', '文件路径重叠为潜在冲突判断，不能作为Git合并成功或失败的证据', '工作区与代码成果默认保留，不会因失败、取消或预检阻断而自动删除'],
    };
    return { ...plan, fingerprint: hash(plan) };
  }
}

import { z } from 'zod';
import type { AgentTask, Session, TaskWorkspaceDetail } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import type { GitConnector } from '../../../../packages/git-connector/src';
import { TaskWorkspaceCreationError, TaskWorkspaceManager, type TaskWorkspaceRecord } from '../../../../packages/git-connector/src/task-workspace';
import { taskContentHash } from '../../../../packages/agent-orchestrator/src';
import { redact } from './security';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const action = z.object({ sessionId: id, taskId: id, expectedStateVersion: z.number().int().min(0) }).strict();

/** 只开放隔离目录创建、读取和人工集成预检，IPC 不接受任意路径或 Git 命令。 */
export class TaskWorkspaceService {
  constructor(private readonly store: LocalStore, private readonly git: GitConnector, private readonly cleanText: (text: string) => string = redact) {}

  private context(sessionId: string, taskId: string): { task: AgentTask; session: Session } {
    id.parse(sessionId); id.parse(taskId);
    const task = this.store.listAgentTasks(sessionId).find(item => item.id === taskId);
    const session = this.store.getSession(sessionId);
    if (!task?.contractVersion || !session || !task.projectId || task.projectId !== session.projectId) throw new Error('工程任务不存在或不属于当前项目会话');
    return { task, session };
  }

  private mapping(sessionId: string, taskId: string): TaskWorkspaceRecord | undefined {
    const events = this.store.listTaskLifecycleEvents(sessionId, taskId).filter(event => event.eventType === 'workspace.created');
    const mapping = events.at(-1)?.payload.workspace;
    if (mapping === undefined) return undefined;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('工作区映射损坏，请保留现场并人工检查');
    return mapping as TaskWorkspaceRecord;
  }

  private manager(task: AgentTask): TaskWorkspaceManager {
    return new TaskWorkspaceManager(this.git, {
      get: taskId => { if (taskId !== task.id) throw new Error('工作区任务范围不匹配'); return this.mapping(task.sessionId, taskId); },
      save: mapping => {
        const current = this.context(task.sessionId, task.id).task;
        this.store.bindTaskWorkspace(current.sessionId, current.id, current.stateVersion ?? 0, mapping.path, { ...mapping });
      },
    });
  }

  async detail(sessionId: string, taskId: string): Promise<TaskWorkspaceDetail> {
    const { task } = this.context(sessionId, taskId);
    const record = this.mapping(sessionId, taskId);
    if (!record) return { stateVersion: task.stateVersion };
    if (task.workspacePath !== record.path) throw new Error('任务快照与持久工作区映射不一致，请保留现场');
    const inspection = await this.manager(task).inspect(record);
    return { stateVersion: this.context(sessionId, taskId).task.stateVersion, workspace: { path: record.path, branch: record.branch, baseCommit: record.baseCommit, retained: true }, stable: inspection.stable, changes: inspection.changes.changes.map(change => ({ ...change, truncated: Boolean(change.truncated), binary: Boolean(change.binary), diff: this.cleanText(change.diff) })) };
  }

  async create(value: unknown): Promise<TaskWorkspaceDetail> {
    const input = action.parse(value);
    const { task, session } = this.context(input.sessionId, input.taskId);
    if (task.stateVersion !== input.expectedStateVersion) throw new Error('任务状态已变化，请刷新后重试');
    if (task.workspaceMode !== 'worktree' || task.executionStatus === 'RUNNING') throw new Error('只有已停止的隔离开发任务可以创建工作区');
    const project = this.store.listProjects().find(item => item.id === task.projectId);
    if (!project) throw new Error('任务所属项目已不可用');
    try { await this.manager(task).create({ taskId: task.id, project, parentSession: session }); }
    catch (error) {
      if (error instanceof TaskWorkspaceCreationError) {
        const current = this.context(task.sessionId, task.id).task;
        this.store.bindTaskWorkspace(current.sessionId, current.id, current.stateVersion ?? 0, error.workspace.path, { ...error.workspace });
        this.store.appendTaskAuditEvent(task.sessionId, task.id, { eventType: 'workspace.retained', actor: 'platform', payload: { reasonCode: 'creation_postcheck_failed', workspaceId: error.workspace.workspaceId, mappingHash: taskContentHash(error.workspace) } });
      }
      throw error;
    }
    return this.detail(task.sessionId, task.id);
  }

  async prepareIntegration(value: unknown): Promise<TaskWorkspaceDetail> {
    const input = action.parse(value);
    const { task, session } = this.context(input.sessionId, input.taskId);
    if (task.stateVersion !== input.expectedStateVersion || task.executionStatus === 'RUNNING') throw new Error('任务状态已变化或正在执行，请停止后重新预检');
    const record = this.mapping(task.sessionId, task.id);
    if (!record || task.workspacePath !== record.path) throw new Error('任务尚未建立可信工作区映射');
    const manager = this.manager(task);
    const plan = await manager.prepareIntegration(record, session);
    if (this.context(task.sessionId, task.id).task.stateVersion !== input.expectedStateVersion) throw new Error('预检期间任务状态已变化，请刷新后重试');
    this.store.appendTaskAuditEvent(task.sessionId, task.id, { eventType: 'workspace.integration_prepared', actor: 'local-user', payload: { plan } });
    return { ...(await this.detail(task.sessionId, task.id)), integration: plan };
  }
}

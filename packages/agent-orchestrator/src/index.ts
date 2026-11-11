import type { AgentTask, AgentTaskResult, AgentTaskStatus, RuntimeKind } from '../../domain/src';
import { executionStatusOf, taskDependenciesSatisfied } from './engineering';
export * from './engineering';
export * from './governance';

export const TASK_GOVERNANCE_BLOCKED_PREFIX = '[TASK_GOVERNANCE_BLOCKED]';

export const DEFAULT_AGENT_CONCURRENCY = 3;
export const MAX_AGENT_TASKS_PER_SESSION = 100;
const TERMINAL: ReadonlySet<AgentTaskStatus> = new Set(['COMPLETED', 'CANCELLED']);
const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const ROLES: ReadonlySet<AgentTask['role']> = new Set(['requirement', 'architecture', 'developer', 'review', 'testing', 'documentation', 'custom']);
const RUNTIMES: ReadonlySet<RuntimeKind> = new Set(['codex', 'jinggong', 'claude_agent_sdk']);

export interface CreateAgentTaskInput {
  id: string;
  sessionId: string;
  projectId?: string;
  parentTaskId?: string;
  name: string;
  role: AgentTask['role'];
  description: string;
  input?: string;
  model?: string;
  runtimeKind?: RuntimeKind;
  workspaceMode?: AgentTask['workspaceMode'];
  workspacePath?: string;
  dependencyIds?: string[];
  maxAttempts?: number;
  timeoutMs?: number;
  now?: string;
}

export interface TaskTransition {
  status: AgentTaskStatus;
  now?: string;
  result?: AgentTaskResult;
  error?: string;
  workspacePath?: string;
}

function text(value: unknown, name: string, maximum: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${name}格式无效`);
  return value.trim();
}

function boundedInteger(value: number | undefined, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name}超出范围`);
  return value;
}

export function createAgentTask(input: CreateAgentTaskInput): AgentTask {
  const now = input.now ?? new Date().toISOString();
  if (!TASK_ID.test(input.id) || !TASK_ID.test(input.sessionId)) throw new Error('任务或会话 ID 无效');
  if (input.projectId !== undefined && !TASK_ID.test(input.projectId)) throw new Error('项目 ID 无效');
  if (input.parentTaskId !== undefined && !TASK_ID.test(input.parentTaskId)) throw new Error('父任务 ID 无效');
  if (!ROLES.has(input.role)) throw new Error('任务角色无效');
  if (input.runtimeKind !== undefined && !RUNTIMES.has(input.runtimeKind)) throw new Error('Runtime 类型无效');
  if (input.workspaceMode !== undefined && input.workspaceMode !== 'read' && input.workspaceMode !== 'worktree') throw new Error('工作区模式无效');
  if (Number.isNaN(Date.parse(now))) throw new Error('任务时间无效');
  const name = text(input.name, '任务名称', 120)!;
  const description = text(input.description, '任务描述', 20000)!;
  const dependencies = [...new Set(input.dependencyIds ?? [])];
  if (!dependencies.every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))) throw new Error('任务依赖 ID 无效');
  const workspaceMode = input.workspaceMode ?? 'read';
  if (workspaceMode === 'worktree' && !input.projectId) throw new Error('写入型任务必须绑定项目');
  if (workspaceMode === 'read' && input.workspacePath !== undefined) throw new Error('只读任务不能绑定写入工作区');
  return {
    id: input.id, sessionId: input.sessionId, ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), name,
    role: input.role, description, ...(input.input !== undefined ? { input: text(input.input, '任务输入', 50000, false) } : {}),
    ...(input.model ? { model: text(input.model, '模型', 160) } : {}), ...(input.runtimeKind ? { runtimeKind: input.runtimeKind } : {}),
    workspaceMode, ...(input.workspacePath ? { workspacePath: text(input.workspacePath, '工作区路径', 2000) } : {}),
    dependencyIds: dependencies, status: dependencies.length ? 'WAITING' : 'PENDING',
    maxAttempts: boundedInteger(input.maxAttempts, '最大尝试次数', 1, 3, 1), attempt: 0,
    ...(input.timeoutMs !== undefined ? { timeoutMs: boundedInteger(input.timeoutMs, '超时时间', 1000, 24 * 60 * 60 * 1000, 30 * 60 * 1000) } : {}),
    createdAt: now, updatedAt: now,
  };
}

export function assertTaskGraph(tasks: readonly AgentTask[]): void {
  if (tasks.length > MAX_AGENT_TASKS_PER_SESSION) throw new Error(`单会话最多 ${MAX_AGENT_TASKS_PER_SESSION} 个子任务`);
  const ids = new Set<string>();
  const byId = new Map<string, AgentTask>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`任务 ID 重复：${task.id}`);
    ids.add(task.id); byId.set(task.id, task);
  }
  for (const task of tasks) {
    if (!TASK_ID.test(task.id) || !TASK_ID.test(task.sessionId)) throw new Error('任务或会话 ID 无效');
    if (task.parentTaskId !== undefined) {
      if (task.parentTaskId === task.id) throw new Error(`任务不能作为自身的父任务：${task.id}`);
      const parent = byId.get(task.parentTaskId);
      if (!parent) throw new Error(`父任务不存在：${task.parentTaskId}`);
      if (parent.sessionId !== task.sessionId || parent.projectId !== task.projectId) throw new Error('父任务必须属于同一会话和项目');
    }
    if (task.dependencyIds.includes(task.id)) throw new Error(`任务不能依赖自身：${task.id}`);
    for (const dependencyId of task.dependencyIds) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new Error(`任务依赖不存在：${dependencyId}`);
      if (dependency.sessionId !== task.sessionId || dependency.projectId !== task.projectId) throw new Error('任务依赖必须属于同一会话和项目');
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('任务依赖关系存在循环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of byId.get(id)!.dependencyIds) visit(dependencyId);
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  const parentVisiting = new Set<string>();
  const parentVisited = new Set<string>();
  const visitParent = (id: string): void => {
    if (parentVisiting.has(id)) throw new Error('任务父子关系存在循环');
    if (parentVisited.has(id)) return;
    parentVisiting.add(id);
    const parentId = byId.get(id)!.parentTaskId;
    if (parentId) visitParent(parentId);
    parentVisiting.delete(id); parentVisited.add(id);
  };
  for (const task of tasks) visitParent(task.id);
}

export function reconcileTaskStates(tasks: readonly AgentTask[]): AgentTask[] {
  assertTaskGraph(tasks);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ordered: AgentTask[] = [];
  const visited = new Set<string>();
  const visit = (task: AgentTask): void => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const id of task.dependencyIds) visit(byId.get(id)!);
    ordered.push(task);
  };
  for (const task of tasks) visit(task);
  const reconciled = new Map<string, AgentTask>();
  const now = new Date().toISOString();
  for (const task of ordered) {
    if (TERMINAL.has(task.status) || task.status === 'RUNNING' || task.status === 'FAILED' || task.executionStatus === 'PAUSED' || task.executionStatus === 'INTERRUPTED' || task.contractVersion && task.status === 'BLOCKED' && task.error?.startsWith(TASK_GOVERNANCE_BLOCKED_PREFIX)) { reconciled.set(task.id, task); continue; }
    const dependencies = task.dependencyIds.map(id => reconciled.get(id)!);
    const status: AgentTaskStatus = dependencies.some(item => ['FAILED', 'CANCELLED', 'BLOCKED'].includes(item.status))
      ? 'BLOCKED'
      : !taskDependenciesSatisfied(task, [...reconciled.values()]) ? 'WAITING' : 'PENDING';
    const executionStatus = status === 'PENDING' ? 'READY' : status === 'WAITING' ? 'PENDING' : status;
    reconciled.set(task.id, status === task.status && (!task.executionStatus || task.executionStatus === executionStatus) ? task : { ...task, status, ...(task.executionStatus ? { executionStatus } : {}), updatedAt: now });
  }
  return tasks.map(task => reconciled.get(task.id)!);
}

export function nextRunnableTasks(tasks: readonly AgentTask[], maxConcurrency = DEFAULT_AGENT_CONCURRENCY): AgentTask[] {
  assertTaskGraph(tasks);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_AGENT_TASKS_PER_SESSION) throw new Error('并发上限无效');
  const active = tasks.filter(task => task.status === 'RUNNING').length;
  const slots = Math.max(0, maxConcurrency - active);
  const byId = new Map(tasks.map(task => [task.id, task]));
  return tasks.filter(task => task.status === 'PENDING' && executionStatusOf(task) === 'READY' && taskDependenciesSatisfied(task, tasks)).slice(0, slots);
}

export function schedulableAgentTasks(tasks: readonly AgentTask[], blockedSessionIds: ReadonlySet<string>): AgentTask[] {
  return tasks.filter(task => task.status === 'PENDING' && executionStatusOf(task) === 'READY' && !blockedSessionIds.has(task.sessionId));
}

export function terminalTaskStatus(eventText: string, requestedStatus?: 'FAILED' | 'CANCELLED'): 'COMPLETED' | 'FAILED' | 'CANCELLED' | undefined {
  if (!['completed', 'failed', 'interrupted'].includes(eventText)) return undefined;
  if (requestedStatus) return requestedStatus;
  if (eventText === 'completed') return 'COMPLETED';
  return 'FAILED';
}

const ALLOWED: Record<AgentTaskStatus, ReadonlySet<AgentTaskStatus>> = {
  PENDING: new Set(['RUNNING', 'CANCELLED', 'WAITING']), WAITING: new Set(['PENDING', 'CANCELLED', 'BLOCKED']),
  RUNNING: new Set(['COMPLETED', 'FAILED', 'CANCELLED']), FAILED: new Set(['PENDING', 'CANCELLED']),
  COMPLETED: new Set(), CANCELLED: new Set(), BLOCKED: new Set(['PENDING', 'CANCELLED']),
};

export function transitionAgentTask(task: AgentTask, transition: TaskTransition, taskGraph?: readonly AgentTask[]): AgentTask {
  if (!ALLOWED[task.status].has(transition.status)) throw new Error(`不允许的任务状态转换：${task.status} -> ${transition.status}`);
  if ((transition.status === 'RUNNING' || transition.status === 'PENDING') && task.dependencyIds.length) {
    if (!taskGraph) throw new Error('依赖任务的状态转换必须提供完整任务图');
    assertTaskGraph(taskGraph);
    if (!taskDependenciesSatisfied(task, taskGraph)) throw new Error('依赖任务尚未全部完成、验证或验收');
  }
  if (transition.status === 'RUNNING' && task.attempt >= task.maxAttempts) throw new Error('任务已达到最大尝试次数，不能再次运行');
  if (transition.status === 'PENDING' && task.status === 'FAILED' && task.attempt >= task.maxAttempts) throw new Error('失败任务已达到最大重试次数');
  const now = transition.now ?? new Date().toISOString();
  const next: AgentTask = { ...task, status: transition.status, updatedAt: now };
  if (task.executionStatus || task.contractVersion) next.executionStatus = transition.status === 'PENDING' ? 'READY' : transition.status === 'WAITING' ? 'PENDING' : transition.status;
  if (transition.status === 'RUNNING') { next.attempt += 1; next.startedAt = now; next.completedAt = undefined; next.error = undefined; }
  if (transition.status === 'COMPLETED' || transition.status === 'FAILED' || transition.status === 'CANCELLED') next.completedAt = now;
  if (transition.result !== undefined) next.result = transition.result;
  if (transition.error !== undefined) next.error = text(transition.error, '任务错误', 12000, false);
  if (transition.workspacePath !== undefined) next.workspacePath = text(transition.workspacePath, '工作区路径', 2000);
  return next;
}

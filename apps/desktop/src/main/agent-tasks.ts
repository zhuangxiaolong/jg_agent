import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRuntimeGovernance, assertTaskPathAllowed, canonicalTaskArgumentsHash, classifyRetryFailure, executionStatusOf, GovernanceError, GovernedToolGateway, nextRunnableTasks, normalizeTaskRelativePath, reconcileTaskStates, resolveTaskBudgetPolicy, retryPolicyDecision, schedulableAgentTasks, TASK_GOVERNANCE_BLOCKED_PREFIX, TaskBudgetGuard, TaskCircuitBreaker, taskContentHash, terminalTaskStatus, transitionAgentTask, type RetryFailure, type ResolvedTaskBudget } from '../../../../packages/agent-orchestrator/src';
import { createCodexRuntimeAdapter, createJinggongRuntimeAdapter, type RuntimeAdapter } from '../../../../packages/agent-runtime/src';
import type { RuntimeEvent, RuntimeOptions } from '../../../../packages/agent-runtime/src';
import type { AgentTask, AgentTaskEvent, AgentTaskStatus, RuntimeKind, Session, TaskBudgetPolicy, TaskContract } from '../../../../packages/domain/src';
import { applicableDocuments, buildDeveloperContext } from '../../../../packages/policy/src';
import { sessionMemories } from './session-memory';
import type { SettingsService } from './settings';
import type { LocalStore } from '../../../../packages/storage/src';

const MAX_CONCURRENCY = 3;
const ANALYSIS_ROLES: Record<AgentTask['role'], string> = {
  requirement: '需求分析', architecture: '架构分析', developer: '代码分析', review: '代码审查',
  testing: '测试分析', documentation: '文档整理', custom: '自定义分析',
};

/** 自动规划创建分工分析任务，由主 Agent 汇总分析结果并负责实现、提交和发布。 */
export const AUTOMATIC_AGENT_TASK_PREFIX = '自动子Agent';
export interface AutomaticAgentTaskPlan {
  role: AgentTask['role'];
  name: string;
  description: string;
  outputExpectations: string[];
  acceptanceCriteria: string[];
}

/** 根据用户本轮需求识别工作面，供会话发送时自动生成子 Agent 任务。 */
export function inferAutomaticAgentTaskPlan(prompt: string): AutomaticAgentTaskPlan[] {
  const value = prompt.trim();
  if (!value || (value.length < 40 && !/(开发|实现|修复|修改|新增|优化|重构|设计|梳理|排查|诊断|测试|接口|页面|代码|需求|bug|feature)/i.test(value))) return [];
  const plans: AutomaticAgentTaskPlan[] = [];
  const add = (role: AgentTask['role'], name: string, focus: string, outputs: string[]): void => {
    // 同一角色可以覆盖多个工作面（例如前端与后端），按任务名去重以便并行拆分。
    if (plans.some(item => item.name === name)) return;
    plans.push({
      role, name, description: `围绕以下会话需求进行${focus}，检查当前项目代码与现状并给出证据：\n${value}`,
      outputExpectations: outputs,
      acceptanceCriteria: ['结论必须引用实际工作区文件或现状证据', '交付分析结论、未覆盖项和风险，由主 Agent 汇总实施'],
    });
  };
  if (/(前端|页面|界面|交互|组件|react|vue|css|html|renderer|UI)/i.test(value)) add('developer', '前端工作面分析', '前端工作面分析', ['列出相关页面、组件和样式文件', '给出实现影响面与兼容风险']);
  if (/(后端|服务端|接口|api|数据库|sql|.net|java|node|服务|模型|联网|中转站)/i.test(value)) add('developer', '后端工作面分析', '后端工作面分析', ['列出相关服务、接口和配置文件', '给出调用链、数据影响和兼容风险']);
  if (/(测试|验证|回归|构建|编译|测试用例|smoke|test)/i.test(value)) add('testing', '验证工作面分析', '测试范围分析', ['给出可执行的构建、测试和回归检查清单', '标注现有测试覆盖与缺口']);
  if (/(审查|review|安全|权限|风险|兼容|升级|迁移)/i.test(value)) add('review', '风险与兼容性审查', '风险和兼容性审查', ['列出安全、兼容性和回归风险', '提供按优先级排序的审查结论']);
  if (!plans.length) {
    add('requirement', '需求拆分分析', '需求拆分', ['提炼目标、约束和验收条件', '按模块列出建议执行顺序']);
    if (value.length >= 100) add('testing', '验证工作面分析', '测试范围分析', ['给出可执行的验证清单', '标注现有测试覆盖与缺口']);
  }
  return plans.slice(0, 4);
}

export interface AgentTaskRunnerOptions {
  store: LocalStore;
  settings: SettingsService;
  dataRoot: string;
  resourcesRoot: string;
  codexExecutable: string;
  jinggongExecutable: string;
  publish: (event: AgentTaskEvent) => void;
  /** 自动子 Agent 全部结束后，将压缩后的结果写回父会话。 */
  publishSessionMessage?: (sessionId: string, text: string) => void;
  isSessionBusy?: (sessionId: string) => boolean;
  projectBudgetPolicy?: (projectId: string) => Partial<TaskBudgetPolicy> | undefined;
  runtimeFactory?: (kind: RuntimeKind, options: RuntimeOptions) => RuntimeAdapter;
}

interface ActiveTask {
  task: AgentTask;
  adapter?: RuntimeAdapter;
  threadId?: string;
  unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  finished: boolean;
  cancelled: boolean;
  terminationStatus?: 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  output: string;
  failure?: string;
  retryFailure?: RetryFailure;
  submittedTurn?: boolean;
  budget?: TaskBudgetGuard;
}

/** 工具权限由平台固定路由决定；不能由模型参数指定 requiredPermission 或跳过路径检查。 */
export function createAgentTaskToolGateway(options: { store: LocalStore; task: AgentTask; workspacePath: string; budget: TaskBudgetGuard; assertActive?: () => void }): NonNullable<RuntimeOptions['toolGateway']> {
  const contract = options.store.getAgentTaskContractVersions(options.task.sessionId, options.task.id).at(-1)?.contract;
  if (!contract || contract.contractVersion !== options.task.contractVersion) throw new GovernanceError('contract_changed');
  let expectedVersion = options.store.listAgentTasks(options.task.sessionId).find(task => task.id === options.task.id)?.stateVersion;
  const assertCurrent = () => {
    options.assertActive?.();
    const task = options.store.listAgentTasks(options.task.sessionId).find(item => item.id === options.task.id);
    if (!task || executionStatusOf(task) !== 'RUNNING' || task.contractVersion !== contract.contractVersion || task.stateVersion !== expectedVersion) throw new GovernanceError('task_state_changed');
    return task;
  };
  const snapshot = options.store.getTaskAuditSnapshot(options.task.sessionId, options.task.id);
  const calls = snapshot.toolEvents.filter(event => event.eventType === 'tool.started').map(event => ({ callId: String(event.payload.callId ?? event.correlationId), toolName: String(event.payload.toolName), argumentsHash: String(event.payload.argumentsHash), idempotencyKeyHash: typeof event.payload.idempotencyKeyHash === 'string' ? event.payload.idempotencyKeyHash : undefined, outcome: 'unknown_outcome' as const }));
  const gateway = new GovernedToolGateway({ contract, workspacePath: options.workspacePath, budget: options.budget, initialCalls: calls, audit: event => {
    assertCurrent();
    const persisted = options.store.appendTaskAuditEvent(options.task.sessionId, options.task.id, { eventType: event.eventType, actor: 'platform-runner', payload: { ...event.payload }, correlationId: event.payload.callId });
    expectedVersion = persisted.aggregateVersion;
  } });
  return async (request, operation) => {
    assertCurrent();
    if (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) throw new GovernanceError('invalid_tool_arguments');
    const args = request.arguments as Record<string, unknown>;
    let permission: 'read_project' | 'write_workspace' | 'delete_files'; let paths: string[] = [];
    if (['read_project_file', 'list_project_files', 'write_project_file', 'delete_project_file'].includes(request.toolName)) {
      if (typeof args.path !== 'string') throw new GovernanceError('invalid_relative_path');
      permission = request.toolName === 'write_project_file' ? 'write_workspace' : request.toolName === 'delete_project_file' ? 'delete_files' : 'read_project';
      if (request.toolName === 'list_project_files' && args.path === '.' && contract.allowedPaths.includes('**')) paths = [];
      else paths = [args.path];
    } else if (['search_dictionary', 'read_dictionary'].includes(request.toolName)) permission = 'read_project';
    else if (request.toolName === 'publish_change_plan') {
      permission = 'read_project';
      if (!Array.isArray(args.changes) || args.changes.some(change => !change || typeof change !== 'object' || typeof (change as { path?: unknown }).path !== 'string')) throw new GovernanceError('invalid_tool_arguments');
      paths = args.changes.map(change => (change as { path: string }).path);
    } else {
      const callId = taskContentHash([request.threadId, request.turnId, request.requestId]);
      const event = options.store.appendTaskAuditEvent(options.task.sessionId, options.task.id, { eventType: 'tool.denied', actor: 'platform-runner', correlationId: callId, payload: { callId, toolName: /^[A-Za-z0-9_.-]{1,128}$/.test(request.toolName) ? request.toolName : 'unknown', argumentsHash: canonicalTaskArgumentsHash(request.arguments), reason: 'unknown_tool' } });
      expectedVersion = event.aggregateVersion;
      throw new GovernanceError('unknown_tool');
    }
    const callId = taskContentHash([request.threadId, request.turnId, request.requestId]);
    const argumentsHash = canonicalTaskArgumentsHash(request.arguments);
    return gateway.execute({ callId, toolName: request.toolName, arguments: request.arguments, requiredPermission: permission, paths, idempotencyKey: `${contract.taskId}:${request.threadId}:${request.turnId}:${request.requestId}` }, async () => {
      assertCurrent();
      if (['read_project_file', 'list_project_files'].includes(request.toolName)) {
        const root = await realpath(options.workspacePath);
        for (const relative of paths) {
          const actual = await realpath(path.join(root, normalizeTaskRelativePath(relative)));
          assertTaskPathAllowed(contract, path.relative(root, actual).replaceAll('\\', '/'));
        }
      }
      assertCurrent();
      if (canonicalTaskArgumentsHash(request.arguments) !== argumentsHash) throw new GovernanceError('arguments_changed_after_authorization');
      const result = await operation();
      if (request.toolName === 'read_project_file' && typeof result.path === 'string') assertTaskPathAllowed(contract, result.path);
      if (request.toolName === 'list_project_files') {
        if (!Array.isArray(result.files) || result.files.some(file => typeof file !== 'string')) throw new GovernanceError('invalid_tool_result');
        const files = result.files.filter(file => { try { assertTaskPathAllowed(contract, file); return true; } catch { return false; } });
        return { ...result, files, truncated: result.truncated === true || files.length < result.files.length };
      }
      return result;
    });
  };
}

function terminal(status: AgentTaskStatus): boolean { return ['COMPLETED', 'CANCELLED', 'BLOCKED'].includes(status); }

export class AgentTaskRunner {
  private readonly active = new Map<string, ActiveTask>();
  private readonly cancellingSessions = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly circuits = new Map<string, TaskCircuitBreaker>();
  private readonly aggregatedAutomaticGroups = new Set<string>();
  private closing = false;

  constructor(private readonly options: AgentTaskRunnerOptions) {}

  get activeCount(): number { return this.active.size; }

  hasActiveSession(sessionId: string): boolean { return [...this.active.values()].some(item => item.task.sessionId === sessionId); }

  async startForSession(sessionId: string): Promise<void> {
    if (this.closing) return;
    const tasks = this.options.store.listAgentTasks(sessionId);
    if (!tasks.length) return;
    const reconciled = reconcileTaskStates(tasks);
    if (JSON.stringify(reconciled) !== JSON.stringify(tasks)) this.options.store.saveAgentTasksForSession(sessionId, reconciled);
    this.schedule();
  }

  private schedule(): void {
    if (this.closing) return;
    for (const session of this.options.store.listSessions()) {
      if (this.cancellingSessions.has(session.id)) continue;
      const graph = this.options.store.listAgentTasks(session.id);
      if (!graph.length) continue;
      const reconciled = reconcileTaskStates(graph);
      if (JSON.stringify(reconciled) !== JSON.stringify(graph)) this.options.store.saveAgentTasksForSession(session.id, reconciled);
    }
    const remaining = Math.max(0, MAX_CONCURRENCY - this.active.size);
    if (!remaining) return;
    const blockedSessionIds = new Set(this.options.store.listSessions()
      .filter(session => this.cancellingSessions.has(session.id) || this.options.isSessionBusy?.(session.id))
      .map(session => session.id));
    const pending = schedulableAgentTasks(this.options.store.listAgentTasks(), blockedSessionIds).filter(task => !this.active.has(task.id));
    const bySession = new Map<string, AgentTask[]>();
    for (const task of pending) bySession.set(task.sessionId, [...(bySession.get(task.sessionId) ?? []), task]);
    for (const [sessionId] of bySession) {
      if (this.active.size >= MAX_CONCURRENCY) break;
      const graph = this.options.store.listAgentTasks(sessionId);
      const next = nextRunnableTasks(graph, MAX_CONCURRENCY);
      for (const task of next) { if (this.active.size >= MAX_CONCURRENCY) break; void this.execute(task.id); }
    }
  }

  refreshSchedule(): void { this.schedule(); }

  async cancel(sessionId: string, taskId: string): Promise<void> {
    const task = this.options.store.listAgentTasks(sessionId).find(item => item.id === taskId);
    if (!task) throw new Error('子 Agent 任务不存在');
    const active = this.active.get(taskId);
    if (active) {
      active.cancelled = true;
      active.terminationStatus = 'CANCELLED';
      if (active.threadId && active.adapter) {
        await active.adapter.cancelRun(active.threadId).catch(() => undefined);
        await this.finish(active, 'CANCELLED', '已取消子 Agent 任务');
      } else {
        await this.finish(active, 'CANCELLED', '已取消子 Agent 任务');
      }
      return;
    }
    if (task.contractVersion && ['BLOCKED', 'INTERRUPTED', 'PAUSED', 'FAILED'].includes(executionStatusOf(task))) {
      for (const started of this.options.store.getTaskAuditSnapshot(sessionId, taskId).pendingToolCalls) {
        this.options.store.appendTaskAuditEvent(sessionId, taskId, { eventType: 'tool.unknown_outcome', actor: 'platform-runner', correlationId: started.correlationId, payload: { callId: started.payload.callId ?? started.correlationId, toolName: started.payload.toolName, startedEventId: started.id, outcome: 'unknown_outcome', reason: 'user_terminated_task_without_replaying_tool' } });
      }
      const current = this.options.store.listAgentTasks(sessionId).find(item => item.id === taskId)!;
      const cancelled = this.options.store.transitionTaskLifecycle({ sessionId, taskId, expectedStateVersion: current.stateVersion ?? 0, dimension: 'execution', to: 'CANCELLED', actor: 'local-user', reason: '用户显式终止工程任务；工作区映射、文件和审计保留，不重放工具' });
      this.record(cancelled, 'status', '工程任务已终止，工作区映射、文件和审计已保留');
      await this.startForSession(sessionId);
      return;
    }
    if (terminal(task.status)) throw new Error('任务已结束，不能取消');
    const next = transitionAgentTask(task, { status: 'CANCELLED' }, this.options.store.listAgentTasks(sessionId));
    this.saveTask(next);
    this.record(next, 'status', '任务已取消');
    await this.startForSession(sessionId);
  }

  async cancelForSession(sessionId: string): Promise<void> {
    this.cancellingSessions.add(sessionId);
    try {
      const tasks = this.options.store.listAgentTasks(sessionId).filter(task => task.contractVersion ? !['COMPLETED', 'CANCELLED'].includes(executionStatusOf(task)) : !terminal(task.status));
      for (const task of tasks) await this.cancel(sessionId, task.id).catch(() => undefined);
    } finally {
      this.cancellingSessions.delete(sessionId);
      this.schedule();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    const active = [...this.active.values()];
    await Promise.allSettled(active.map(async item => {
      item.cancelled = true;
      item.terminationStatus = item.task.contractVersion ? 'INTERRUPTED' : 'CANCELLED';
      if (item.threadId && item.adapter) await item.adapter.cancelRun(item.threadId).catch(() => undefined);
      await this.finish(item, item.terminationStatus, '应用正在退出，任务已中断；不会重放在途工具');
    }));
    this.active.clear();
    for (const task of this.options.store.listAgentTasks().filter(task => task.contractVersion && executionStatusOf(task) === 'RUNNING')) {
      this.options.store.transitionTaskLifecycle({ sessionId: task.sessionId, taskId: task.id, dimension: 'execution', to: 'INTERRUPTED', expectedStateVersion: task.stateVersion ?? 0, actor: 'platform-runner', reason: '应用退出时检测到未结束工程任务，等待人工恢复；不会重放在途工具' });
    }
  }

  private saveTask(task: AgentTask): AgentTask {
    const tasks = this.options.store.listAgentTasks(task.sessionId);
    const updated = tasks.map(item => item.id === task.id ? task : item);
    this.options.store.saveAgentTasksForSession(task.sessionId, updated);
    return this.options.store.listAgentTasks(task.sessionId).find(item => item.id === task.id)!;
  }

  private circuitKey(task: AgentTask): string { const session = this.options.store.getSession(task.sessionId); return `${task.runtimeKind ?? session?.runtimeKind ?? 'codex'}:${session?.providerId ?? 'default'}`; }
  private circuit(task: AgentTask): TaskCircuitBreaker { const key = this.circuitKey(task); let value = this.circuits.get(key); if (!value) { value = new TaskCircuitBreaker(); this.circuits.set(key, value); } return value; }
  private deferCircuit(task: AgentTask): void {
    const key = `circuit:${this.circuitKey(task)}`; const snapshot = this.circuit(task).snapshot();
    if (this.retryTimers.has(key) || snapshot.state !== 'open') return;
    const delay = Math.max(1, (snapshot.openedAt ?? Date.now()) + 30000 - Date.now());
    const timer = setTimeout(() => { this.retryTimers.delete(key); this.schedule(); }, delay);
    timer.unref?.(); this.retryTimers.set(key, timer);
  }

  private inheritedBudget(task: AgentTask, graph: readonly AgentTask[]): ResolvedTaskBudget {
    const contract = this.options.store.getAgentTaskContractVersions(task.sessionId, task.id).at(-1)?.contract;
    if (!contract || contract.contractVersion !== task.contractVersion) throw new GovernanceError('contract_missing_or_changed');
    const ancestors: TaskContract[] = []; const seen = new Set([task.id]); let parentId = task.parentTaskId;
    while (parentId) {
      if (seen.has(parentId)) throw new GovernanceError('parent_cycle'); seen.add(parentId);
      const parent = graph.find(item => item.id === parentId);
      const parentContract = parent && this.options.store.getAgentTaskContractVersions(parent.sessionId, parent.id).at(-1)?.contract;
      if (!parent || parent.projectId !== task.projectId || !parentContract) throw new GovernanceError('parent_contract_missing');
      ancestors.push(parentContract); parentId = parent.parentTaskId;
    }
    let parent: TaskBudgetPolicy | undefined;
    for (const ancestor of ancestors.reverse()) parent = { ...resolveTaskBudgetPolicy({ parent, task: ancestor.budgetPolicy }).policy };
    const resolved = resolveTaskBudgetPolicy({ project: task.projectId ? this.options.projectBudgetPolicy?.(task.projectId) : undefined, parent, task: contract.budgetPolicy });
    if (ancestors.length > resolved.policy.maxAgentDepth) throw new GovernanceError('budget_agent_depth');
    const rootId = ancestors[0]?.taskId ?? task.id;
    const belongs = (candidate: AgentTask) => { const visited = new Set<string>(); let current: AgentTask | undefined = candidate; while (current) { if (current.id === rootId) return true; if (visited.has(current.id)) return false; visited.add(current.id); current = graph.find(item => item.id === current!.parentTaskId); } return false; };
    if (graph.filter(belongs).length > resolved.policy.maxTotalAgentsPerTask) throw new GovernanceError('budget_total_agents');
    return resolved;
  }

  private blockGovernance(task: AgentTask, error: unknown): void {
    const current = this.options.store.listAgentTasks(task.sessionId).find(item => item.id === task.id);
    if (!current?.contractVersion || executionStatusOf(current) !== 'READY') return;
    const reasonCode = error instanceof GovernanceError ? error.code : 'governance_configuration_invalid';
    const explanation = reasonCode === 'worktree_execution_not_supported' ? '当前尚未支持开发型隔离工作区任务的受控执行，不能改用父会话工作区运行' : reasonCode === 'unknown_tool_outcome_requires_manual_review' ? '已有工具调用的结果未知，必须人工核对，禁止自动重放' : reasonCode.startsWith('budget_') ? '任务超出继承的预算或代理数量、深度限制' : '当前 Runtime 无法强制执行本任务的完整原生工具权限或内部模型请求预算';
    const reason = `${TASK_GOVERNANCE_BLOCKED_PREFIX} ${explanation}（${reasonCode}）。任务未启动、未消耗尝试次数，需修复能力或策略后人工处理。`;
    let blocked = this.options.store.transitionTaskLifecycle({ sessionId: current.sessionId, taskId: current.id, expectedStateVersion: current.stateVersion ?? 0, dimension: 'execution', to: 'BLOCKED', actor: 'platform-runner', reason });
    this.options.store.appendTaskAuditEvent(current.sessionId, current.id, { eventType: 'governance.blocked', actor: 'platform-runner', payload: { reasonCode, capability: 'strict_runtime_governance' } });
    blocked = this.options.store.listAgentTasks(current.sessionId).find(item => item.id === current.id)!;
    this.record(blocked, 'status', reason);
    // 治理门禁也属于终态；自动任务组需要在全部任务被阻塞时回写汇总，避免父会话一直等待。
    this.publishAutomaticSummary(blocked);
  }

  private record(task: AgentTask, type: AgentTaskEvent['type'], text: string, requestId?: number | string): void {
    const event: AgentTaskEvent = { id: randomUUID(), taskId: task.id, sessionId: task.sessionId, type, text: this.options.settings.redactContent(text).slice(0, 32000), createdAt: new Date().toISOString(), ...(requestId === undefined ? {} : { requestId }) };
    this.options.store.appendAgentTaskEvent(event);
    this.options.publish(event);
  }

  private publishAutomaticSummary(task: AgentTask): void {
    const match = new RegExp(`^${AUTOMATIC_AGENT_TASK_PREFIX}\\[([a-f0-9]{12})\\]`).exec(task.name);
    if (!match || this.aggregatedAutomaticGroups.has(`${task.sessionId}:${match[1]}`)) return;
    const group = this.options.store.listAgentTasks(task.sessionId).filter(item => item.name.startsWith(`${AUTOMATIC_AGENT_TASK_PREFIX}[${match[1]}]`));
    if (!group.length || group.some(item => !['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(item.status))) return;
    const key = `${task.sessionId}:${match[1]}`;
    this.aggregatedAutomaticGroups.add(key);
    const lines = group.map(item => {
      const summary = item.result?.summary || item.result?.error || item.error || '无结果';
      return `- ${item.name.replace(new RegExp(`^${AUTOMATIC_AGENT_TASK_PREFIX}\\[[a-f0-9]{12}\\]\\s*`), '')}：${summary.slice(0, 3000)}`;
    });
    this.options.publishSessionMessage?.(task.sessionId, `自动子 Agent 已完成汇总（${group.length} 个工作面）：\n${lines.join('\n')}`);
  }

  private buildRuntime(task: AgentTask, session: Session, active: ActiveTask): RuntimeAdapter {
    if (task.workspaceMode === 'worktree') throw new GovernanceError('worktree_execution_not_supported');
    const kind = task.runtimeKind ?? session.runtimeKind ?? 'codex';
    if (kind !== 'codex' && kind !== 'jinggong') throw new Error('分析子 Agent 当前仅支持 Codex Runtime 或 Jinggong Runtime');
    const executable = kind === 'jinggong' ? this.options.jinggongExecutable : this.options.codexExecutable;
    if (!existsSync(executable)) throw new Error(`${kind === 'jinggong' ? 'Jinggong' : 'Codex'} Runtime 尚未部署`);
    const provider = this.options.settings.profiles().find(item => item.id === (session.providerId ?? '')) ?? (!session.providerId ? this.options.settings.profiles()[0] : undefined);
    if (!provider || !provider.models.includes(task.model ?? session.model)) throw new Error('会话模型配置无效，无法启动分析子 Agent');
    const apiKey = this.options.settings.credential(provider.id).read(provider.baseUrl);
    if (!apiKey) throw new Error('会话模型 API Key 未配置，无法启动分析子 Agent');
    const contract = task.contractVersion ? this.options.store.getAgentTaskContractVersions(task.sessionId, task.id).at(-1)?.contract : undefined;
    const documents = contract
      ? contract.inputRefs.filter(ref => ref.type === 'document').map(ref => {
        const document = this.options.store.listDocuments().find(item => `${item.id}@${item.digest}` === ref.ref && item.enabled);
        if (!document) throw new Error('任务引用的开发规范版本已变化或停用，请修订契约后重试');
        return document;
      })
      : applicableDocuments(this.options.store.listDocuments(), session);
    for (const document of documents) this.options.settings.assertCleanText(document.name + '\n' + document.content);
    const context = contract ? documents.map(document => `【开发规范：${document.name}；${document.digest}】\n${document.content}`).join('\n\n') : buildDeveloperContext(documents, sessionMemories(this.options.store.listMemories(), session.projectId));
    const developerInstructions = `${context}\n【子 Agent 任务职责】本任务由精工Agent调度，角色为${ANALYSIS_ROLES[task.role]}。负责检查当前会话项目代码与现状证据，输出分析结论、证据文件和未解决项，供主 Agent 汇总实施。任务分析与具体交付按下述契约分工完成。${contract ? `\n契约版本：${contract.contractVersion}\n目标：${contract.goal}\n期望交付：${contract.outputExpectations.join('；')}\n验收标准：${contract.acceptanceCriteria.join('；')}\n使用当前契约与显式引用的上下文，不继承父任务聊天历史或无关记忆。` : ''}`;
    this.options.settings.assertCleanText(developerInstructions);
    let gateway: RuntimeOptions['toolGateway'];
    const runtimeOptions: RuntimeOptions = { executable, home: path.join(this.options.dataRoot, 'runtime', 'agent-tasks', task.id), baseUrl: provider.baseUrl, model: task.model ?? session.model, apiKey, shellToolEnabled: false, reasoningEffort: session.reasoningEffort, developerInstructions, dictionaries: documents.filter(item => item.kind === 'dictionary'), ...(contract && active.budget ? { toolGateway: async (request, execute) => {
      gateway ??= createAgentTaskToolGateway({ store: this.options.store, task, workspacePath: task.workspacePath ?? session.workspacePath, budget: active.budget!, assertActive: () => { if (active.finished || active.cancelled || this.closing) throw new GovernanceError('task_inactive'); } });
      return gateway(request, execute);
    } } : {}) };
    if (this.options.runtimeFactory) return this.options.runtimeFactory(kind, runtimeOptions);
    return kind === 'jinggong' ? createJinggongRuntimeAdapter(runtimeOptions) : createCodexRuntimeAdapter(runtimeOptions);
  }

  private async execute(taskId: string): Promise<void> {
    let task = this.options.store.listAgentTasks().find(item => item.id === taskId);
    if (!task || task.status !== 'PENDING' || this.active.has(taskId) || this.closing) return;
    const graph = this.options.store.listAgentTasks(task.sessionId);
    let budget: TaskBudgetGuard | undefined;
    if (task.contractVersion) {
      try {
        if (task.workspaceMode === 'worktree') throw new GovernanceError('worktree_execution_not_supported');
        const inherited = this.inheritedBudget(task, graph);
        const concurrent = this.options.store.listAgentTasks().filter(item => item.projectId === task!.projectId && item.status === 'RUNNING').length;
        if (concurrent >= inherited.policy.maxConcurrentAgents) return;
        const snapshot = this.options.store.getTaskAuditSnapshot(task.sessionId, task.id);
        if (snapshot.pendingToolCalls.length || snapshot.toolEvents.some(event => event.eventType === 'tool.unknown_outcome')) throw new GovernanceError('unknown_tool_outcome_requires_manual_review');
        this.options.store.appendTaskAuditEvent(task.sessionId, task.id, { eventType: 'budget.inherited', actor: 'platform-runner', payload: { policy: inherited.policy, sources: inherited.sources } });
        assertRuntimeGovernance(task.runtimeKind ?? 'codex', { strictModelRequests: true, strictTools: true, strictTokenUsage: inherited.policy.maxInputTokens !== undefined || inherited.policy.maxOutputTokens !== undefined, strictCostUsage: inherited.policy.maxCostAmount !== undefined });
        budget = new TaskBudgetGuard(inherited.policy, { startedAt: task.startedAt ? Date.parse(task.startedAt) : undefined, initial: { modelTurns: snapshot.budgetEvents.filter(event => event.eventType === 'model.turn_started').length, toolCalls: snapshot.toolEvents.filter(event => event.eventType === 'tool.started').length } });
        budget.check(); this.circuit(task).assertCanExecute();
      } catch (error) { if (error instanceof GovernanceError && error.code === 'circuit_open') this.deferCircuit(task); else this.blockGovernance(task, error); return; }
      task = this.options.store.listAgentTasks(task.sessionId).find(item => item.id === taskId)!;
    } else {
      try { this.circuit(task).assertCanExecute(); } catch { this.deferCircuit(task); return; }
    }
    const running = this.saveTask(transitionAgentTask(task, { status: 'RUNNING' }, graph));
    const active: ActiveTask = { task: running, finished: false, cancelled: false, output: '', budget };
    this.active.set(taskId, active);
    const timeoutMs = budget ? Math.min(running.timeoutMs ?? Number.POSITIVE_INFINITY, Math.max(0, budget.policy.maxRuntimeMinutes * 60000 - budget.snapshot().elapsedMs)) : running.timeoutMs;
    if (timeoutMs !== undefined) active.timer = setTimeout(() => { void this.timeout(active); }, timeoutMs);
    try {
      this.record(running, 'status', `任务开始执行（第 ${running.attempt}/${running.maxAttempts} 次尝试）`);
      const session = this.options.store.getSession(running.sessionId);
      if (!session) { await this.finish(active, 'FAILED', '绑定会话不存在'); return; }
      active.adapter = this.buildRuntime(running, session, active);
      active.unsubscribe = active.adapter.onEvent(event => { void this.handleEvent(active, event).catch(error => this.finish(active, 'FAILED', error instanceof Error ? error.message : String(error))); });
      await active.adapter.start();
      if (active.cancelled || active.finished) { await this.finish(active, 'CANCELLED', '任务在启动期间被取消'); return; }
      const workspacePath = running.workspacePath ?? session.workspacePath;
      active.threadId = await active.adapter.startSession(workspacePath);
      if (active.cancelled || active.finished) { await this.finish(active, 'CANCELLED', '任务在创建会话期间被取消'); return; }
      const prompt = `任务名称：${running.name}\n任务角色：${ANALYSIS_ROLES[running.role]}\n任务描述：${running.description}${running.input ? `\n补充输入：\n${running.input}` : ''}\n\n请按分析职责完成任务，直接输出结论与证据，供主 Agent 汇总实施。`;
      this.options.settings.assertCleanText(prompt);
      this.record(running, 'user', prompt);
      if (active.budget) {
        active.budget.reserveModelTurn();
        this.options.store.appendTaskAuditEvent(running.sessionId, running.id, { eventType: 'model.turn_started', actor: 'platform-runner', payload: { count: 1, scope: 'platform_turn', tokenUsage: 'unknown', costUsage: 'unknown' } });
      }
      active.submittedTurn = true;
      await active.adapter.sendTurn(active.threadId, prompt, workspacePath);
    } catch (error) {
      active.retryFailure = classifyRetryFailure(error);
      await this.finish(active, active.terminationStatus ?? (active.cancelled ? 'CANCELLED' : 'FAILED'), error instanceof Error ? error.message : String(error));
    }
  }

  private async handleEvent(active: ActiveTask, event: RuntimeEvent): Promise<void> {
    if (active.finished || (active.threadId && event.threadId && event.threadId !== active.threadId)) return;
    const task = this.options.store.listAgentTasks(active.task.sessionId).find(item => item.id === active.task.id) ?? active.task;
    const safeText = this.options.settings.redactContent(event.text);
    if (event.type === 'error') active.failure = safeText;
    if (safeText) active.output = `${active.output}${safeText}`.slice(-12000);
    this.record(task, event.type, safeText, event.requestId);
    if (event.type === 'status') {
      const status = event.text === 'interrupted' && task.contractVersion && !active.terminationStatus ? 'INTERRUPTED' : active.terminationStatus === 'INTERRUPTED' ? 'INTERRUPTED' : terminalTaskStatus(event.text, active.terminationStatus);
      if (!status) return;
      await this.finish(active, status, status === 'COMPLETED' ? undefined : active.failure ?? (event.text === 'interrupted' ? 'Runtime 已中断，未收到用户取消请求' : event.text));
    }
  }

  private async timeout(active: ActiveTask): Promise<void> {
    if (active.finished) return;
    active.cancelled = true;
    active.terminationStatus = 'FAILED';
    active.failure = '子 Agent 任务超过设定时间，已停止';
    if (active.threadId && active.adapter) await active.adapter.cancelRun(active.threadId).catch(() => undefined);
    await this.finish(active, 'FAILED', active.failure);
  }

  private async finish(active: ActiveTask, status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED', error?: string): Promise<void> {
    if (active.finished) return;
    active.finished = true;
    if (active.timer) clearTimeout(active.timer);
    active.unsubscribe?.();
    await active.adapter?.close().catch(() => undefined);
    this.active.delete(active.task.id);
    let current = this.options.store.listAgentTasks(active.task.sessionId).find(item => item.id === active.task.id);
    if (!current || current.status !== 'RUNNING') return;
    if (current.contractVersion) {
      const snapshot = this.options.store.getTaskAuditSnapshot(current.sessionId, current.id);
      if (snapshot.pendingToolCalls.length || snapshot.toolEvents.some(event => event.eventType === 'tool.unknown_outcome')) {
        for (const started of snapshot.pendingToolCalls) {
          this.options.store.appendTaskAuditEvent(current.sessionId, current.id, { eventType: 'tool.unknown_outcome', actor: 'platform-runner', correlationId: started.correlationId, payload: { callId: started.payload.callId ?? started.correlationId, toolName: started.payload.toolName, startedEventId: started.id, outcome: 'unknown_outcome', reason: 'runtime_finished_without_confirmed_tool_result' } });
        }
        current = this.options.store.listAgentTasks(current.sessionId).find(task => task.id === current!.id)!;
        status = 'INTERRUPTED'; error = '工具调用结果未确认，任务保持中断等待人工核对；模型完成消息不能替代工具结果，不自动重放';
      }
    }
    if (status === 'INTERRUPTED' && current.contractVersion) {
      const interrupted = this.options.store.transitionTaskLifecycle({ sessionId: current.sessionId, taskId: current.id, expectedStateVersion: current.stateVersion ?? 0, dimension: 'execution', to: 'INTERRUPTED', actor: 'platform-runner', reason: error ?? 'Runtime 已中断，等待人工确认，不自动重放工具' });
      this.record(interrupted, 'status', interrupted.error ?? '工程任务已中断，等待人工恢复');
      this.schedule(); return;
    }
    if (status === 'INTERRUPTED') status = 'FAILED';
    const safeOutput = this.options.settings.redactContent(active.output).slice(-12000);
    const safeError = error ? this.options.settings.redactContent(error).slice(0, 12000) : undefined;
    const result = status === 'COMPLETED' ? { summary: safeOutput || '任务已完成' } : { error: safeError ?? '任务执行失败', summary: safeOutput || undefined };
    let next = transitionAgentTask(current, { status, result, error: safeError });
    next = this.saveTask(next);
    this.record(next, 'status', status === 'COMPLETED' ? '任务已完成' : safeError ?? (status === 'CANCELLED' ? '任务已取消' : '任务失败'));
    this.publishAutomaticSummary(next);
    if (status === 'COMPLETED') this.circuit(next).recordSuccess();
    const failure = active.retryFailure ?? classifyRetryFailure(undefined);
    if (status === 'FAILED') this.circuit(next).recordFailure(failure);
    const retry = retryPolicyDecision({ failure, attempt: next.attempt, maxRetries: Math.min(next.maxAttempts - 1, active.budget?.policy.maxRetriesPerTask ?? next.maxAttempts - 1) });
    if (status === 'FAILED' && retry.retry && !active.submittedTurn && !this.closing) {
      const retryTask = next;
      this.record(next, 'status', `暂时故障将在 ${retry.delayMs} 毫秒退避后重试（第 ${next.attempt + 1}/${next.maxAttempts} 次）；不会重放已提交模型回合或工具`);
      const timer = setTimeout(() => {
        this.retryTimers.delete(retryTask.id);
        const fresh = this.options.store.listAgentTasks(retryTask.sessionId).find(item => item.id === retryTask.id);
        if (!fresh || fresh.status !== 'FAILED' || fresh.attempt >= fresh.maxAttempts || this.closing) return;
        this.saveTask(transitionAgentTask(fresh, { status: 'PENDING' }, this.options.store.listAgentTasks(fresh.sessionId)));
        this.schedule();
      }, retry.delayMs);
      timer.unref?.(); this.retryTimers.set(next.id, timer);
    }
    this.schedule();
  }
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Session, ExpertCollaborationPlan, ExpertTaskSpec, ExpertPlannerContext } from '../../../../packages/domain/src';
import { aggregateExpertTaskResults, assertExpertCollaborationPlan, createAgentTask, createExpertCollaborationPlan, createTaskContract, DEFAULT_TASK_BUDGET, MAX_AGENT_TASKS_PER_SESSION } from '../../../../packages/agent-orchestrator/src';
import { applicableDocuments } from '../../../../packages/policy/src';
import { LocalStore } from '../../../../packages/storage/src';
import { AgentTaskRunner } from './agent-tasks';

interface CollaborationOptions {
  handle: (channel: string, fn: (...args: any[]) => any) => void;
  store: LocalStore;
  runner: AgentTaskRunner;
  session: (value: unknown) => Session;
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const prompt = z.string().trim().min(1).max(50000);
const taskPatch = z.object({
  taskKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  expertId: id,
  expertName: z.string().trim().min(1).max(120),
  role: z.enum(['requirement', 'architecture', 'developer', 'review', 'testing', 'documentation', 'custom']),
  objective: z.string().trim().min(1).max(4000),
  sessionId: id,
  projectId: id.optional(),
  system: z.enum(['MES5', 'MES6', 'WMS', '前端', '通用']).optional(),
  scope: z.array(z.enum(['auto', 'MES5', 'MES6', 'WMS', 'SRM', 'JMOM', 'PDA', 'off'])).min(1).max(8),
  constraints: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  expectedOutput: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  dependencyKeys: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(20),
  permissionTier: z.enum(['read_only', 'workspace_write', 'command_execute', 'external_access', 'high_risk']),
  workspaceMode: z.enum(['read', 'worktree']),
  agentTaskId: id.optional(),
}).strict();

function plannerProfiles(store: LocalStore): ExpertPlannerContext[] {
  return store.expertProfiles().map(profile => ({ id: profile.id, name: profile.name, role: profile.role, familyId: profile.familyId, enabled: profile.enabled }));
}

function now(): string { return new Date().toISOString(); }

function assertPlanSession(plan: ExpertCollaborationPlan, session: Session): void {
  if (plan.sessionId !== session.id || plan.projectId !== session.projectId) throw new Error('专家协作计划与当前会话不匹配');
}

function getPlan(store: LocalStore, session: Session, value: unknown): ExpertCollaborationPlan {
  const plan = store.expertCollaborationPlan(id.parse(value));
  if (!plan) throw new Error('专家协作计划不存在');
  assertPlanSession(plan, session);
  return plan;
}

function savePlan(store: LocalStore, plan: ExpertCollaborationPlan): ExpertCollaborationPlan {
  assertExpertCollaborationPlan(plan);
  store.saveExpertCollaborationPlan(plan);
  return plan;
}

export function registerExpertCollaborationIpc(options: CollaborationOptions): void {
  const { handle, store, runner } = options;
  handle('expert-collaboration:preview', (sessionValue: unknown, promptValue: unknown) => {
    const session = options.session(sessionValue);
    const text = prompt.parse(promptValue);
    const plan = createExpertCollaborationPlan({ sessionId: session.id, projectId: session.projectId, system: session.system, prompt: text, profiles: plannerProfiles(store) });
    return savePlan(store, plan);
  });
  handle('expert-collaboration:list', (sessionValue: unknown) => store.expertCollaborationPlans(options.session(sessionValue).id));
  handle('expert-collaboration:edit', (sessionValue: unknown, planValue: unknown, tasksValue: unknown) => {
    const session = options.session(sessionValue);
    const plan = getPlan(store, session, planValue);
    if (plan.status !== 'review') throw new Error('只有待确认计划可以编辑');
    const tasks = z.array(taskPatch).max(20).parse(tasksValue) as ExpertTaskSpec[];
    if (tasks.some(task => task.permissionTier !== 'read_only' || task.workspaceMode !== 'read')) throw new Error('当前专家协作仅支持只读分析权限');
    const enabledProfiles = new Set(store.expertProfiles().filter(profile => profile.enabled).map(profile => profile.id));
    if (tasks.some(task => !enabledProfiles.has(task.expertId))) throw new Error('计划中的专家不存在或已停用，请刷新专家计划');
    const updated: ExpertCollaborationPlan = { ...plan, tasks, updatedAt: now() };
    assertPlanSession(updated, session);
    return savePlan(store, updated);
  });
  handle('expert-collaboration:confirm', async (sessionValue: unknown, planValue: unknown) => {
    const session = options.session(sessionValue);
    const plan = getPlan(store, session, planValue);
    if (plan.status !== 'review') throw new Error('当前计划不在待确认状态');
    if (!plan.tasks.length) return savePlan(store, { ...plan, status: 'completed', confirmedAt: now(), updatedAt: now() });
    const enabledProfiles = new Set(store.expertProfiles().filter(profile => profile.enabled).map(profile => profile.id));
    if (plan.tasks.some(task => task.permissionTier !== 'read_only' || task.workspaceMode !== 'read')) throw new Error('当前专家协作仅支持只读分析权限');
    if (plan.tasks.some(task => !enabledProfiles.has(task.expertId))) throw new Error('计划中的专家不存在或已停用，请重新生成计划');
    const existing = store.listAgentTasks(session.id);
    if (existing.length + plan.tasks.length > MAX_AGENT_TASKS_PER_SESSION) throw new Error(`单会话最多 ${MAX_AGENT_TASKS_PER_SESSION} 个子任务`);
    const inputRefs = applicableDocuments(store.listDocuments(), session).map(document => ({ type: 'document', ref: `${document.id}@${document.digest}` }));
    const taskIds = new Map(plan.tasks.map(task => [task.taskKey, randomUUID()]));
    const entries = plan.tasks.map(spec => {
      const task = createAgentTask({
        id: taskIds.get(spec.taskKey)!, sessionId: session.id, projectId: session.projectId, orchestrationId: plan.id, expertId: spec.expertId, expertPlanId: plan.id,
        name: `专家[${spec.expertName}] ${spec.objective.slice(0, 96)}`, role: spec.role, description: `${spec.objective}\n约束：${spec.constraints.join('；')}`, input: plan.prompt,
        dependencyIds: spec.dependencyKeys.map(key => taskIds.get(key)!).filter(Boolean), model: session.model, runtimeKind: session.runtimeKind ?? 'codex', workspaceMode: spec.workspaceMode,
      });
      const contract = createTaskContract(task, { createdBy: 'expert-planner', inputRefs, outputExpectations: spec.expectedOutput, acceptanceCriteria: spec.acceptanceCriteria, permissionProfile: `expert:${spec.expertId}`, budgetPolicy: { ...DEFAULT_TASK_BUDGET, maxRetriesPerTask: 1 } });
      return { task, contract };
    });
    const updatedTasks = plan.tasks.map(spec => ({ ...spec, agentTaskId: taskIds.get(spec.taskKey)! }));
    const updated: ExpertCollaborationPlan = { ...plan, tasks: updatedTasks, status: 'executing', confirmedAt: now(), updatedAt: now() };
    store.saveAgentTaskContracts(entries.map(entry => ({ ...entry, expectedContractVersion: 0 })), 'expert-planner', updated);
    await runner.startForSession(session.id);
    return updated;
  });
  handle('expert-collaboration:reject', (sessionValue: unknown, planValue: unknown, reasonValue?: unknown) => {
    const session = options.session(sessionValue);
    const plan = getPlan(store, session, planValue);
    if (!['review', 'confirmed'].includes(plan.status)) throw new Error('当前计划不能拒绝');
    const reason = reasonValue === undefined ? '用户拒绝专家协作计划' : z.string().trim().min(1).max(1000).parse(reasonValue);
    return savePlan(store, { ...plan, status: 'rejected', rejectedReason: reason, updatedAt: now() });
  });
  handle('expert-collaboration:cancel', async (sessionValue: unknown, planValue: unknown) => {
    const session = options.session(sessionValue);
    const plan = getPlan(store, session, planValue);
    if (!['executing', 'confirmed', 'partial'].includes(plan.status)) throw new Error('当前计划不能取消');
    await runner.cancelForOrchestration(session.id, plan.id);
    return savePlan(store, { ...plan, status: 'cancelled', updatedAt: now() });
  });
  handle('expert-collaboration:aggregate', (sessionValue: unknown, planValue: unknown) => {
    const session = options.session(sessionValue);
    const plan = getPlan(store, session, planValue);
    const aggregate = aggregateExpertTaskResults(plan, store.listAgentTasks(session.id));
    const status = aggregate.status === 'pending' ? 'executing' : aggregate.status;
    savePlan(store, { ...plan, status, aggregate, updatedAt: now() });
    return aggregate;
  });
}

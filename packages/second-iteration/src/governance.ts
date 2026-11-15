import { randomUUID } from 'node:crypto';
import { assertTaskPlanSteps, nextStepStatus, type RecoveryStatus, type TaskCheckpoint, type TaskPlan, type TaskPlanStep, type TaskPlanStepStatus } from '../../domain/src';

/** F03 所需的最小持久化接口；LocalStore 可直接满足该接口。 */
export interface TaskGovernanceStore {
  listTaskPlans(taskId?: string): TaskPlan[];
  saveTaskPlan(value: TaskPlan): void;
  listTaskPlanSteps(planId: string): TaskPlanStep[];
  saveTaskPlanStep(value: TaskPlanStep): void;
  listTaskCheckpoints(taskId: string): TaskCheckpoint[];
  getTaskCheckpoint?(id: string): TaskCheckpoint | undefined;
  saveTaskCheckpoint(value: TaskCheckpoint): void;
}

export interface TaskPlanStepInput {
  stepKey: string;
  title: string;
  description?: string;
  order: number;
  dependsOn?: string[];
  required?: boolean;
}

export interface CreateTaskPlanInput {
  taskId: string;
  projectId?: string;
  goal: string;
  assumptions?: string[];
  acceptanceCriteria: string[];
  steps: TaskPlanStepInput[];
}

function requiredText(value: string, name: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(normalized)) throw new Error(`${name}无效`);
  return normalized;
}

function stepDependenciesSatisfied(step: TaskPlanStep, steps: TaskPlanStep[]): boolean {
  const byKey = new Map(steps.map(item => [item.stepKey, item]));
  return step.dependsOn.every(key => {
    const dependency = byKey.get(key);
    return !!dependency && (dependency.status === 'succeeded' || (dependency.status === 'skipped' && !dependency.required));
  });
}

/** 建立可编辑的计划版本；步骤先处于 pending，确认前不会进入执行状态。 */
export function createTaskPlan(store: TaskGovernanceStore, input: CreateTaskPlanInput): { plan: TaskPlan; steps: TaskPlanStep[] } {
  const taskId = requiredText(input.taskId, '任务 ID', 160);
  const goal = requiredText(input.goal, '任务目标', 8000);
  const acceptanceCriteria = (input.acceptanceCriteria ?? []).map(item => requiredText(item, '验收标准', 1000));
  if (!acceptanceCriteria.length || acceptanceCriteria.length > 100) throw new Error('任务计划至少需要一项验收标准');
  if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 100) throw new Error('任务计划必须包含 1 至 100 个步骤');
  const revision = Math.max(0, ...store.listTaskPlans(taskId).map(item => item.revision)) + 1;
  const planId = randomUUID();
  const createdAt = new Date().toISOString();
  const plan: TaskPlan = {
    id: planId, taskId, revision, ...(input.projectId ? { projectId: input.projectId } : {}), goal,
    assumptions: (input.assumptions ?? []).map(item => requiredText(item, '前置假设', 1000)),
    acceptanceCriteria, status: 'review', createdAt,
  };
  const steps = input.steps.map((item, index): TaskPlanStep => ({
    id: randomUUID(), planId, stepKey: requiredText(item.stepKey, '步骤标识', 100),
    title: requiredText(item.title, '步骤名称', 200), description: (item.description ?? '').trim().slice(0, 4000),
    order: Number.isInteger(item.order) && item.order >= 0 ? item.order : index,
    dependsOn: [...new Set(item.dependsOn ?? [])], status: 'pending', required: item.required ?? true,
    evidenceRefs: [],
  }));
  assertTaskPlanSteps(steps);
  if (new Set(steps.map(item => item.order)).size !== steps.length) throw new Error('步骤顺序不能重复');
  store.saveTaskPlan(plan);
  for (const step of steps) store.saveTaskPlanStep(step);
  return { plan, steps };
}

/** 只确认当前版本；如已确认另一版本，将旧版本标记为 superseded。 */
export function confirmTaskPlan(store: TaskGovernanceStore, planId: string): TaskPlan {
  const plan = store.listTaskPlans().find(item => item.id === planId);
  if (!plan) throw new Error('任务计划不存在');
  if (plan.status !== 'review' && plan.status !== 'draft') throw new Error('当前计划状态不允许确认');
  const versions = store.listTaskPlans(plan.taskId);
  if (versions.some(item => item.revision > plan.revision && item.status !== 'superseded')) throw new Error('只能确认当前任务的最新计划版本');
  if (versions.some(item => item.id !== plan.id && store.listTaskPlanSteps(item.id).some(step => step.status === 'running'))) throw new Error('请先等待当前阶段结束，再确认新版本计划');
  const steps = store.listTaskPlanSteps(planId);
  if (!steps.length) throw new Error('任务计划没有步骤');
  assertTaskPlanSteps(steps);
  for (const older of store.listTaskPlans(plan.taskId)) {
    if (older.id !== plan.id && older.revision < plan.revision && older.status !== 'completed') store.saveTaskPlan({ ...older, status: 'superseded' });
  }
  const confirmed = { ...plan, status: 'confirmed' as const, confirmedAt: new Date().toISOString() };
  store.saveTaskPlan(confirmed);
  return confirmed;
}

/** 刷新依赖已满足的待执行步骤；不启动任何 Runtime 或命令。 */
export function refreshReadyTaskSteps(store: TaskGovernanceStore, planId: string): TaskPlanStep[] {
  const plan = store.listTaskPlans().find(item => item.id === planId);
  if (!plan || !['confirmed', 'executing'].includes(plan.status)) throw new Error('任务计划尚未确认');
  const steps = store.listTaskPlanSteps(planId);
  assertTaskPlanSteps(steps);
  const changed = steps.map(step => {
    if (step.status !== 'pending' || !stepDependenciesSatisfied(step, steps)) return step;
    const ready = { ...step, status: 'ready' as const };
    store.saveTaskPlanStep(ready);
    return ready;
  });
  return changed;
}

/** 推进单个步骤并执行依赖、状态与完成条件校验。 */
export function transitionTaskStep(store: TaskGovernanceStore, planId: string, stepId: string, next: TaskPlanStepStatus, details: { outputSummary?: string; evidenceRefs?: string[] } = {}): TaskPlanStep {
  const plan = store.listTaskPlans().find(item => item.id === planId);
  if (!plan || !['confirmed', 'executing'].includes(plan.status)) throw new Error('任务计划尚未确认或已结束');
  const steps = store.listTaskPlanSteps(planId);
  const current = steps.find(item => item.id === stepId);
  if (!current) throw new Error('任务计划步骤不存在');
  if (!nextStepStatus(current.status, next)) throw new Error(`不允许将步骤从 ${current.status} 切换为 ${next}`);
  if (next === 'ready' && !stepDependenciesSatisfied(current, steps)) throw new Error('前置步骤尚未成功完成');
  if (next === 'running' && !stepDependenciesSatisfied(current, steps)) throw new Error('前置步骤已变化，不能开始执行');
  if (next === 'running' && steps.some(item => item.id !== stepId && item.status === 'running')) throw new Error('当前计划已有正在执行的阶段');
  if (next === 'invalidated' && steps.some(item => item.id !== stepId && item.status === 'running')) throw new Error('请先结束正在执行的阶段，再将前置阶段标记失效');
  if (next === 'succeeded' && !details.outputSummary?.trim()) throw new Error('请填写阶段实际产出摘要，不能仅凭状态声明成功');
  if (next === 'succeeded' && current.dependsOn.some(key => !stepDependenciesSatisfied({ ...current, dependsOn: [key] }, steps))) throw new Error('存在未完成的前置步骤');
  const now = new Date().toISOString();
  const updated: TaskPlanStep = {
    ...current, status: next,
    ...(next === 'running' ? { startedAt: now } : {}),
    ...(['succeeded', 'failed', 'skipped', 'blocked'].includes(next) ? { completedAt: now } : {}),
    ...(details.outputSummary !== undefined ? { outputSummary: details.outputSummary.slice(0, 8000) } : {}),
    ...(details.evidenceRefs !== undefined ? { evidenceRefs: [...new Set(details.evidenceRefs)].slice(0, 200) } : {}),
  };
  store.saveTaskPlanStep(updated);
  if (next === 'invalidated') {
    const invalid = new Set([current.stepKey]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of steps) if (!invalid.has(step.stepKey) && step.dependsOn.some(key => invalid.has(key))) { invalid.add(step.stepKey); changed = true; }
    }
    for (const step of steps) if (step.id !== stepId && invalid.has(step.stepKey)) store.saveTaskPlanStep({ ...step, status: 'invalidated', outputSummary: `${step.outputSummary ?? ''}\n前置阶段已失效，需要重新验证。`.trim() });
  }
  const after = steps.map(item => item.id === stepId ? updated : item);
  if (next === 'running' && plan.status === 'confirmed') store.saveTaskPlan({ ...plan, status: 'executing' });
  if (after.every(item => item.status === 'succeeded' || item.status === 'skipped' && !item.required)) store.saveTaskPlan({ ...plan, status: 'completed' });
  return updated;
}

export interface TaskCheckpointInput {
  taskId: string;
  planId: string;
  stepId: string;
  projectId?: string;
  repoId?: string;
  branch?: string;
  headSha?: string;
  worktreeFingerprint?: string;
  fileManifest: Array<{ path: string; sha256: string; status?: string }>;
  contextSnapshotId?: string;
  runtimeId?: string;
  runtimeSessionId?: string;
  checkpointSummary: string;
  completedActions: string[];
  pendingActions: string[];
  evidenceRefs: string[];
}

export function createTaskCheckpoint(store: TaskGovernanceStore, input: TaskCheckpointInput): TaskCheckpoint {
  const plan = store.listTaskPlans(input.taskId).find(item => item.id === input.planId);
  if (!plan || !['confirmed', 'executing', 'completed'].includes(plan.status)) throw new Error('只能为已确认且有效的任务计划创建检查点');
  if (plan.projectId !== input.projectId) throw new Error('检查点项目与任务计划不一致');
  const step = store.listTaskPlanSteps(input.planId).find(item => item.id === input.stepId);
  if (!step) throw new Error('检查点步骤不属于该计划');
  if (!['succeeded', 'failed', 'blocked', 'skipped'].includes(step.status) || store.listTaskPlanSteps(input.planId).some(item => item.status === 'running')) throw new Error('只能在阶段结束或阻塞的安全边界创建检查点');
  if (!Array.isArray(input.fileManifest) || input.fileManifest.length > 10000) throw new Error('检查点文件清单无效');
  const fileManifest = input.fileManifest.map(item => {
    const filePath = requiredText(item.path, '文件路径', 1000).replace(/\\/g, '/');
    if (filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath) || filePath.split('/').includes('..')) throw new Error('检查点文件路径必须为工作区内相对路径');
    if (!/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error(`文件指纹无效：${filePath}`);
    return { path: filePath, sha256: item.sha256.toLowerCase(), ...(item.status ? { status: item.status.slice(0, 32) } : {}) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(fileManifest.map(item => item.path)).size !== fileManifest.length) throw new Error('检查点文件清单存在重复路径');
  const jsonArray = (items: string[], label: string) => {
    if (!Array.isArray(items) || items.length > 500) throw new Error(`${label}无效`);
    return JSON.stringify(items.map(item => requiredText(item, label, 2000)));
  };
  const checkpoint: TaskCheckpoint = {
    id: randomUUID(), taskId: input.taskId, planId: input.planId, stepId: input.stepId,
    ...(input.projectId ? { projectId: input.projectId } : {}), ...(input.repoId ? { repoId: input.repoId } : {}),
    ...(input.branch ? { branch: input.branch } : {}), ...(input.headSha ? { headSha: input.headSha } : {}),
    ...(input.worktreeFingerprint ? { worktreeFingerprint: input.worktreeFingerprint } : {}),
    fileManifestJson: JSON.stringify(fileManifest), ...(input.contextSnapshotId ? { contextSnapshotId: input.contextSnapshotId } : {}),
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}), ...(input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId } : {}),
    checkpointSummary: requiredText(input.checkpointSummary, '检查点摘要', 8000),
    completedActionsJson: jsonArray(input.completedActions, '已完成动作'), pendingActionsJson: jsonArray(input.pendingActions, '待办动作'),
    evidenceRefsJson: jsonArray(input.evidenceRefs, '证据引用'), recoveryStatus: 'not_checked', createdAt: new Date().toISOString(),
  };
  store.saveTaskCheckpoint(checkpoint);
  return checkpoint;
}

export interface RecoveryAssessmentInput {
  branch?: string;
  headSha?: string;
  worktreeFingerprint?: string;
  fileManifest?: Array<{ path: string; sha256: string; status?: string }>;
  contextSnapshotId?: string;
  contextUnchanged?: boolean;
  validationStillApplicable?: boolean;
  runtimeAvailable: boolean;
  nativeSessionResumeSupported?: boolean;
}

export interface RecoveryAssessment { status: RecoveryStatus; canStartPlatformResume: boolean; requiresRevalidation: boolean; reasons: string[] }

/** 对照分支、HEAD、工作区和资料快照审查；只更新检查点结论，不自动恢复会话。 */
export function assessTaskRecovery(store: TaskGovernanceStore, checkpointId: string, current: RecoveryAssessmentInput): RecoveryAssessment {
  const checkpoint = store.getTaskCheckpoint?.(checkpointId);
  if (!checkpoint) throw new Error('任务检查点不存在');
  return assessAndPersist(store, checkpoint, current);
}

function assessAndPersist(store: TaskGovernanceStore, checkpoint: TaskCheckpoint, current: RecoveryAssessmentInput): RecoveryAssessment {
  const reasons: string[] = [];
  let status: RecoveryStatus;
  const plan = store.listTaskPlans(checkpoint.taskId).find(item => item.id === checkpoint.planId);
  if (!plan || plan.projectId !== checkpoint.projectId || plan.status === 'superseded' || plan.status === 'completed') {
    status = 'cannot_resume'; reasons.push('原计划已结束、被替代或项目身份不一致，请建立新计划后继续');
  } else if (!checkpoint.branch || !checkpoint.headSha || !checkpoint.worktreeFingerprint || !current.branch || !current.headSha || !current.worktreeFingerprint || !current.fileManifest) {
    status = 'cannot_resume'; reasons.push('检查点或当前环境缺少分支、HEAD、工作区指纹或文件清单');
  } else if (checkpoint.branch !== current.branch) {
    status = 'manual_reconciliation_required'; reasons.push('当前分支与检查点分支不一致');
  } else if (checkpoint.headSha !== current.headSha) {
    status = 'manual_reconciliation_required'; reasons.push('HEAD 已变化，需要人工核对检查点后的提交');
  } else {
    let saved: Array<{ path: string; sha256: string; status?: string }> = [];
    let manifestValid = true;
    try {
      saved = JSON.parse(checkpoint.fileManifestJson);
      manifestValid = Array.isArray(saved) && saved.every(item => item && typeof item.path === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256)) && new Set(saved.map(item => item.path)).size === saved.length;
    } catch { manifestValid = false; }
    const canonical = (items: Array<{ path: string; sha256: string; status?: string }>) => JSON.stringify(items.map(item => ({ path: item.path.replace(/\\/g, '/'), sha256: item.sha256.toLowerCase(), status: item.status ?? '' })).sort((a, b) => a.path.localeCompare(b.path)));
    if (!manifestValid) {
      status = 'cannot_resume'; reasons.push('检查点文件清单损坏，不能据此继续');
    } else if (checkpoint.worktreeFingerprint !== current.worktreeFingerprint || canonical(saved) !== canonical(current.fileManifest)) {
      status = 'manual_reconciliation_required'; reasons.push('工作区或文件指纹与检查点不一致，需先核对改动归属');
    } else if (current.runtimeAvailable !== true) {
      status = 'cannot_resume'; reasons.push('当前没有可用 Runtime，暂不能启动平台级恢复');
    } else if (current.contextUnchanged === false || (checkpoint.contextSnapshotId && current.contextSnapshotId !== checkpoint.contextSnapshotId) || current.validationStillApplicable !== true) {
      status = 'resume_with_revalidation';
      if (current.contextUnchanged === false || (checkpoint.contextSnapshotId && current.contextSnapshotId !== checkpoint.contextSnapshotId)) reasons.push('项目上下文快照已变化，恢复前需要重新加载并核对资料');
      if (current.validationStillApplicable !== true) reasons.push(current.validationStillApplicable === false ? '原验证证据不再适用于当前代码指纹' : '尚未核实原验证证据的适用性，必须重新验证后继续');
    } else {
      status = 'safe_to_resume'; reasons.push(current.nativeSessionResumeSupported ? '状态指纹一致，可在用户确认后尝试 Runtime 原生恢复' : '状态指纹一致；平台级恢复应创建新 Session，并加载检查点摘要');
    }
  }
  const updated = { ...checkpoint, recoveryStatus: status };
  store.saveTaskCheckpoint(updated);
  return { status, canStartPlatformResume: status === 'safe_to_resume', requiresRevalidation: status === 'resume_with_revalidation', reasons };
}

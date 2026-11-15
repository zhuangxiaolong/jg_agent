import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskCheckpoint, TaskPlan, TaskPlanStep } from '../packages/domain/src';
import { assessTaskRecovery, confirmTaskPlan, createTaskCheckpoint, createTaskPlan, refreshReadyTaskSteps, transitionTaskStep, type TaskGovernanceStore } from '../packages/second-iteration/src/governance';

class MemoryStore implements TaskGovernanceStore {
  plans: TaskPlan[] = [];
  steps: TaskPlanStep[] = [];
  checkpoints: TaskCheckpoint[] = [];
  listTaskPlans(taskId?: string) { return this.plans.filter(item => taskId === undefined || item.taskId === taskId); }
  saveTaskPlan(value: TaskPlan) { this.plans = [...this.plans.filter(item => item.id !== value.id), value]; }
  listTaskPlanSteps(planId: string) { return this.steps.filter(item => item.planId === planId); }
  saveTaskPlanStep(value: TaskPlanStep) { this.steps = [...this.steps.filter(item => item.id !== value.id), value]; }
  listTaskCheckpoints(taskId: string) { return this.checkpoints.filter(item => item.taskId === taskId); }
  getTaskCheckpoint(id: string) { return this.checkpoints.find(item => item.id === id); }
  saveTaskCheckpoint(value: TaskCheckpoint) { this.checkpoints = [...this.checkpoints.filter(item => item.id !== value.id), value]; }
}

const sha = 'a'.repeat(64);

test('F03 计划确认后按依赖推进阶段，并在所有必要步骤完成后结束计划', () => {
  const store = new MemoryStore();
  const created = createTaskPlan(store, {
    taskId: 'task-1', goal: '完成 MES 接口升级', acceptanceCriteria: ['构建通过'],
    steps: [
      { stepKey: 'analysis', title: '需求分析', order: 1 },
      { stepKey: 'implementation', title: '实现', order: 2, dependsOn: ['analysis'] },
    ],
  });
  assert.equal(created.plan.revision, 1);
  assert.equal(created.plan.status, 'review');
  const confirmed = confirmTaskPlan(store, created.plan.id);
  assert.equal(confirmed.status, 'confirmed');
  const ready = refreshReadyTaskSteps(store, created.plan.id);
  assert.equal(ready.find(step => step.stepKey === 'analysis')?.status, 'ready');
  assert.equal(ready.find(step => step.stepKey === 'implementation')?.status, 'pending');
  const analysis = ready.find(step => step.stepKey === 'analysis')!;
  assert.equal(transitionTaskStep(store, created.plan.id, analysis.id, 'running').status, 'running');
  assert.throws(() => transitionTaskStep(store, created.plan.id, created.steps[1].id, 'ready'), /前置步骤/);
  transitionTaskStep(store, created.plan.id, analysis.id, 'succeeded', { outputSummary: '确认接口边界', evidenceRefs: ['doc:1'] });
  const next = refreshReadyTaskSteps(store, created.plan.id).find(step => step.stepKey === 'implementation')!;
  assert.equal(next.status, 'ready');
  transitionTaskStep(store, created.plan.id, next.id, 'running');
  transitionTaskStep(store, created.plan.id, next.id, 'succeeded', { outputSummary: '已完成功能并核对构建证据' });
  assert.equal(store.listTaskPlans('task-1')[0].status, 'completed');
});

test('F03 计划版本递增并使未完成旧版本失效', () => {
  const store = new MemoryStore();
  const input = { taskId: 'task-2', goal: '目标', acceptanceCriteria: ['完成'], steps: [{ stepKey: 'a', title: '步骤', order: 0 }] };
  const first = createTaskPlan(store, input);
  confirmTaskPlan(store, first.plan.id);
  const second = createTaskPlan(store, input);
  assert.equal(second.plan.revision, 2);
  confirmTaskPlan(store, second.plan.id);
  assert.equal(store.listTaskPlans('task-2').find(plan => plan.id === first.plan.id)?.status, 'superseded');
});

test('F03 检查点只接受相对清单并按仓库与文件指纹做恢复审查', () => {
  const store = new MemoryStore();
  const plan = createTaskPlan(store, { taskId: 'task-3', goal: '恢复演练', acceptanceCriteria: ['完成'], steps: [{ stepKey: 'work', title: '执行阶段', order: 0 }] });
  confirmTaskPlan(store, plan.plan.id);
  transitionTaskStep(store, plan.plan.id, plan.steps[0].id, 'blocked', { outputSummary: '待恢复' });
  const checkpoint = createTaskCheckpoint(store, {
    taskId: 'task-3', planId: plan.plan.id, stepId: plan.steps[0].id, branch: 'feature/a', headSha: 'abc123',
    worktreeFingerprint: 'tree-1', contextSnapshotId: 'context-1', checkpointSummary: '代码阶段已完成',
    completedActions: ['实现接口'], pendingActions: ['运行测试'], evidenceRefs: ['verification:1'],
    fileManifest: [{ path: 'src/app.ts', sha256: sha, status: 'M' }],
  });
  assert.throws(() => createTaskCheckpoint(store, {
    taskId: 'task-3', planId: plan.plan.id, stepId: plan.steps[0].id, branch: 'feature/a', headSha: 'abc123',
    worktreeFingerprint: 'tree-1', checkpointSummary: 'bad', completedActions: [], pendingActions: [], evidenceRefs: [],
    fileManifest: [{ path: '../outside', sha256: sha }],
  }), /工作区内相对路径/);
  const base = { branch: 'feature/a', headSha: 'abc123', worktreeFingerprint: 'tree-1', fileManifest: [{ path: 'src/app.ts', sha256: sha, status: 'M' }], contextSnapshotId: 'context-1', contextUnchanged: true, validationStillApplicable: true, runtimeAvailable: true };
  assert.equal(assessTaskRecovery(store, checkpoint.id, base).status, 'safe_to_resume');
  assert.equal(assessTaskRecovery(store, checkpoint.id, { ...base, worktreeFingerprint: 'tree-2' }).status, 'manual_reconciliation_required');
  const changedContext = assessTaskRecovery(store, checkpoint.id, { ...base, contextSnapshotId: 'context-2' });
  assert.equal(changedContext.status, 'resume_with_revalidation');
  assert.equal(changedContext.canStartPlatformResume, false);
  assert.equal(changedContext.requiresRevalidation, true);
  assert.equal(assessTaskRecovery(store, checkpoint.id, { ...base, runtimeAvailable: false }).status, 'cannot_resume');
  assert.equal(store.getTaskCheckpoint(checkpoint.id)?.recoveryStatus, 'cannot_resume');
});

test('F03 拒绝在进行中阶段保存检查点或无实际摘要声明成功', () => {
  const store = new MemoryStore();
  const created = createTaskPlan(store, { taskId: 'boundaries', goal: '校验安全边界', projectId: 'project-a', acceptanceCriteria: ['安全恢复'], steps: [{ stepKey: 'work', title: '执行', order: 0 }] });
  confirmTaskPlan(store, created.plan.id);
  refreshReadyTaskSteps(store, created.plan.id);
  transitionTaskStep(store, created.plan.id, created.steps[0].id, 'running');
  assert.throws(() => transitionTaskStep(store, created.plan.id, created.steps[0].id, 'succeeded'), /实际产出摘要/);
  const checkpoint = { taskId: created.plan.taskId, projectId: 'project-a', planId: created.plan.id, stepId: created.steps[0].id, checkpointSummary: '边界', completedActions: [], pendingActions: [], evidenceRefs: [], fileManifest: [] };
  assert.throws(() => createTaskCheckpoint(store, checkpoint), /安全边界/);
  transitionTaskStep(store, created.plan.id, created.steps[0].id, 'failed', { outputSummary: '命令失败，等待修复' });
  assert.throws(() => createTaskCheckpoint(store, { ...checkpoint, projectId: 'project-b' }), /项目.*不一致/);
  const saved = createTaskCheckpoint(store, checkpoint);
  assert.equal(saved.projectId, 'project-a');
});

test('F03 旧计划不能覆盖新版本，执行中的阶段必须先结束', () => {
  const store = new MemoryStore();
  const input = { taskId: 'revisions', goal: '版本安全', acceptanceCriteria: ['完成'], steps: [{ stepKey: 'work', title: '执行', order: 0 }] };
  const first = createTaskPlan(store, input);
  const second = createTaskPlan(store, input);
  assert.throws(() => confirmTaskPlan(store, first.plan.id), /最新计划版本/);
  confirmTaskPlan(store, second.plan.id);
  refreshReadyTaskSteps(store, second.plan.id);
  transitionTaskStep(store, second.plan.id, second.steps[0].id, 'running');
  const third = createTaskPlan(store, input);
  assert.throws(() => confirmTaskPlan(store, third.plan.id), /阶段结束/);
});

test('F03 前置阶段失效会使下游阶段失效，恢复不默认信任旧验证', () => {
  const store = new MemoryStore();
  const created = createTaskPlan(store, { taskId: 'stale', goal: '依赖安全', acceptanceCriteria: ['完成'], steps: [{ stepKey: 'a', title: '分析', order: 0 }, { stepKey: 'b', title: '实施', dependsOn: ['a'], order: 1 }] });
  confirmTaskPlan(store, created.plan.id);
  refreshReadyTaskSteps(store, created.plan.id);
  transitionTaskStep(store, created.plan.id, created.steps[0].id, 'running');
  transitionTaskStep(store, created.plan.id, created.steps[0].id, 'succeeded', { outputSummary: '已核对分析结果' });
  refreshReadyTaskSteps(store, created.plan.id);
  const saved = createTaskCheckpoint(store, { taskId: created.plan.taskId, planId: created.plan.id, stepId: created.steps[0].id, branch: 'main', headSha: 'abc', worktreeFingerprint: 'hash', fileManifest: [], checkpointSummary: '需重验', completedActions: [], pendingActions: [], evidenceRefs: [] });
  transitionTaskStep(store, created.plan.id, created.steps[0].id, 'invalidated');
  assert.equal(store.listTaskPlanSteps(created.plan.id).find(step => step.stepKey === 'b')?.status, 'invalidated');
  const current = { branch: 'main', headSha: 'abc', worktreeFingerprint: 'hash', fileManifest: [], runtimeAvailable: true };
  assert.equal(assessTaskRecovery(store, saved.id, current).status, 'resume_with_revalidation');
  store.saveTaskCheckpoint({ ...saved, fileManifestJson: '{broken' });
  assert.equal(assessTaskRecovery(store, saved.id, { ...current, validationStillApplicable: true }).status, 'cannot_resume');
});

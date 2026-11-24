import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateExpertTaskResults, assertExpertCollaborationPlan, createAgentTask, createExpertCollaborationPlan } from '../packages/agent-orchestrator/src';
import type { ExpertCollaborationPlan, ExpertPlannerContext } from '../packages/domain/src';

const profiles: ExpertPlannerContext[] = [
  { id: 'mes-wms-requirements', name: '需求分析专家', role: 'requirements_analyst', familyId: 'requirements', enabled: true },
  { id: 'mes-wms-backend', name: '后端开发专家', role: 'backend_developer', familyId: 'backend', enabled: true },
  { id: 'mes-wms-frontend', name: '前端开发专家', role: 'frontend_developer', familyId: 'frontend', enabled: true },
  { id: 'mes-wms-quality', name: '测试质量专家', role: 'test_quality', familyId: 'quality', enabled: true },
  { id: 'mes-wms-engineering', name: '研发工程专家', role: 'implementation_engineer', familyId: 'engineering', enabled: true },
];

test('专家计划按专业工作面生成并默认等待确认', () => {
  const plan = createExpertCollaborationPlan({ sessionId: 'session', projectId: 'project', prompt: '分析后端接口、前端页面和测试用例，输出方案', profiles, now: '2026-11-24T00:00:00.000Z' });
  assert.equal(plan.status, 'review');
  assert.equal(plan.classification, 'parallel');
  assert.equal(plan.maxConcurrency, 3);
  assert.equal(plan.tasks.length, 3);
  assert.ok(plan.tasks.every(task => task.permissionTier === 'read_only' && task.workspaceMode === 'read'));
});

test('识别串行依赖并拒绝依赖环', () => {
  const plan = createExpertCollaborationPlan({ sessionId: 'session', projectId: 'project', prompt: '先分析需求然后做后端接口完成后测试', profiles });
  assert.equal(plan.classification, 'sequential');
  assert.ok(plan.tasks.slice(1).every(task => task.dependencyKeys.length === 1));
  const cyclic: ExpertCollaborationPlan = { ...plan, tasks: plan.tasks.map((task, index) => ({ ...task, dependencyKeys: index === 0 ? [plan.tasks.at(-1)!.taskKey] : task.dependencyKeys })) };
  assert.throws(() => assertExpertCollaborationPlan(cyclic), /依赖环/);
});

test('专家结果按证据和发现识别冲突', () => {
  const plan = createExpertCollaborationPlan({ sessionId: 'session', projectId: 'project', prompt: '分析后端接口和前端页面', profiles });
  const tasks = plan.tasks.map((spec, index) => ({
    ...createAgentTask({ id: `task-${index}`, sessionId: 'session', projectId: 'project', name: spec.expertName, role: spec.role, description: spec.objective, workspaceMode: 'read' }),
    status: 'COMPLETED' as const,
    result: { summary: '完成', structuredResult: { schemaVersion: 1 as const, outcome: 'completed' as const, summary: '完成', findings: [{ title: '接口约束', detail: index === 0 ? 'A' : 'B', evidence: [{ path: 'src/api.ts', sha256: index === 0 ? 'a'.repeat(64) : 'b'.repeat(64) }] }], risks: [], unresolved: [], recommendedNextSteps: [] } },
  }));
  const linked = { ...plan, tasks: plan.tasks.map((task, index) => ({ ...task, agentTaskId: tasks[index].id })), status: 'executing' as const };
  const aggregate = aggregateExpertTaskResults(linked, tasks, '2026-11-24T00:00:00.000Z');
  assert.equal(aggregate.status, 'conflicted');
  assert.equal(aggregate.conflicts.length, 2);
});

test('结构化结果声明失败或部分完成时，汇总不能标记为全部完成', () => {
  const plan = createExpertCollaborationPlan({ sessionId: 'session', projectId: 'project', prompt: '分析后端接口', profiles });
  const tasks = plan.tasks.map((spec, index) => ({
    ...createAgentTask({ id: `outcome-task-${index}`, sessionId: 'session', projectId: 'project', name: spec.expertName, role: spec.role, description: spec.objective, workspaceMode: 'read' }),
    status: 'COMPLETED' as const,
    result: { summary: '模型返回', structuredResult: { schemaVersion: 1 as const, outcome: index === 0 ? 'failed' as const : 'partial' as const, summary: '未完成', findings: [{ title: `结论-${index}`, detail: '待处理', evidence: [{ path: 'src/api.ts', sha256: 'a'.repeat(64) }] }], risks: [], unresolved: [], recommendedNextSteps: [] } },
  }));
  const linked = { ...plan, tasks: plan.tasks.map((task, index) => ({ ...task, agentTaskId: tasks[index].id })), status: 'executing' as const };
  assert.equal(aggregateExpertTaskResults(linked, tasks).status, 'partial');
});

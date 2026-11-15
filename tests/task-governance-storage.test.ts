import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src/index';
import { createTaskCheckpoint, createTaskPlan, confirmTaskPlan, transitionTaskStep } from '../packages/second-iteration/src/governance';

test('F03 检查点和恢复状态在 SQLite 重启后可查询', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-governance-storage-'));
  const filename = join(root, 'agent.db');
  let store: LocalStore | undefined;
  try {
    store = await LocalStore.open(filename);
    const { plan, steps } = createTaskPlan(store, { taskId: 'task-persist', goal: '持久化', acceptanceCriteria: ['重启可读'], steps: [{ stepKey: 'step-1', title: '写检查点', order: 0 }] });
    confirmTaskPlan(store, plan.id);
    transitionTaskStep(store, plan.id, steps[0].id, 'blocked', { outputSummary: '等待接入界面' });
    const checkpoint = createTaskCheckpoint(store, {
      taskId: plan.taskId, planId: plan.id, stepId: steps[0].id, branch: 'main', headSha: 'deadbeef',
      worktreeFingerprint: 'tree-a', fileManifest: [{ path: 'README.md', sha256: 'b'.repeat(64) }],
      checkpointSummary: '已确认存储层写入', completedActions: ['创建计划'], pendingActions: ['接入界面'], evidenceRefs: [],
    });
    store.close();
    store = await LocalStore.open(filename);
    const loaded = store.getTaskCheckpoint(checkpoint.id);
    assert.equal(loaded?.taskId, plan.taskId);
    assert.deepEqual(store.listTaskCheckpoints(plan.taskId).map(item => item.id), [checkpoint.id]);
    assert.equal(loaded?.recoveryStatus, 'not_checked');
    assert.deepEqual(store.listTaskPlanSteps(plan.id).map(item => item.stepKey), ['step-1']);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

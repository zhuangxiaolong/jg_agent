import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTaskLifecycleTransition, createAgentTask, createTaskContract, nextRunnableTasks, reconcileTaskStates, taskContentHash, validateTaskContract, validateTaskEvidence } from '../packages/agent-orchestrator/src';
import type { AgentTask, TaskEvidenceRecord, TaskLifecycleTransition } from '../packages/domain/src';

const timestamp = '2026-11-10T00:00:00.000Z';
function task(): AgentTask {
  return { ...createAgentTask({ id: 'task', sessionId: 'session', projectId: 'project', name: '分析任务', role: 'custom', description: '检查实现及证据', now: timestamp }), contractVersion: 1, stateVersion: 1, executionStatus: 'READY', verificationStatus: 'NOT_STARTED', acceptanceStatus: 'NOT_SUBMITTED' };
}
function transition(value: AgentTask, dimension: TaskLifecycleTransition['dimension'], to: TaskLifecycleTransition['to'], evidence: TaskEvidenceRecord[] = [], extra: Partial<TaskLifecycleTransition> = {}): AgentTask {
  return applyTaskLifecycleTransition(value, { sessionId: value.sessionId, taskId: value.id, dimension, to, expectedStateVersion: value.stateVersion ?? 0, actor: 'reviewer', ...extra }, evidence);
}
function proof(): TaskEvidenceRecord {
  return { id: 'proof', taskId: 'task', sessionId: 'session', projectId: 'project', contractVersion: 1, evidenceType: 'test', source: 'test_runner', status: 'passed', command: 'node --test', workingDirectory: 'D:/project', startedAt: timestamp, finishedAt: timestamp, durationMs: 0, exitCode: 0, logRef: 'stdout.log', manifestRef: 'manifest.json', reportRef: 'junit.xml', testCount: 2, codeFingerprint: 'a'.repeat(64), contentHash: 'b'.repeat(64), createdAt: timestamp, integrityVerified: true };
}

test('任务契约保留显式验收标准，拒绝秘密、越界路径、预算错误和非隔离写入', () => {
  const contract = createTaskContract(task());
  assert.equal(validateTaskContract(contract).contractVersion, 2);
  assert.throws(() => validateTaskContract({ ...contract, goal: 'api_key=synthetic-secret-value' }), /秘密/);
  assert.throws(() => validateTaskContract({ ...contract, allowedPaths: ['../outside'] }), /越界/);
  assert.throws(() => validateTaskContract({ ...contract, budgetPolicy: { ...contract.budgetPolicy, maxToolCalls: 0 } }), /预算/);
  assert.throws(() => validateTaskContract({ ...contract, permissions: ['write_workspace'] }), /隔离工作区/);
  assert.throws(() => createTaskContract({ ...task(), workspaceMode: 'worktree' }), /显式提供验收标准/);
  assert.equal(createTaskContract({ ...task(), workspaceMode: 'worktree' }, { acceptanceCriteria: ['真实构建和测试通过'] }).workspacePolicy, 'isolated_worktree');
});

test('三维状态分离，完成执行不会自动验证或验收，旧任务不可补造通过', () => {
  const running = transition(task(), 'execution', 'RUNNING');
  const completed = transition(running, 'execution', 'COMPLETED');
  assert.equal(completed.verificationStatus, 'NOT_STARTED');
  assert.equal(completed.acceptanceStatus, 'NOT_SUBMITTED');
  assert.equal(completed.attempt, 1);
  assert.throws(() => transition({ ...completed, contractVersion: undefined }, 'verification', 'RUNNING'), /历史任务/);
  assert.throws(() => transition(completed, 'verification', 'PASSED'), /不允许/);
  assert.throws(() => transition(completed, 'verification', 'RUNNING', [], { expectedStateVersion: 0 }), /版本已变化/);
});

test('验证通过只能引用当前契约的完整真实命令证据，零测试和自报通过均拒绝', () => {
  const completed = transition(transition(task(), 'execution', 'RUNNING'), 'execution', 'COMPLETED');
  const verifying = transition(completed, 'verification', 'RUNNING');
  assert.throws(() => transition(verifying, 'verification', 'PASSED'), /真实完整证据/);
  assert.throws(() => validateTaskEvidence({ ...proof(), source: 'runtime' }), /真实执行器/);
  assert.throws(() => validateTaskEvidence({ ...proof(), command: undefined }), /真实执行命令/);
  assert.throws(() => validateTaskEvidence({ ...proof(), testCount: 0 }), /非空真实测试/);
  assert.throws(() => transition(verifying, 'verification', 'PASSED', [{ ...proof(), contractVersion: 2 }], { evidenceIds: ['proof'] }), /当前任务及契约/);
  const passed = transition(verifying, 'verification', 'PASSED', [proof()], { evidenceIds: ['proof'] });
  assert.equal(passed.verificationStatus, 'PASSED');
  assert.equal(passed.acceptanceStatus, 'NOT_SUBMITTED');
});

test('人工验收绑定操作者、意见、契约和证据，重新验证会使已验收状态失效', () => {
  const completed = transition(transition(task(), 'execution', 'RUNNING'), 'execution', 'COMPLETED');
  const passed = transition(transition(completed, 'verification', 'RUNNING'), 'verification', 'PASSED', [proof()], { evidenceIds: ['proof'] });
  const submitted = transition(passed, 'acceptance', 'PENDING_REVIEW');
  assert.throws(() => transition(submitted, 'acceptance', 'ACCEPTED', [proof()]), /人工验收/);
  const acceptance = { reviewer: 'reviewer', comment: '已按标准复核', codeRef: proof().codeFingerprint!, evidenceIds: ['proof'], contractVersion: 1, reviewedAt: timestamp };
  assert.throws(() => transition(submitted, 'acceptance', 'ACCEPTED', [proof()], { acceptance: { ...acceptance, reviewer: 'other' } }), /人工验收/);
  const accepted = transition(submitted, 'acceptance', 'ACCEPTED', [proof()], { acceptance });
  assert.equal(accepted.acceptanceStatus, 'ACCEPTED');
  const verifying = transition(accepted, 'verification', 'RUNNING');
  assert.equal(verifying.acceptanceStatus, 'PENDING_REVIEW');
  assert.equal(verifying.acceptance, undefined);
});

test('验证或验收依赖不满足时不调度，暂停和中断不会被自动恢复', () => {
  const completed: AgentTask = { ...task(), status: 'COMPLETED', executionStatus: 'COMPLETED' };
  const child = { ...task(), id: 'child', dependencyIds: ['task'], dependencyConditions: { task: 'verified' as const }, status: 'WAITING' as const, executionStatus: 'PENDING' as const };
  assert.equal(nextRunnableTasks(reconcileTaskStates([completed, child])).length, 0);
  assert.equal(nextRunnableTasks(reconcileTaskStates([{ ...completed, verificationStatus: 'PASSED' }, child]))[0].id, 'child');
  for (const executionStatus of ['PAUSED', 'INTERRUPTED'] as const) {
    const held = { ...task(), status: 'BLOCKED' as const, executionStatus };
    assert.equal(reconcileTaskStates([held])[0].executionStatus, executionStatus);
    assert.equal(nextRunnableTasks([held]).length, 0);
  }
});

test('稳定内容 Hash 不受对象键顺序影响', () => {
  assert.equal(taskContentHash({ b: 2, a: { d: 4, c: 3 } }), taskContentHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(taskContentHash(['a', 'b']), taskContentHash(['b', 'a']));
});

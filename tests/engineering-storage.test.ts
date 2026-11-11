import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { LocalStore } from '../packages/storage/src';
import { createAgentTask, createTaskContract, taskContentHash, transitionAgentTask, verifyTaskLifecycleEventChain } from '../packages/agent-orchestrator/src';
import type { AgentTask, TaskEvidenceRecord, TaskLifecycleTransition } from '../packages/domain/src';

const timestamp = '2026-11-10T00:00:00.000Z';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-engineering-'));
  const path = join(root, 'agent.db');
  const store = await LocalStore.open(path);
  store.saveProject({ id: 'project', name: '项目', path: join(root, 'project'), branch: 'main' });
  store.saveSession({ id: 'session', projectId: 'project', title: '会话', workspacePath: root, status: 'idle', createdAt: timestamp, model: 'test' });
  const task = createAgentTask({ id: 'task', sessionId: 'session', projectId: 'project', name: '核查任务', role: 'testing', description: '核查测试', now: timestamp });
  return { root, path, store, task };
}
function register(store: LocalStore, task: AgentTask): AgentTask {
  store.saveAgentTaskContract(task, createTaskContract(task), 0, 'local-user');
  return store.listAgentTasks(task.sessionId).find(item => item.id === task.id)!;
}
function move(store: LocalStore, dimension: TaskLifecycleTransition['dimension'], to: TaskLifecycleTransition['to'], extra: Partial<TaskLifecycleTransition> = {}): AgentTask {
  const task = store.listAgentTasks('session').find(item => item.id === 'task')!;
  return store.transitionTaskLifecycle({ sessionId: 'session', taskId: 'task', expectedStateVersion: task.stateVersion!, dimension, to, actor: 'local-user', ...extra });
}
function proof(): TaskEvidenceRecord {
  return { id: 'proof', taskId: 'task', sessionId: 'session', projectId: 'project', evidenceType: 'test', source: 'test_runner', status: 'passed', command: 'node --test', workingDirectory: 'D:/project', startedAt: timestamp, finishedAt: timestamp, durationMs: 0, exitCode: 0, logRef: 'stdout.log', manifestRef: 'manifest.json', reportRef: 'junit.xml', testCount: 1, codeFingerprint: 'a'.repeat(64), contentHash: 'b'.repeat(64), createdAt: timestamp, integrityVerified: true };
}

test('任务和契约原子创建，修订保留版本且清除通过状态，CAS 拒绝过期写入', async () => {
  const f = await fixture();
  try {
    register(f.store, f.task);
    move(f.store, 'execution', 'RUNNING'); move(f.store, 'execution', 'COMPLETED');
    f.store.appendTaskEvidence('session', 'task', proof());
    move(f.store, 'verification', 'RUNNING'); move(f.store, 'verification', 'PASSED', { evidenceIds: ['proof'] });
    const current = f.store.listAgentTasks('session')[0];
    const revised = createTaskContract(current, { acceptanceCriteria: ['补充真实覆盖项'] });
    f.store.saveAgentTaskContract(current, revised, 1, 'local-user');
    assert.equal(f.store.listAgentTasks('session')[0].verificationStatus, 'NOT_STARTED');
    assert.equal(f.store.listAgentTasks('session')[0].acceptanceStatus, 'NOT_SUBMITTED');
    assert.deepEqual(f.store.listAgentTasks('session')[0].evidenceIds, []);
    assert.equal(f.store.getAgentTaskContractVersions('session', 'task').length, 2);
    assert.equal(f.store.listTaskEvidence('session', 'task').length, 1);
    assert.throws(() => f.store.saveAgentTaskContract(current, revised, 1, 'local-user'), /契约版本已变化/);
    assert.throws(() => move(f.store, 'verification', 'RUNNING', { expectedStateVersion: 1 }), /状态版本已变化/);
    assert.equal(verifyTaskLifecycleEventChain(f.store.listTaskLifecycleEvents('session', 'task')), true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('证据追加幂等且不可覆盖，兼容批量保存不能伪造三维通过结果', async () => {
  const f = await fixture();
  try {
    register(f.store, f.task);
    const stored = f.store.appendTaskEvidence('session', 'task', proof());
    assert.equal(stored.contractVersion, 1);
    const eventCount = f.store.listTaskLifecycleEvents('session', 'task').length;
    assert.deepEqual(f.store.appendTaskEvidence('session', 'task', proof()), stored);
    assert.equal(f.store.listTaskLifecycleEvents('session', 'task').length, eventCount);
    assert.throws(() => f.store.appendTaskEvidence('session', 'task', { ...proof(), contentHash: 'c'.repeat(64) }), /不能覆盖/);
    const current = f.store.listAgentTasks('session')[0];
    assert.throws(() => f.store.saveAgentTasksForSession('session', [{ ...current, verificationStatus: 'PASSED' }]), /状态接口/);
    assert.throws(() => f.store.saveAgentTasksForSession('session', [{ ...current, attempt: 0, contractVersion: undefined }]), /契约或状态接口/);
    const running = transitionAgentTask(current, { status: 'RUNNING' });
    f.store.saveAgentTasksForSession('session', [running]);
    assert.equal(f.store.listAgentTasks('session')[0].attempt, 1);
    assert.equal(f.store.listTaskLifecycleEvents('session', 'task').at(-1)?.eventType, 'execution.running');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('新的验证结果精确选择活动证据，历史失败和追加证据不污染已通过结果', async () => {
  const f = await fixture();
  try {
    register(f.store, f.task); move(f.store, 'execution', 'RUNNING'); move(f.store, 'execution', 'COMPLETED');
    f.store.appendTaskEvidence('session', 'task', { ...proof(), id: 'failed', status: 'failed', exitCode: 1 });
    move(f.store, 'verification', 'RUNNING'); move(f.store, 'verification', 'FAILED', { evidenceIds: ['failed'] });
    f.store.appendTaskEvidence('session', 'task', proof());
    move(f.store, 'verification', 'RUNNING'); move(f.store, 'verification', 'PASSED', { evidenceIds: ['proof'] });
    assert.deepEqual(f.store.listAgentTasks('session')[0].evidenceIds, ['proof']);
    move(f.store, 'acceptance', 'PENDING_REVIEW');
    move(f.store, 'acceptance', 'ACCEPTED', { acceptance: { reviewer: 'local-user', comment: '依据通过的当前证据验收', codeRef: proof().codeFingerprint!, evidenceIds: ['proof'], contractVersion: 1, reviewedAt: timestamp } });
    f.store.appendTaskEvidence('session', 'task', { ...proof(), id: 'later', status: 'failed', exitCode: 1 });
    const accepted = f.store.listAgentTasks('session')[0];
    assert.deepEqual(accepted.evidenceIds, ['proof']); assert.equal(accepted.acceptanceStatus, 'ACCEPTED');
    assert.equal(f.store.listTaskEvidence('session', 'task').length, 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('契约及审计事务落盘失败时，任务、版本和审计同步回滚', async () => {
  const f = await fixture();
  try {
    await rm(f.path); await mkdir(f.path);
    assert.throws(() => register(f.store, f.task));
    assert.deepEqual(f.store.listAgentTasks('session'), []);
    assert.deepEqual(f.store.getAgentTaskContractVersions('session', 'task'), []);
    assert.deepEqual(f.store.listTaskLifecycleEvents('session', 'task'), []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('重启中断不自动重放，运行中验证恢复不确定且审计链仅追加一次', async () => {
  const f = await fixture(); let store = f.store;
  try {
    register(store, f.task); move(store, 'execution', 'RUNNING'); move(store, 'verification', 'RUNNING');
    store.close(); store = await LocalStore.open(f.path);
    const task = store.listAgentTasks('session')[0];
    assert.equal(task.status, 'BLOCKED'); assert.equal(task.executionStatus, 'INTERRUPTED');
    assert.equal(task.verificationStatus, 'INCONCLUSIVE');
    assert.equal(task.completedAt, undefined);
    const events = store.listTaskLifecycleEvents('session', 'task');
    assert.equal(events.at(-1)?.eventType, 'task.interrupted');
    store.close(); store = await LocalStore.open(f.path);
    assert.equal(store.listTaskLifecycleEvents('session', 'task').length, events.length);
  } finally { store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('真实验证执行登记不可覆盖，删除会话后仍保留工程证据和审计', async () => {
  const f = await fixture();
  try {
    register(f.store, f.task); f.store.appendTaskEvidence('session', 'task', proof());
    const execution = { runId: 'run', sessionId: 'session', projectId: 'project', recordHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), createdAt: timestamp };
    assert.deepEqual(f.store.registerVerificationExecution(execution), execution);
    assert.deepEqual(f.store.registerVerificationExecution(execution), execution);
    assert.throws(() => f.store.registerVerificationExecution({ ...execution, recordHash: 'e'.repeat(64) }), /不能覆盖/);
    assert.equal(f.store.getVerificationExecution('other-session', 'run'), undefined);
    f.store.deleteSession('session');
    assert.deepEqual(f.store.listAgentTasks('session'), []);
    assert.equal(f.store.listTaskEvidence('session', 'task').length, 1);
    assert.equal(f.store.getAgentTaskContractVersions('session', 'task').length, 1);
    assert.equal(f.store.listTaskLifecycleEvents('session', 'task').length, 2);
    assert.deepEqual(f.store.getVerificationExecution('session', 'run'), execution);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('不可变表有 SQLite 更新删除保护，审计 Hash 可发现载荷修改', async () => {
  const f = await fixture();
  try {
    register(f.store, f.task); f.store.appendTaskEvidence('session', 'task', proof());
    f.store.registerVerificationExecution({ runId: 'run', sessionId: 'session', projectId: 'project', recordHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64), createdAt: timestamp });
    const sql = await initSqlJs(); const db = new sql.Database(await readFile(f.path));
    try {
      for (const table of ['agent_task_contracts', 'agent_task_lifecycle_events', 'agent_task_evidence', 'verification_executions']) {
        assert.throws(() => db.run(`UPDATE ${table} SET value = '{}'`), /append-only/);
        assert.throws(() => db.run(`DELETE FROM ${table}`), /append-only/);
      }
    } finally { db.close(); }
    const events = f.store.listTaskLifecycleEvents('session', 'task');
    assert.equal(verifyTaskLifecycleEventChain(events), true);
    assert.equal(verifyTaskLifecycleEventChain([{ ...events[0], payload: { changed: true } }, ...events.slice(1)]), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('v8 迁移前备份原始字节，升级保留旧任务且不补造契约或验证通过', async () => {
  const f = await fixture(); let store: LocalStore | undefined = f.store;
  try {
    store.saveAgentTasksForSession('session', [f.task]); store.close(); store = undefined;
    const sql = await initSqlJs(); const db = new sql.Database(await readFile(f.path));
    db.run('DROP TABLE agent_task_contracts; DROP TABLE agent_task_lifecycle_events; DROP TABLE agent_task_evidence; DROP TABLE verification_executions; PRAGMA user_version = 8');
    const original = Buffer.from(db.export()); db.close(); await writeFile(f.path, original);
    store = await LocalStore.open(f.path);
    const backups = (await readdir(f.root)).filter(name => name.includes('.pre-v10-from-v8-'));
    assert.equal(backups.length, 1); assert.deepEqual(await readFile(join(f.root, backups[0])), original);
    assert.equal(store.listAgentTasks('session')[0].id, 'task');
    assert.equal(store.listAgentTasks('session')[0].contractVersion, undefined);
    assert.equal(store.listAgentTasks('session')[0].verificationStatus, undefined);
    assert.deepEqual(store.getAgentTaskContractVersions('session', 'task'), []);
    assert.throws(() => store!.saveAgentTasksForSession('session', [{ ...f.task, verificationStatus: 'PASSED' }]), /不能补造/);
    assert.equal(taskContentHash(store.listAgentTasks('session')[0]), taskContentHash(f.task));
  } finally { store?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('工具、预算和审批复用同一审计链，按当前契约还原且禁止原始参数及伪造版本', async () => {
  const f = await fixture();
  try {
    register(f.store, f.task);
    const append = (eventType: string, payload: Record<string, unknown>) => f.store.appendTaskAuditEvent('session', 'task', { eventType, actor: 'platform', payload });
    assert.throws(() => append('execution.completed', {}), /审计元数据/);
    assert.throws(() => append('tool.started', { callId: 'call', arguments: { command: 'ignored' } }), /只能写摘要/);
    assert.throws(() => append('budget.usage', { secret: 'abc' }), /秘密/);
    assert.throws(() => append('tool.started', { callId: 'call', contractVersion: 999 }), /契约版本/);
    append('tool.started', { callId: 'call', toolName: 'read_file', argumentsHash: 'f'.repeat(64) });
    assert.throws(() => append('tool.started', { callId: 'call', toolName: 'read_file', argumentsHash: 'f'.repeat(64) }), /不能重复/);
    append('tool.completed', { callId: 'call', toolName: 'read_file', resultHash: 'e'.repeat(64), outcome: 'succeeded' });
    append('budget.usage', { toolCalls: 1, modelRequests: 1 });
    append('approval.requested', { approvalId: 'approval', decisionHash: 'd'.repeat(64) });
    let snapshot = f.store.getTaskAuditSnapshot('session', 'task');
    assert.equal(snapshot.pendingToolCalls.length, 0); assert.equal(snapshot.toolEvents.length, 2);
    assert.equal(snapshot.budgetEvents.length, 1); assert.equal(snapshot.approvals.length, 1);
    assert.equal(snapshot.events.every(event => event.payload.contractVersion === 1), true);
    assert.equal(verifyTaskLifecycleEventChain(snapshot.events), true);
    const current = f.store.listAgentTasks('session')[0];
    f.store.saveAgentTaskContract(current, createTaskContract(current), 1, 'local-user');
    snapshot = f.store.getTaskAuditSnapshot('session', 'task');
    assert.equal(snapshot.budgetEvents.length, 1, '修订契约不能清零已发生的预算消耗'); assert.equal(snapshot.approvals.length, 0);
    assert.equal(snapshot.events.length, 6);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('工具开始但无确定结果时重启追加 unknown_outcome 并阻塞，不重复执行或重复追加', async () => {
  const f = await fixture(); let store = f.store;
  try {
    register(store, f.task); move(store, 'execution', 'RUNNING');
    store.appendTaskAuditEvent('session', 'task', { eventType: 'tool.started', actor: 'platform', correlationId: 'call', payload: { callId: 'call', toolName: 'read_file', argumentsHash: 'e'.repeat(64) } });
    assert.equal(store.getTaskAuditSnapshot('session', 'task').pendingToolCalls.length, 1);
    store.close(); store = await LocalStore.open(f.path);
    const snapshot = store.getTaskAuditSnapshot('session', 'task');
    assert.equal(snapshot.pendingToolCalls.length, 0);
    assert.equal(snapshot.toolEvents.at(-1)?.eventType, 'tool.unknown_outcome');
    assert.equal(snapshot.toolEvents.at(-1)?.correlationId, 'call');
    assert.equal(store.listAgentTasks('session')[0].executionStatus, 'INTERRUPTED');
    assert.equal(store.listAgentTasks('session')[0].status, 'BLOCKED');
    assert.equal(verifyTaskLifecycleEventChain(snapshot.events), true);
    store.close(); store = await LocalStore.open(f.path);
    assert.equal(store.getTaskAuditSnapshot('session', 'task').events.length, snapshot.events.length);
  } finally { store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('缺少契约不能追加审计，审计落盘失败不消耗状态版本或留下工具开始记录', async () => {
  const f = await fixture();
  try {
    f.store.saveAgentTasksForSession('session', [f.task]);
    const event = { eventType: 'tool.started', actor: 'platform', payload: { callId: 'call', toolName: 'read_file', argumentsHash: 'f'.repeat(64) } };
    assert.throws(() => f.store.appendTaskAuditEvent('session', 'task', event), /已有任务契约/);
    register(f.store, f.task);
    const before = f.store.getTaskAuditSnapshot('session', 'task');
    await rm(f.path); await mkdir(f.path);
    assert.throws(() => f.store.appendTaskAuditEvent('session', 'task', event));
    assert.equal(f.store.getTaskAuditSnapshot('session', 'task').stateVersion, before.stateVersion);
    assert.equal(f.store.getTaskAuditSnapshot('session', 'task').pendingToolCalls.length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

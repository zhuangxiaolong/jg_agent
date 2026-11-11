import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../packages/storage/src';
import { createAgentTask, createTaskContract, taskContentHash, transitionAgentTask } from '../packages/agent-orchestrator/src';
import { TaskEngineeringService } from '../apps/desktop/src/main/task-engineering';
import { VerificationRunService } from '../apps/desktop/src/main/verification-service';

const original = 'module.exports = (a, b) => a + b;\n';
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'jinggong-engineering-regression-')));
  const workspace = path.join(root, 'sample'); await mkdir(workspace);
  const git = (args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  git(['init', '-b', 'main']); git(['config', 'user.email', 'regression@example.invalid']); git(['config', 'user.name', '工程回归测试']);
  await writeFile(path.join(workspace, 'sample.cjs'), original);
  await writeFile(path.join(workspace, 'sample.test.cjs'), 'const {test,describe}=require("node:test"); const assert=require("node:assert/strict"); describe("真实样本",()=>test("真实样本加法",()=>assert.equal(require("./sample.cjs")(2,3),5)));\n');
  git(['add', '.']); git(['commit', '-m', '创建工程回归测试样本']);
  const store = await LocalStore.open(path.join(root, 'local.db'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const projectId = 'b'.repeat(24); const sessionId = randomUUID(); const evidenceRoot = path.join(root, 'evidence');
  store.saveProject({ id: projectId, name: '工程回归样本', path: workspace, branch: 'main' });
  store.saveSession({ id: sessionId, projectId, title: '工程回归样本', workspacePath: workspace, status: 'idle', createdAt: new Date().toISOString(), model: 'sample', runtimeKind: 'codex' });
  const service = new TaskEngineeringService(store, evidenceRoot);
  const current = (taskId = 'first') => service.detail(sessionId, taskId).task;
  const target = (taskId = 'first') => ({ sessionId, taskId, expectedStateVersion: current(taskId).stateVersion! });
  const createCompleted = (taskId: string) => {
    const task = createAgentTask({ id: taskId, sessionId, projectId, name: taskId, role: 'testing', description: '检查真实样本及证据', runtimeKind: 'codex' });
    store.saveAgentTaskContract(task, createTaskContract(task), 0, 'local-user');
    for (const status of ['RUNNING', 'COMPLETED'] as const) store.saveAgentTasksForSession(sessionId, store.listAgentTasks(sessionId).map(item => item.id === taskId ? transitionAgentTask(item, { status }) : item));
  };
  const execute = async () => {
    const result = await new VerificationRunService().execute({ projectId, projectName: '工程回归样本', sessionId, workspacePath: workspace, evidenceRoot, runType: 'test', executable: process.execPath, args: ['--test', '--test-reporter=junit', '--test-reporter-destination={testReport}', 'sample.test.cjs'], testReportPath: 'test-results/junit.xml', timeoutMs: 10_000 });
    store.registerVerificationExecution({ runId: result.record.runId, sessionId, projectId, recordHash: taskContentHash(result.record), manifestHash: taskContentHash(result.manifest), createdAt: result.record.finishedAt });
    return result;
  };
  createCompleted('first');
  return { root, workspace, store, service, sessionId, current, target, createCompleted, execute };
}

test('同一真实验证运行可分别关联同会话两个任务，证据记录按任务隔离', async t => {
  const f = await fixture(t); f.createCompleted('second'); const run = await f.execute();
  const first = await f.service.linkVerification({ ...f.target('first'), runId: run.record.runId });
  const second = await f.service.linkVerification({ ...f.target('second'), runId: run.record.runId });
  assert.equal(first.task.verificationStatus, 'PASSED'); assert.equal(second.task.verificationStatus, 'PASSED');
  assert.notEqual(first.evidence[0].id, second.evidence[0].id);
  assert.equal(first.evidence[0].taskId, 'first'); assert.equal(second.evidence[0].taskId, 'second');
  assert.match(first.evidence[0].id, /^verification-[a-f0-9]{64}$/);
});

test('inspect 实时识别代码过期并保留原验收历史，无法确认时不显示当前通过', async t => {
  const f = await fixture(t); const run = await f.execute();
  await f.service.linkVerification({ ...f.target(), runId: run.record.runId });
  f.service.submitAcceptance(f.target());
  await f.service.resolveAcceptance({ ...f.target(), decision: 'accept', comment: '检查临时样本证据链' });
  assert.equal((await f.service.inspect(f.sessionId, 'first')).evidenceFreshness?.status, 'current');
  const version = f.current().stateVersion;
  await writeFile(path.join(f.workspace, 'sample.cjs'), 'module.exports = () => -1;\n');
  const stale = await f.service.inspect(f.sessionId, 'first');
  assert.equal(stale.evidenceFreshness?.status, 'stale');
  assert.equal(stale.task.verificationStatus, 'PASSED'); assert.equal(stale.task.acceptanceStatus, 'ACCEPTED');
  assert.equal(stale.task.stateVersion, version, '只读复核不改写已记录历史');
  await writeFile(path.join(f.workspace, 'sample.cjs'), original);
  await writeFile(path.join(run.evidenceDirectory, 'stdout.log'), '日志已发生变化\n');
  const unavailable = await f.service.inspect(f.sessionId, 'first');
  assert.equal(unavailable.evidenceFreshness?.status, 'unavailable');
  assert.ok(unavailable.evidenceFreshness?.reason);
  assert.equal(unavailable.evidenceFreshness?.reason?.includes(f.root), false, '错误说明不泄露内部路径或原始异常');
});

test('无活动证据不补造新鲜度，复核期间契约变化返回最新状态并要求刷新', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.inspect(f.sessionId, 'first')).evidenceFreshness?.status, 'not_checked');
  const run = await f.execute(); await f.service.linkVerification({ ...f.target(), runId: run.record.runId });
  const inspecting = f.service.inspect(f.sessionId, 'first');
  f.service.revise({ sessionId: f.sessionId, taskId: 'first', expectedContractVersion: 1, goal: '新契约', outputExpectations: ['新结论'], acceptanceCriteria: ['重新验证当前契约'] });
  const result = await inspecting;
  assert.equal(result.task.contractVersion, 2); assert.equal(result.task.verificationStatus, 'NOT_STARTED');
  assert.equal(result.evidenceFreshness?.status, 'unavailable');
});

test('同一真实运行首次关联过期后恢复原代码，可以重新关联通过并保留两次观察证据', async t => {
  const f = await fixture(t); const run = await f.execute();
  await writeFile(path.join(f.workspace, 'sample.cjs'), 'module.exports = () => -1;\n');
  const stale = await f.service.linkVerification({ ...f.target(), runId: run.record.runId });
  assert.equal(stale.task.verificationStatus, 'INCONCLUSIVE');
  assert.equal(stale.evidence[0].status, 'inconclusive');
  await writeFile(path.join(f.workspace, 'sample.cjs'), original);
  const restored = await f.service.linkVerification({ ...f.target(), runId: run.record.runId });
  assert.equal(restored.task.verificationStatus, 'PASSED');
  assert.equal(restored.evidence.length, 2);
  const selected = restored.evidence.filter(record => restored.task.evidenceIds?.includes(record.id));
  assert.equal(selected.length, 1); assert.equal(selected[0].status, 'passed');
  assert.notEqual(selected[0].id, stale.evidence[0].id);
  assert.equal((await f.service.inspect(f.sessionId, 'first')).evidenceFreshness?.status, 'current');
});

test('原子验证完成预校验失败时，快照、版本和审计不留下中间 RUNNING 状态', async t => {
  const f = await fixture(t);
  const before = f.service.detail(f.sessionId, 'first');
  assert.throws(() => f.store.finalizeTaskVerification({ ...f.target(), dimension: 'verification', to: 'PASSED', actor: 'local-user', evidenceIds: ['missing-evidence'] }), /证据/);
  const after = f.service.detail(f.sessionId, 'first');
  assert.deepEqual(after.task, before.task); assert.deepEqual(after.events, before.events);
  assert.equal(after.task.verificationStatus, 'NOT_STARTED');
});

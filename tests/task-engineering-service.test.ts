import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../packages/storage/src';
import { createAgentTask, createTaskContract, taskContentHash, transitionAgentTask } from '../packages/agent-orchestrator/src';
import { TaskEngineeringService } from '../apps/desktop/src/main/task-engineering';
import { VerificationRunService, type VerificationRunResult } from '../apps/desktop/src/main/verification-service';

// 仅验证临时工程样本的证据链，不代表真实业务功能已经验收。
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'jinggong-task-engineering-')));
  const workspace = path.join(root, 'sample');
  await mkdir(workspace);
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'engineering@example.invalid'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', '工程样本测试'], { cwd: workspace, stdio: 'ignore' });
  await writeFile(path.join(workspace, 'sample.cjs'), 'module.exports = (a, b) => a + b;\n');
  await writeFile(path.join(workspace, 'sample.test.cjs'), 'const {test,describe}=require("node:test"); const assert=require("node:assert/strict"); describe("临时样本",()=>test("样本加法",()=>assert.equal(require("./sample.cjs")(2,3),5)));\n');
  await writeFile(path.join(workspace, 'failure.test.cjs'), 'const {test,describe}=require("node:test"); const assert=require("node:assert/strict"); describe("失败样本",()=>test("预期失败样本",()=>assert.fail("故障注入")));\n');
  execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', '创建临时工程测试样本'], { cwd: workspace, stdio: 'ignore' });
  const store = await LocalStore.open(path.join(root, 'local.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const projectId = 'a'.repeat(24);
  const sessionId = randomUUID();
  store.saveProject({ id: projectId, path: workspace, name: '临时工程样本', branch: 'main' });
  store.saveSession({ id: sessionId, projectId, title: '临时工程证据链', workspacePath: workspace, branch: 'main', status: 'idle', createdAt: new Date().toISOString(), model: 'sample-model', runtimeKind: 'codex', mode: 'read' });
  const evidenceRoot = path.join(root, 'evidence');
  const service = new TaskEngineeringService(store, evidenceRoot);
  const taskId = 'sample-task';
  const task = createAgentTask({ id: taskId, sessionId, projectId, name: '检查临时样本', role: 'testing', description: '验证临时工程样本及证据完整性', runtimeKind: 'codex', workspaceMode: 'read' });
  store.saveAgentTaskContract(task, createTaskContract(task), 0, 'local-user');
  const current = () => service.detail(sessionId, taskId).task;
  const target = () => ({ sessionId, taskId, expectedStateVersion: current().stateVersion! });
  const transition = (status: 'RUNNING' | 'COMPLETED') => store.saveAgentTasksForSession(sessionId, [transitionAgentTask(current(), { status })]);
  const complete = () => { transition('RUNNING'); transition('COMPLETED'); };
  const register = (result: VerificationRunResult) => store.registerVerificationExecution({ runId: result.record.runId, sessionId, projectId, recordHash: taskContentHash(result.record), manifestHash: taskContentHash(result.manifest), createdAt: result.record.finishedAt });
  const execute = async (kind: 'pass' | 'fail' | 'zero' = 'pass', registered = true) => {
    const args = kind === 'zero'
      ? ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2]);', '{testReport}', '<testsuite name="zero-fixture" tests="0"/>']
      : ['--test', '--test-reporter=junit', '--test-reporter-destination={testReport}', kind === 'fail' ? 'failure.test.cjs' : 'sample.test.cjs'];
    const result = await new VerificationRunService().execute({ projectId, projectName: '临时工程样本', sessionId, workspacePath: workspace, evidenceRoot, runType: 'test', executable: process.execPath, args, testReportPath: 'test-results/junit.xml', timeoutMs: 10_000 });
    if (registered) register(result);
    return result;
  };
  const link = (result: VerificationRunResult) => service.linkVerification({ ...target(), runId: result.record.runId });
  const submit = () => service.submitAcceptance(target());
  const accept = (comment = '仅确认临时样本的测试及证据链满足本测试条件') => service.resolveAcceptance({ ...target(), decision: 'accept', comment });
  return { root, workspace, store, service, projectId, sessionId, taskId, current, target, transition, complete, execute, register, link, submit, accept };
}

test('真实临时样本通过仍须分别关联验证、提交人工验收并填写意见', async t => {
  const f = await fixture(t);
  f.complete();
  assert.equal(f.current().executionStatus, 'COMPLETED');
  assert.equal(f.current().verificationStatus, 'NOT_STARTED');
  assert.equal(f.current().acceptanceStatus, 'NOT_SUBMITTED');
  const result = await f.execute();
  assert.equal(result.record.exitCode, 0);
  assert.ok((result.record.testReport?.total ?? 0) > 0, JSON.stringify({ record: result.record, stderr: await readFile(path.join(result.evidenceDirectory, 'stderr.log'), 'utf8'), stdout: await readFile(path.join(result.evidenceDirectory, 'stdout.log'), 'utf8') }));
  assert.equal(f.current().verificationStatus, 'NOT_STARTED');
  const linked = await f.link(result);
  assert.equal(linked.task.verificationStatus, 'PASSED');
  assert.equal(linked.task.acceptanceStatus, 'NOT_SUBMITTED');
  assert.equal(linked.evidence[0].integrityVerified, true);
  assert.equal(f.submit().task.acceptanceStatus, 'PENDING_REVIEW');
  const accepted = await f.accept();
  assert.equal(accepted.task.acceptanceStatus, 'ACCEPTED');
  assert.equal(accepted.task.acceptance?.reviewer, 'local-user');
  assert.equal(accepted.task.acceptance?.contractVersion, 1);
  assert.ok(accepted.task.acceptance?.codeRef);
  assert.ok(accepted.events.length >= 6);
});

test('真实进程结果没有平台执行登记也不能作为可信证据', async t => {
  const f = await fixture(t); f.complete();
  const result = await f.execute('pass', false);
  await assert.rejects(f.link(result), /真实执行登记/);
  assert.equal(f.current().verificationStatus, 'NOT_STARTED');
  assert.deepEqual(f.service.detail(f.sessionId, f.taskId).evidence, []);
});

test('已登记运行的 run.json 元数据篡改会被登记摘要拒绝', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute();
  const filename = path.join(result.evidenceDirectory, 'run.json');
  const record = JSON.parse(await readFile(filename, 'utf8'));
  record.executable = '篡改后的执行器';
  await writeFile(filename, JSON.stringify(record));
  await assert.rejects(f.link(result), /元数据已经变化/);
});

test('真实日志文件被篡改后不能关联通过', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute();
  await writeFile(path.join(result.evidenceDirectory, 'stdout.log'), '篡改日志\n');
  await assert.rejects(f.link(result), /完整性|摘要|证据/);
});

test('真实失败样本判定失败，不能据此验收通过', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute('fail');
  assert.notEqual(result.record.exitCode, 0);
  assert.equal((await f.link(result)).task.verificationStatus, 'FAILED');
  f.submit();
  await assert.rejects(f.accept(), /真实通过证据/);
});

test('零测试报告故障注入只可判无法确定，不能误判通过', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute('zero');
  assert.equal(result.record.exitCode, 0);
  assert.equal((await f.link(result)).task.verificationStatus, 'INCONCLUSIVE');
  f.submit();
  await assert.rejects(f.accept(), /真实通过证据/);
});

test('验证通过后当前代码变化会阻止人工验收', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute();
  await f.link(result); f.submit();
  await writeFile(path.join(f.workspace, 'sample.cjs'), 'module.exports = () => -1;\n');
  await assert.rejects(f.accept(), /过期|变化/);
  assert.equal(f.current().acceptanceStatus, 'PENDING_REVIEW');
});

test('错误会话及跨会话运行无法关联证据', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute();
  const otherSessionId = randomUUID();
  f.store.saveSession({ id: otherSessionId, projectId: f.projectId, title: '其他会话', workspacePath: f.workspace, status: 'idle', createdAt: new Date().toISOString(), model: 'sample-model' });
  await assert.rejects(f.service.linkVerification({ ...f.target(), sessionId: otherSessionId, runId: result.record.runId }), /不存在|不属于/);
  const filename = path.join(result.evidenceDirectory, 'run.json');
  const record = JSON.parse(await readFile(filename, 'utf8'));
  record.sessionId = otherSessionId;
  await writeFile(filename, JSON.stringify(record));
  await assert.rejects(f.link(result), /不存在|未找到|归属/);
});

test('旧契约的真实运行不能用于新契约验证', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute();
  f.service.revise({ sessionId: f.sessionId, taskId: f.taskId, expectedContractVersion: 1, goal: '新契约的样本检查', outputExpectations: ['提供新契约结论'], acceptanceCriteria: ['按新契约重新运行测试'] });
  assert.equal(f.current().contractVersion, 2);
  await assert.rejects(f.link(result), /早于当前契约/);
  assert.equal(f.current().verificationStatus, 'NOT_STARTED');
});

test('过期状态版本无法关联验证、提交验收或处理人工决定', async t => {
  const f = await fixture(t); f.complete(); const result = await f.execute();
  const outdated = { ...f.target(), expectedStateVersion: f.current().stateVersion! - 1 };
  await assert.rejects(f.service.linkVerification({ ...outdated, runId: result.record.runId }), /状态已变化/);
  assert.throws(() => f.service.submitAcceptance(outdated), /版本|状态/);
  await f.link(result); f.submit();
  await assert.rejects(f.service.resolveAcceptance({ ...outdated, decision: 'accept', comment: '临时样本意见' }), /版本|状态/);
  assert.throws(() => f.service.revise({ sessionId: f.sessionId, taskId: f.taskId, expectedContractVersion: 0, goal: '过期修改', outputExpectations: ['样本结论'], acceptanceCriteria: ['样本测试'] }), /版本|契约/);
});

test('执行未结束或执行结束前的运行不能关联最终验证', async t => {
  const f = await fixture(t); f.transition('RUNNING'); const result = await f.execute();
  await assert.rejects(f.link(result), /执行完成后/);
  f.transition('COMPLETED');
  await assert.rejects(f.link(result), /执行结束后/);
});

test('人工接受与拒绝都必须提供非空意见', async t => {
  const f = await fixture(t); f.complete(); await f.link(await f.execute()); f.submit();
  for (const decision of ['accept', 'reject']) {
    await assert.rejects(f.service.resolveAcceptance({ ...f.target(), decision, comment: '   ' }));
    await assert.rejects(f.service.resolveAcceptance({ ...f.target(), decision }));
  }
  assert.equal(f.current().acceptanceStatus, 'PENDING_REVIEW');
});

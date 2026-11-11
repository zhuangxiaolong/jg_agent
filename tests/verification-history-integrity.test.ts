import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStore } from '../packages/storage/src';
import { taskContentHash } from '../packages/agent-orchestrator/src';
import type { Session } from '../packages/domain/src';
import { VerificationRunService, listVerificationHistory, type VerificationRunRecord } from '../apps/desktop/src/main/verification-service';
import { inspectVerificationHistory, verificationHistoryMarkdown, verificationHistorySummary } from '../apps/desktop/src/main/verification-history';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'jinggong-history-integrity-')));
  const workspace = path.join(root, 'sample'); await mkdir(workspace);
  const git = (args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
  git(['init', '-b', 'main']); git(['config', 'user.name', '历史证据测试']); git(['config', 'user.email', 'history@example.invalid']); git(['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(workspace, 'sample.cjs'), 'module.exports = (a,b) => a+b;\n');
  await writeFile(path.join(workspace, 'pass.test.cjs'), 'const {test}=require("node:test"); const assert=require("node:assert/strict"); test("真实通过样本",()=>assert.equal(require("./sample.cjs")(2,3),5));\n');
  await writeFile(path.join(workspace, 'fail.test.cjs'), 'const {test}=require("node:test"); const assert=require("node:assert/strict"); test("真实失败样本",()=>assert.fail("故障注入"));\n');
  git(['add', '.']); git(['commit', '-m', '建立历史验证完整性样本']);
  const store = await LocalStore.open(path.join(root, 'local.db')); const projectId = 'c'.repeat(24);
  const session: Session = { id: randomUUID(), projectId, title: '历史证据', workspacePath: workspace, branch: 'main', status: 'idle', model: 'test', createdAt: new Date().toISOString() };
  store.saveProject({ id: projectId, name: '历史验证样本', path: workspace, branch: 'main' }); store.saveSession(session);
  const evidenceRoot = path.join(root, 'evidence');
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const execute = async (kind: 'pass' | 'fail' = 'pass', register = true) => {
    const result = await new VerificationRunService().execute({ projectId, projectName: '历史验证样本', sessionId: session.id, workspacePath: workspace, evidenceRoot, runType: 'test', executable: process.execPath, args: ['--test', '--test-reporter=junit', '--test-reporter-destination={testReport}', `${kind}.test.cjs`], testReportPath: 'test-results/junit.xml', timeoutMs: 10_000 });
    if (register) store.registerVerificationExecution({ runId: result.record.runId, sessionId: session.id, projectId, recordHash: taskContentHash(result.record), manifestHash: taskContentHash(result.manifest), createdAt: result.record.finishedAt });
    return result;
  };
  const history = async () => (await listVerificationHistory(evidenceRoot, projectId, session.id, 50)).map(item => item.record);
  const inspect = async (full = false) => inspectVerificationHistory(evidenceRoot, session, await history(), store, { full });
  return { root, workspace, store, session, evidenceRoot, execute, history, inspect };
}

test('历史通过只有完成登记和制品复核后才显示，通过详情不信任旧report.md文字', async t => {
  const f = await fixture(t); const run = await f.execute();
  assert.equal(run.record.status, 'passed'); assert.ok((run.record.testReport?.total ?? 0) > 0);
  await writeFile(path.join(run.evidenceDirectory, 'report.md'), '# CANARY_OLD_REPORT_PASSED\n旧报告声称永远通过\n');
  const [list] = await f.inspect(); assert.equal(verificationHistorySummary(list).status, 'passed');
  const [detail] = await f.inspect(true); const markdown = verificationHistoryMarkdown(detail);
  assert.equal(detail.verified, true); assert.match(markdown, /本次复核结论：通过/);
  assert.equal(markdown.includes('CANARY_OLD_REPORT_PASSED'), false);
  assert.equal(markdown.includes('旧报告声称永远通过'), false);
});

test('真实进程未登记时历史仍可看，列表和详情都不能沿用文件里的passed', async t => {
  const f = await fixture(t); await f.execute('pass', false);
  assert.equal((await f.history()).length, 1);
  for (const full of [false, true]) {
    const [review] = await f.inspect(full);
    assert.equal(review.status, 'indeterminate'); assert.equal(review.verified, false);
    assert.match(review.reason, /真实执行登记/);
    assert.match(verificationHistoryMarkdown(review), /本次复核结论：无法判定/);
  }
});

test('将真实失败的run.json篡改成passed和零退出码仍被不可变登记拒绝', async t => {
  const f = await fixture(t); const run = await f.execute('fail');
  assert.equal(run.record.status, 'failed'); assert.notEqual(run.record.exitCode, 0);
  await writeFile(path.join(run.evidenceDirectory, 'run.json'), JSON.stringify({ ...run.record, status: 'passed', exitCode: 0 }));
  const [review] = await f.inspect(); assert.equal(review.record.status, 'passed');
  assert.equal(verificationHistorySummary(review).status, 'indeterminate'); assert.equal(review.verified, false);
});

test('日志、Manifest语义内容以及cwd元数据篡改均不能显示通过', async t => {
  const f = await fixture(t); const run = await f.execute();
  const stdoutFile = path.join(run.evidenceDirectory, 'stdout.log'); const stdout = await readFile(stdoutFile);
  await writeFile(stdoutFile, '日志故障注入\n');
  assert.equal((await f.inspect())[0].status, 'indeterminate'); await writeFile(stdoutFile, stdout);
  const manifestFile = path.join(run.evidenceDirectory, 'manifest.json'); const manifest = await readFile(manifestFile);
  await writeFile(manifestFile, JSON.stringify({ ...run.manifest, unexpected: '篡改额外语义字段' }));
  const [modifiedManifest] = await f.inspect(); assert.equal(modifiedManifest.status, 'indeterminate');
  assert.match(modifiedManifest.reason, /Manifest/); await writeFile(manifestFile, manifest);
  const { cwd: _cwd, ...missingCwd } = run.record;
  await writeFile(path.join(run.evidenceDirectory, 'run.json'), JSON.stringify(missingCwd));
  assert.equal((await f.inspect())[0].status, 'indeterminate');
});

test('当前工作目录丢失时保留历史查看，但列表及详情为无法判定', async t => {
  const f = await fixture(t); await f.execute(); await rm(f.workspace, { recursive: true, force: true });
  assert.equal((await f.history()).length, 1);
  for (const full of [false, true]) {
    const [review] = await f.inspect(full); assert.equal(review.status, 'indeterminate'); assert.equal(review.verified, false);
    assert.match(verificationHistoryMarkdown(review), /本次复核结论：无法判定/);
    assert.equal(review.reason.includes(f.root), false, '固定错误分类不泄露内部路径');
  }
});

test('代码变化标为过期，真实失败详情可复核，列表不把未重验的失败冒充已核实', async t => {
  const f = await fixture(t); const failed = await f.execute('fail');
  const [unreviewed] = await f.inspect(); assert.equal(unreviewed.status, 'indeterminate');
  const [failure] = await f.inspect(true); assert.equal(failure.status, 'failed'); assert.equal(failure.verified, true);
  const passed = await f.execute(); await writeFile(path.join(f.workspace, 'sample.cjs'), 'module.exports = () => -1;\n');
  const reviews = await f.inspect();
  assert.equal(reviews.find(item => item.record.runId === passed.record.runId)!.status, 'stale');
  assert.notEqual(reviews.find(item => item.record.runId === failed.record.runId)!.status, 'passed');
});

test('批量复核共享快照但结束时再次检查，期间代码变动不能保留旧通过结论', async t => {
  const f = await fixture(t); await f.execute(); await f.execute();
  const records: VerificationRunRecord[] = await f.history(); let reads = 0;
  const reviews = await inspectVerificationHistory(f.evidenceRoot, f.session, records, {
    getVerificationExecution(sessionId, runId) {
      reads += 1;
      if (reads === 2) writeFileSync(path.join(f.workspace, 'sample.cjs'), 'module.exports = () => -1;\n');
      return f.store.getVerificationExecution(sessionId, runId);
    },
  });
  assert.equal(reads, 2); assert.equal(reviews.length, 2);
  assert.equal(reviews.some(item => item.status === 'passed'), false);
  assert.equal(reviews.every(item => item.status === 'stale'), true);
});

test('历史已读入后再篡改运行元数据，复核必须重新核对磁盘内容', async t => {
  const f = await fixture(t); const run = await f.execute(); const records = await f.history();
  const [review] = await inspectVerificationHistory(f.evidenceRoot, f.session, records, {
    getVerificationExecution(sessionId, runId) {
      writeFileSync(path.join(run.evidenceDirectory, 'run.json'), JSON.stringify({ ...run.record, exitCode: 1 }));
      return f.store.getVerificationExecution(sessionId, runId);
    },
  });
  assert.equal(review.status, 'indeterminate'); assert.equal(review.verified, false);
});

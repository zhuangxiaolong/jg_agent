import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEvidenceManifest, evaluateBuildRun, evaluateTestRun, fingerprintWorkspace, generateMarkdownRunReport, parseJUnitXml, verifyEvidenceManifest } from '../packages/verification/src';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('JUnit XML 确定性解析通过、失败、错误、跳过与嵌套套件', () => {
  const xml = `<?xml version="1.0"?>
<testsuites tests="4" failures="1" errors="1" skipped="1">
  <testsuite name="根" tests="4">
    <testcase classname="根" name="成功"/>
    <testcase classname="根" name="失败"><failure message="期望不符">stack trace</failure></testcase>
    <testcase classname="根" name="错误"><error message="异常"/></testcase>
    <testcase classname="根" name="跳过"><skipped message="条件不满足"/></testcase>
  </testsuite>
</testsuites>`;
  const first = parseJUnitXml(xml);
  assert.deepEqual(parseJUnitXml(xml), first);
  assert.equal(first.status, 'parsed');
  assert.deepEqual({ total: first.total, passed: first.passed, failed: first.failed, errors: first.errors, skipped: first.skipped }, { total: 4, passed: 1, failed: 1, errors: 1, skipped: 1 });
  assert.equal(first.tests[1].message, '期望不符');
});

test('JUnit 空白、零用例、统计冲突和损坏 XML 均不会伪装为有效通过报告', () => {
  assert.equal(parseJUnitXml(' ').status, 'empty');
  const zero = parseJUnitXml('<testsuite name="empty" tests="0"/>');
  assert.equal(zero.status, 'parsed');
  assert.equal(zero.error, 'JUnit 报告没有 testcase，不能证明测试通过');
  assert.equal(zero.total, 0);
  assert.equal(parseJUnitXml('<testsuite name="bad" tests="2"><testcase name="only"/></testsuite>').status, 'invalid');
  assert.equal(parseJUnitXml('<testsuite><testcase></testsuite>').status, 'invalid');
});

test('真实 Node 顶层 test() 的 JUnit 直接 testcase 可解析，失败进程仍失败', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jinggong-node-junit-'));
  try {
    for (const failing of [false, true]) {
      const filename = path.join(root, failing ? 'failure.test.cjs' : 'pass.test.cjs');
      await writeFile(filename, `const {test}=require('node:test'); const assert=require('node:assert/strict'); test('顶层真实断言',()=>assert.equal(2+3,${failing ? 6 : 5})); test.skip('明确跳过的样本',()=>{});\n`);
      const environment = { ...process.env }; delete environment.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, ['--test', '--test-reporter=junit', filename], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: environment });
      assert.equal(child.error, undefined);
      assert.equal(child.status, failing ? 1 : 0);
      assert.match(child.stdout, /<testsuites>/);
      assert.match(child.stdout, /<testcase /);
      assert.doesNotMatch(child.stdout, /<testsuite\s/);
      const report = parseJUnitXml(child.stdout);
      assert.equal(report.status, 'parsed'); assert.equal(report.total, 2); assert.equal(report.skipped, 1);
      assert.equal(report.failed, failing ? 1 : 0); assert.equal(report.passed, failing ? 0 : 1);
      const result = evaluateTestRun({ runExists: true, processStarted: true, processStatus: 'completed', exitCode: child.status, report, evidenceIntegrityValid: true, fingerprintBefore: 'same', fingerprintAfter: 'same' });
      assert.equal(result, failing ? 'failed' : 'passed');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('直接 testcase 与嵌套套件混合时不重复计数，空标记不能误判通过', () => {
  const mixed = parseJUnitXml('<testsuites tests="2" failures="1" skipped="0"><testcase name="顶层通过"/><testsuite name="嵌套" tests="1" failures="1"><testcase name="失败"><failure/></testcase></testsuite></testsuites>');
  assert.equal(mixed.status, 'parsed'); assert.equal(mixed.total, 2); assert.equal(mixed.failed, 1); assert.equal(mixed.passed, 1);
  for (const [marker, status] of [['failure', 'failed'], ['error', 'error'], ['skipped', 'skipped']] as const) {
    const parsed = parseJUnitXml(`<testsuites><testcase name="空标记"><${marker}/></testcase></testsuites>`);
    assert.equal(parsed.status, 'parsed'); assert.equal(parsed.tests[0].status, status);
  }
  assert.equal(parseJUnitXml('<testsuites><testcase name="冲突"><failure/><skipped/></testcase></testsuites>').status, 'invalid');
  assert.equal(parseJUnitXml('<testsuites tests="2"><testcase name="只有一个"/></testsuites>').status, 'invalid');
  assert.equal(parseJUnitXml('<testsuites failures="0"><testsuite><testcase><failure/></testcase></testsuite></testsuites>').status, 'invalid');
  assert.equal(parseJUnitXml('<testsuites><testsuite tests="2"><testcase name="嵌套统计错误"/></testsuite></testsuites>').status, 'invalid');
});

test('testsuites 空报告、缺失根节点与损坏 XML 仍无法证明测试通过', () => {
  const base = { runExists: true, processStarted: true, processStatus: 'completed' as const, exitCode: 0, evidenceIntegrityValid: true, fingerprintBefore: 'same', fingerprintAfter: 'same' };
  for (const source of ['', '<testsuites tests="0"/>', '<notjunit><testcase name="伪报告"/></notjunit>', '<testsuites><testcase></testsuites>']) {
    const report = parseJUnitXml(source);
    assert.equal(evaluateTestRun({ ...base, report }), 'indeterminate');
  }
  assert.equal(evaluateTestRun(base), 'indeterminate');
});

test('测试状态只由进程、报告、指纹和证据决定，缺项 fail closed', () => {
  const report = parseJUnitXml('<testsuite name="suite" tests="2"><testcase name="a"/><testcase name="b"/></testsuite>');
  const base = { runExists: true, processStarted: true, processStatus: 'completed' as const, exitCode: 0, report, evidenceIntegrityValid: true, fingerprintBefore: 'same', fingerprintAfter: 'same' };
  assert.equal(evaluateTestRun(base), 'passed');
  assert.equal(evaluateTestRun({ ...base, runExists: false }), 'not_run');
  assert.equal(evaluateTestRun({ ...base, processStatus: 'cancelled' }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, exitCode: 7 }), 'failed');
  assert.equal(evaluateTestRun({ ...base, report: undefined }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, evidenceIntegrityValid: false }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, fingerprintAfter: 'changed' }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, fingerprintCurrent: 'newer' }), 'stale');
  assert.equal(evaluateTestRun({ ...base, processStatus: 'timed_out' }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, processStatus: 'crashed' }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, processStatus: 'launch_failed' }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, report: { ...report, passed: 1 } }), 'indeterminate');
  const failing = parseJUnitXml('<testsuite tests="1" failures="1"><testcase name="x"><failure message="failed"/></testcase></testsuite>');
  assert.equal(evaluateTestRun({ ...base, report: failing }), 'failed');
});

test('零测试需要明确允许原因且报告必须是结构完整的空套件', () => {
  const emptyReport = parseJUnitXml('<testsuite name="empty" tests="0"/>');
  const base = { runExists: true, processStarted: true, processStatus: 'completed' as const, exitCode: 0, report: emptyReport, evidenceIntegrityValid: true, fingerprintBefore: 'same', fingerprintAfter: 'same' };
  assert.equal(evaluateTestRun(base), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, allowZeroTests: true }), 'indeterminate');
  assert.equal(evaluateTestRun({ ...base, allowZeroTests: true, zeroTestsReason: '本项目为编译验证' }), 'passed');
  assert.equal(evaluateTestRun({ ...base, report: parseJUnitXml(''), allowZeroTests: true, zeroTestsReason: '本项目为编译验证' }), 'indeterminate');
});

test('Build 状态与 Test 分离，构建成功不能产生测试状态', () => {
  const build = { runExists: true, processStarted: true, processStatus: 'completed' as const, exitCode: 0, evidenceIntegrityValid: true, fingerprintBefore: 'same', fingerprintAfter: 'same' };
  assert.equal(evaluateBuildRun(build), 'passed');
  assert.equal(evaluateBuildRun({ ...build, fingerprintCurrent: 'newer' }), 'stale');
  assert.equal(evaluateBuildRun({ ...build, exitCode: 1 }), 'failed');
});

test('工作区指纹对文件顺序无关、对内容和版本字段敏感并拒绝重复路径', () => {
  const common = { headSha: 'a'.repeat(40), indexDiffSha256: digest('index'), workingTreeDiffSha256: digest('work') };
  const files = [{ path: 'src/a.ts', sha256: digest('a') }, { path: 'src/b.ts', sha256: digest('b') }];
  assert.equal(fingerprintWorkspace({ ...common, files }), fingerprintWorkspace({ ...common, files: [...files].reverse() }));
  assert.notEqual(fingerprintWorkspace({ ...common, files }), fingerprintWorkspace({ ...common, files: [{ ...files[0], sha256: digest('changed') }, files[1]] }));
  assert.throws(() => fingerprintWorkspace({ ...common, files: [files[0], files[0]] }), /重复/);
  assert.throws(() => fingerprintWorkspace({ ...common, files: [{ path: '../secret', sha256: digest('x') }] }), /相对路径/);
});

test('证据清单排序、SHA-256 校验并检测文件和 manifest 篡改', async () => {
  const content = Buffer.from('真实进程输出');
  const manifest = createEvidenceManifest('run-1', [
    { relativePath: 'stderr.log', bytes: Buffer.from(''), mimeType: 'text/plain', createdAt: '2026-11-09T00:00:00.000Z' },
    { relativePath: 'stdout.log', bytes: content, mimeType: 'text/plain', createdAt: '2026-11-09T00:00:00.000Z' },
  ]);
  assert.equal(manifest.files[0].relativePath, 'stderr.log');
  const contents = new Map(manifest.files.map(file => [file.relativePath, file.relativePath === 'stdout.log' ? content : Buffer.from('')]));
  assert.equal(await verifyEvidenceManifest(manifest, async relative => contents.get(relative)!), true);
  assert.equal(await verifyEvidenceManifest(manifest, async relative => relative === 'stdout.log' ? Buffer.from('被修改') : contents.get(relative)!), false);
  assert.equal(await verifyEvidenceManifest({ ...manifest, runId: 'run-2' }, async relative => contents.get(relative)!), false);
  assert.throws(() => createEvidenceManifest('run', [{ relativePath: '../escape', bytes: content, mimeType: 'text/plain', createdAt: 'now' }]), /相对路径/);
});

test('Markdown 报告由结构化字段确定生成并分列构建/测试结论', () => {
  const testReport = parseJUnitXml('<testsuite name="suite" tests="1"><testcase name="failing"><failure message="断言失败"/></testcase></testsuite>');
  const report = {
    runId: 'run-1', projectName: '精工', sessionId: 'session-1', jiraIssueKey: 'MES-1', runType: 'test' as const,
    status: 'failed' as const, command: 'npm test', cwd: 'D:/repo', branch: 'agent/session-1', headSha: 'abc',
    fingerprintBefore: 'before', fingerprintAfter: 'after', startedAt: '2026-11-09T00:00:00.000Z', finishedAt: '2026-11-09T00:01:00.000Z',
    durationMs: 60000, exitCode: 1, testReport, evidenceManifestSha256: digest('manifest'), limitations: ['集成测试未执行'],
  };
  const markdown = generateMarkdownRunReport(report);
  assert.equal(generateMarkdownRunReport(report), markdown);
  assert.match(markdown, /测试统计/);
  assert.match(markdown, /断言失败/);
  assert.match(markdown, /集成测试未执行/);
  assert.match(markdown, /不代表测试覆盖充分/);
  assert.doesNotMatch(markdown, /全部测试通过/);
});

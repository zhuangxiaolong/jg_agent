import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VerificationRunService, currentWorkspaceFingerprint, isVerificationRecordStale } from '../apps/desktop/src/main/verification-service';
import { verifyEvidenceManifest } from '../packages/verification/src';

async function createWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jinggong-verification-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'verification@example.invalid'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Verification Test'], { cwd: root, stdio: 'ignore' });
  await writeFile(path.join(root, 'source.txt'), 'baseline\n', 'utf8');
  execFileSync('git', ['add', 'source.txt'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const projectId = 'a'.repeat(24);
const sessionId = '123e4567-e89b-42d3-a456-426614174000';

test('主进程验证服务从真实子进程采集 JUnit、Exit Code、日志与 manifest', async () => {
  const workspace = await createWorkspace();
  const data = await mkdtemp(path.join(os.tmpdir(), 'jinggong-evidence-'));
  try {
    const xml = '<testsuite name="suite" tests="2"><testcase name="one"/><testcase name="two"/></testsuite>';
    const script = 'require("node:fs").writeFileSync(process.argv[1], process.argv[2]); console.log("success from process"); console.error("stderr from process");';
    const result = await new VerificationRunService().execute({
      projectId,
      projectName: 'verification-fixture',
      sessionId,
      workspacePath: workspace.root,
      evidenceRoot: path.join(data, 'evidence'),
      runType: 'test',
      executable: process.execPath,
      args: ['-e', script, '{testReport}', xml],
      testReportPath: 'test-results/junit.xml',
      timeoutMs: 10_000,
    });
    assert.equal(result.record.processStarted, true);
    assert.equal(result.record.processStatus, 'completed');
    assert.equal(result.record.exitCode, 0);
    assert.equal(result.record.status, 'passed');
    assert.equal(result.record.testReport?.total, 2);
    assert.equal(result.record.testReport?.passed, 2);
    assert.match(await readFile(path.join(result.evidenceDirectory, 'stdout.log'), 'utf8'), /success from process/);
    assert.match(await readFile(path.join(result.evidenceDirectory, 'stderr.log'), 'utf8'), /stderr from process/);
    const persisted = JSON.parse(await readFile(path.join(result.evidenceDirectory, 'run.json'), 'utf8')) as { status: string; exitCode: number | null };
    assert.equal(persisted.status, 'passed');
    assert.equal(persisted.exitCode, 0);
    assert.equal(await verifyEvidenceManifest(result.manifest, async relative => readFile(path.join(result.evidenceDirectory, relative))), true);
    assert.match(await readFile(path.join(result.evidenceDirectory, 'report.md'), 'utf8'), /测试统计/);
  } finally {
    await workspace.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test('真实非零 Exit Code 优先判失败，即使进程输出 success', async () => {
  const workspace = await createWorkspace();
  const data = await mkdtemp(path.join(os.tmpdir(), 'jinggong-evidence-failed-'));
  try {
    const result = await new VerificationRunService().execute({
      projectId,
      projectName: 'verification-fixture',
      sessionId,
      workspacePath: workspace.root,
      evidenceRoot: path.join(data, 'evidence'),
      runType: 'build',
      executable: process.execPath,
      args: ['-e', 'console.log("success"); process.exit(7)'],
      timeoutMs: 10_000,
    });
    assert.equal(result.record.processStarted, true);
    assert.equal(result.record.exitCode, 7);
    assert.equal(result.record.status, 'failed');
    assert.match(result.markdown, /失败/);
  } finally {
    await workspace.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test('执行中修改工作区会使本次验证无法判定', async () => {
  const workspace = await createWorkspace();
  const data = await mkdtemp(path.join(os.tmpdir(), 'jinggong-evidence-stale-'));
  try {
    const result = await new VerificationRunService().execute({
      projectId,
      projectName: 'verification-fixture',
      sessionId,
      workspacePath: workspace.root,
      evidenceRoot: path.join(data, 'evidence'),
      runType: 'build',
      executable: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync("generated.txt", "changed");'],
      timeoutMs: 10_000,
    });
    assert.equal(result.record.exitCode, 0);
    assert.equal(result.record.status, 'indeterminate');
    assert.notEqual(result.record.fingerprintBefore, result.record.fingerprintAfter);
  } finally {
    await workspace.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

test('查看历史时当前工作区指纹变化会标记证据过期', async () => {
  const workspace = await createWorkspace();
  const data = await mkdtemp(path.join(os.tmpdir(), 'jinggong-evidence-current-'));
  try {
    const result = await new VerificationRunService().execute({
      projectId,
      projectName: 'verification-fixture',
      sessionId,
      workspacePath: workspace.root,
      evidenceRoot: path.join(data, 'evidence'),
      runType: 'build',
      executable: process.execPath,
      args: ['-e', ''],
      timeoutMs: 10_000,
    });
    await writeFile(path.join(workspace.root, 'source.txt'), 'changed after verification\n', 'utf8');
    const current = await currentWorkspaceFingerprint(workspace.root);
    assert.notEqual(result.record.fingerprintAfter, current);
    assert.equal(isVerificationRecordStale(result.record, current), true);
  } finally {
    await workspace.cleanup();
    await rm(data, { recursive: true, force: true });
  }
});

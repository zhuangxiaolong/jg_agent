import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import type { AgentTask, Session } from '../../../../packages/domain/src';
import { evaluateBuildRun, evaluateTestRun, parseJUnitXml, verifyEvidenceManifest, type EvidenceManifest } from '../../../../packages/verification/src';
import { currentWorkspaceFingerprint, listVerificationHistory, readVerificationArtifact, type VerificationRunRecord } from './verification-service';
import { taskContentHash } from '../../../../packages/agent-orchestrator/src';

export interface ResolvedTaskVerification {
  record: VerificationRunRecord;
  manifest: EvidenceManifest;
  status: 'PASSED' | 'FAILED' | 'INCONCLUSIVE';
  currentFingerprint: string;
  contentHash: string;
  logRef: string;
  artifactRef?: string;
}
export interface VerificationRunReadOptions { record?: VerificationRunRecord; currentFingerprint?: string }

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

/** 复核真实制品及代码；调用方还须核对不可变执行登记，不能将文件记录本身当作登记。 */
export async function resolveVerificationRun(root: string, session: Session, runId: string, workspace = session.workspacePath, options: VerificationRunReadOptions = {}): Promise<ResolvedTaskVerification> {
  if (!session.projectId || !/^[a-f0-9]{24}$/i.test(session.projectId) || !/^[a-f0-9-]{36}$/i.test(session.id)) throw new Error('验证项目或会话标识无效');
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('验证运行标识无效');
  const record = options.record ?? (await listVerificationHistory(root, session.projectId, session.id, 50)).find(entry => entry.record.runId === runId)?.record;
  if (!record) throw new Error('未找到可关联的真实验证记录');
  if (record.version !== 1 || record.runId !== runId || record.projectId !== session.projectId || record.sessionId !== session.id || !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.finishedAt)) || Date.parse(record.finishedAt) < Date.parse(record.startedAt)) throw new Error('验证元数据身份或时间无效');
  if (!samePath(record.cwd, workspace)) throw new Error('验证工作区与任务工作区不一致');
  const directory = path.join(path.resolve(root), session.projectId, session.id, runId);
  let parent = path.resolve(root);
  for (const part of ['', session.projectId, session.id, runId]) {
    parent = path.join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('证据目录身份异常');
  }
  for (const name of ['run.json', 'manifest.json']) {
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('验证元数据文件身份异常');
  }
  const currentRecord = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')) as VerificationRunRecord;
  if (taskContentHash(currentRecord) !== taskContentHash(record)) throw new Error('验证元数据在复核期间发生变化');
  const manifest = JSON.parse(await readVerificationArtifact(root, session.projectId, session.id, runId, 'manifest.json')) as EvidenceManifest;
  const readArtifact = async (relative: string): Promise<Uint8Array> => {
    if (!['stdout.log', 'stderr.log', 'test-results/junit.xml'].includes(relative)) throw new Error('证据清单包含未授权文件');
    let current = directory;
    const parts = relative.split('/');
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024 : !info.isDirectory())) throw new Error('证据文件身份异常');
    }
    return readFile(current);
  };
  const integrity = manifest.runId === runId && manifest.sha256 === record.evidenceManifestSha256
    && manifest.files?.some(file => file.relativePath === 'stdout.log')
    && manifest.files?.some(file => file.relativePath === 'stderr.log')
    && await verifyEvidenceManifest(manifest, readArtifact);
  if (!integrity) throw new Error('验证证据完整性校验失败');
  const reportFile = manifest.files.find(file => file.relativePath === 'test-results/junit.xml');
  const report = reportFile ? parseJUnitXml(Buffer.from(await readArtifact(reportFile.relativePath)).toString('utf8')) : undefined;
  const fingerprint = options.currentFingerprint ?? await currentWorkspaceFingerprint(workspace);
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error('当前工作区指纹无效');
  const common = {
    runExists: true, processStarted: record.processStarted, processStatus: record.processStatus,
    exitCode: record.exitCode, evidenceIntegrityValid: true,
    fingerprintBefore: record.fingerprintBefore, fingerprintAfter: record.fingerprintAfter,
  };
  const evaluated = record.runType === 'test' ? evaluateTestRun({ ...common, report }) : evaluateBuildRun(common);
  const stale = !record.fingerprintAfter || fingerprint !== record.fingerprintAfter;
  const status = stale ? 'INCONCLUSIVE' : evaluated === 'passed' ? 'PASSED' : evaluated === 'failed' ? 'FAILED' : 'INCONCLUSIVE';
  const ref = [session.projectId, session.id, runId].join('/');
  return {
    record: { ...record, ...(report ? { testReport: report } : {}) }, manifest, status, currentFingerprint: fingerprint,
    contentHash: taskContentHash({ record, manifest }),
    logRef: `${ref}/stdout.log`, ...(reportFile ? { artifactRef: `${ref}/${reportFile.relativePath}` } : {}),
  };
}

/** 任务关联在基础制品校验之上，保留本次任务执行及完成时间边界。 */
export async function resolveTaskVerification(root: string, session: Session, task: AgentTask, runId: string): Promise<ResolvedTaskVerification> {
  if (task.sessionId !== session.id || !session.projectId || task.projectId !== session.projectId) throw new Error('验证与任务不属于同一项目和会话');
  const resolved = await resolveVerificationRun(root, session, runId, task.workspacePath ?? session.workspacePath);
  if (!task.startedAt || Date.parse(resolved.record.startedAt) < Date.parse(task.startedAt)) throw new Error('验证早于本次任务执行，不能复用为当前任务证据');
  if (task.completedAt && Date.parse(resolved.record.startedAt) < Date.parse(task.completedAt)) throw new Error('验证必须在任务执行结束后运行');
  return resolved;
}

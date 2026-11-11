import type { Session, VerificationRunSummary } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { taskContentHash } from '../../../../packages/agent-orchestrator/src';
import { generateMarkdownRunReport, type VerificationStatus } from '../../../../packages/verification/src';
import { currentWorkspaceFingerprint, type VerificationRunRecord } from './verification-service';
import { resolveVerificationRun } from './task-evidence';

export interface VerificationHistoryReview {
  record: VerificationRunRecord;
  status: VerificationStatus;
  verified: boolean;
  checkedAt: string;
  reason: string;
}

/** 同一批历史共用工作区快照，末尾重验一次；只有完整复核才允许显示通过。 */
export async function inspectVerificationHistory(root: string, session: Session, records: readonly VerificationRunRecord[], executions: Pick<LocalStore, 'getVerificationExecution'>, options: { full?: boolean } = {}): Promise<VerificationHistoryReview[]> {
  let fingerprint: Promise<string> | undefined;
  const current = () => fingerprint ??= currentWorkspaceFingerprint(session.workspacePath);
  const reviews: VerificationHistoryReview[] = [];
  const review = (record: VerificationRunRecord, status: VerificationStatus, verified: boolean, reason: string): VerificationHistoryReview => ({ record, status, verified, checkedAt: new Date().toISOString(), reason });
  for (const record of records) {
    try {
      const registered = executions.getVerificationExecution(session.id, record.runId);
      if (!registered || registered.projectId !== session.projectId || registered.recordHash !== taskContentHash(record)) {
        reviews.push(review(record, 'indeterminate', false, '历史记录缺少真实执行登记，或记录内容已变化，不能确认原结论'));
        continue;
      }
      if (!options.full && record.status !== 'passed') {
        reviews.push(review(record, 'indeterminate', false, '历史非通过记录尚未完整复核制品，请打开详情查看本次复核结论'));
        continue;
      }
      const snapshot = await current();
      const resolved = await resolveVerificationRun(root, session, record.runId, session.workspacePath, { record, currentFingerprint: snapshot });
      if (registered.recordHash !== taskContentHash(resolved.record) || registered.manifestHash !== taskContentHash(resolved.manifest)) {
        reviews.push(review(record, 'indeterminate', false, '真实执行登记与当前元数据或 Manifest 不一致，不能确认原结论'));
        continue;
      }
      const status: VerificationStatus = snapshot !== record.fingerprintAfter ? 'stale' : resolved.status === 'PASSED' ? 'passed' : resolved.status === 'FAILED' ? 'failed' : 'indeterminate';
      reviews.push(review(resolved.record, status, true, status === 'stale' ? '当前代码指纹与该次执行不一致，证据已过期' : status === 'passed' ? '已核对真实执行登记、Manifest、日志及当前代码指纹' : '已核对真实执行登记及制品，本次结果为失败或无法判定'));
    } catch {
      reviews.push(review(record, 'indeterminate', false, '当前工作区、执行登记或证据文件无法完成复核，不能确认原结论'));
    }
  }
  if (fingerprint) {
    try {
      const before = await fingerprint;
      const after = await currentWorkspaceFingerprint(session.workspacePath);
      if (before !== after) return reviews.map(item => item.verified ? { ...item, status: 'stale', reason: '历史复核期间代码发生变化，请刷新后重新检查' } : item);
    } catch {
      return reviews.map(item => item.verified ? { ...item, status: 'indeterminate', verified: false, reason: '历史复核期间工作区不可用，无法确认当前代码版本' } : item);
    }
  }
  return reviews;
}

function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function count(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0; }

/** 接口不接受原始 record.status，避免调用方再次把文件中的 passed 当作复核结论。 */
export function verificationHistorySummary(review: VerificationHistoryReview): VerificationRunSummary {
  const { record } = review;
  const processStatus = ['not_started', 'running', 'completed', 'cancelled', 'timed_out', 'crashed', 'launch_failed'].includes(record.processStatus) ? record.processStatus : 'not_started';
  const limitations = Array.isArray(record.limitations) ? record.limitations.filter(item => typeof item === 'string') : [];
  return {
    runId: text(record.runId), projectId: text(record.projectId), projectName: text(record.projectName, '历史项目'), sessionId: text(record.sessionId),
    runType: record.runType === 'test' ? 'test' : 'typecheck', status: review.status, processStatus,
    exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
    startedAt: text(record.startedAt), finishedAt: text(record.finishedAt), durationMs: count(record.durationMs),
    ...(typeof record.headSha === 'string' ? { headSha: record.headSha } : {}),
    ...(typeof record.fingerprintBefore === 'string' ? { fingerprintBefore: record.fingerprintBefore } : {}),
    ...(typeof record.fingerprintAfter === 'string' ? { fingerprintAfter: record.fingerprintAfter } : {}),
    stdoutBytes: count(record.stdoutBytes), stderrBytes: count(record.stderrBytes), stdoutTruncated: record.stdoutTruncated === true, stderrTruncated: record.stderrTruncated === true,
    limitations: [...new Set([...limitations, `本次历史复核：${review.reason}`])],
    ...(review.verified && record.testReport ? { testReport: { total: record.testReport.total, passed: record.testReport.passed, failed: record.testReport.failed, skipped: record.testReport.skipped, errors: record.testReport.errors, status: record.testReport.status } } : {}),
  };
}

/** 重新生成详情，不将旧 report.md 中的通过文字视作本次权威结论。 */
export function verificationHistoryMarkdown(review: VerificationHistoryReview, cleanText: (value: string) => string = value => value): string {
  const { record } = review;
  const summary = verificationHistorySummary(review);
  const labels: Record<VerificationStatus, string> = { passed: '通过', failed: '失败', stale: '已过期', indeterminate: '无法判定', not_run: '未执行' };
  const generated = generateMarkdownRunReport({
    runId: summary.runId, projectName: summary.projectName, sessionId: summary.sessionId,
    runType: record.runType === 'test' ? 'test' : record.runType === 'build' || record.runType === 'lint' || record.runType === 'custom' ? record.runType : 'typecheck',
    status: review.status, command: [text(record.executable, '未确认'), ...(Array.isArray(record.args) ? record.args.filter(item => typeof item === 'string') : [])].join(' '),
    cwd: text(record.cwd, '未确认'), branch: text(record.branch), headSha: summary.headSha,
    fingerprintBefore: summary.fingerprintBefore, fingerprintAfter: summary.fingerprintAfter,
    startedAt: summary.startedAt, finishedAt: summary.finishedAt, durationMs: summary.durationMs, exitCode: summary.exitCode,
    evidenceManifestSha256: text(record.evidenceManifestSha256, '未确认'), limitations: summary.limitations,
    ...(review.verified && record.testReport ? { testReport: record.testReport } : {}),
  });
  return cleanText(`> 本次复核结论：${labels[review.status]}。${review.reason}。\n> 复核时间：${review.checkedAt}。以下根据本次复核重新生成；历史报告可作为制品查看，不代表当前代码仍然通过。\n\n${generated}`);
}

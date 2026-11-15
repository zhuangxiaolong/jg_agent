import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ImpactReport, Project, ReviewFinding, ReviewRun, Session } from '../../../../packages/domain/src';
import { analyzeDiffImpact, type ImpactDiffSet } from '../../../../packages/impact-analysis/src';
import type { ImpactReviewDetail, ImpactReviewRecord, ImpactReviewTarget, ManagedReviewFinding } from '../../../../packages/impact-analysis/src/contracts';
import type { GitConnector } from '../../../../packages/git-connector/src';

type Handle = (channel: string, fn: (...args: any[]) => any) => void;
interface ImpactStore {
  listImpactReports(taskId?: string): ImpactReport[];
  saveImpactReport(value: ImpactReport): void;
  listReviewRuns(taskId?: string): ReviewRun[];
  saveReviewRun(value: ReviewRun): void;
  listReviewFindings(reviewRunId: string): ReviewFinding[];
  saveReviewFinding(value: ReviewFinding): void;
}
const projectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i);
const targetSchema = z.object({ projectId: projectIdSchema, sessionId: z.string().uuid().optional() }).strict();
const reportSchema = z.object({ projectId: projectIdSchema, reportId: z.string().uuid() }).strict();
const dispositionSchema = reportSchema.extend({ findingId: z.string().uuid(), status: z.enum(['confirmed', 'ignored', 'false_positive']), reason: z.string().trim().max(2000).optional() }).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isRecord = (value: ImpactReport): value is ImpactReviewRecord => (value as ImpactReviewRecord).kind === 'static-impact-v1';
const sameTarget = (left: ImpactReviewTarget, right: ImpactReviewTarget) => left.projectId === right.projectId && left.sessionId === right.sessionId;

export function impactReportMarkdown(detail: ImpactReviewDetail): string {
  const { report, findings } = detail;
  const cell = (value: string) => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
  return [
    '# 代码变更影响分析报告', '', `报告：${report.id}`, `时间：${report.createdAt}`, `范围：${report.scopeDescription}`, `状态：${report.status}${report.staleReason ? `（${report.staleReason}）` : ''}`,
    `HEAD：${report.analysis.head}`, `Diff SHA256：${report.diffFingerprint}`, '',
    '## 覆盖与限制', ...report.limitations.map(value => `- ${value}`), '',
    '## 实际变更文件', '| 文件 | 状态 | 新增 | 删除 | 范围 |', '|---|---|---:|---:|---|',
    ...report.analysis.files.map(file => `| ${cell(file.path)} | ${file.status} | ${file.additions} | ${file.deletions} | ${file.changedLineStart ?? '未知'}–${file.changedLineEnd ?? '未知'} |`), '',
    '## 风险与人工处置', ...findings.flatMap(finding => [
      `### ${finding.severity} · ${finding.title}`,
      `- 文件：${finding.filePath ?? '未知'}${finding.startLine ? `:${finding.startLine}` : ''}`,
      `- 证据：${finding.confidence}；来源：${finding.source}；状态：${finding.status}；历史关联：${finding.correlation}`,
      finding.description, `- 建议：${finding.suggestion}`,
      ...(finding.dispositionReason ? [`- 处置理由：${finding.dispositionReason}`] : []), '',
    ]),
    '## 建议回归（尚未执行）', ...report.analysis.recommendedCommands.map(item => `- ${item.command}：${item.reason}`), '',
    '本报告不代表构建、测试、人工审查或业务验收已通过。', '',
  ].join('\n');
}

export function registerImpactAnalysisIpc(input: {
  handle: Handle;
  store: ImpactStore;
  git: Pick<GitConnector, 'projectState' | 'state' | 'diff' | 'repositoryIdentity'>;
  project: (value: unknown) => Project;
  session?: (value: unknown) => Session;
  selectExportPath: (defaultName: string) => Promise<string | undefined>;
}) {
  const { handle, store, git, project } = input;
  function resolveTarget(value: unknown) {
    const target = targetSchema.parse(value);
    const owner = project(target.projectId);
    if (!target.sessionId) return { target, owner, workspace: owner.path, taskId: `project:${owner.id}` };
    const session = input.session?.(target.sessionId);
    if (!session || session.projectId !== owner.id) throw new Error('审查会话不属于当前项目');
    return { target, owner, workspace: session.workspacePath, taskId: session.id };
  }
  async function readDiff(target: ImpactReviewTarget): Promise<ImpactDiffSet> {
    const resolved = resolveTarget(target);
    if (target.sessionId && await git.repositoryIdentity(resolved.workspace) !== await git.repositoryIdentity(resolved.owner.path)) throw new Error('会话工作区与项目仓库身份不一致');
    const state = target.sessionId ? await git.state(resolved.workspace, true) : await git.projectState(resolved.owner);
    const head = state.commits[0]?.hash;
    if (!head) throw new Error('当前仓库没有可审查的 HEAD 提交');
    const changes = await git.diff(resolved.workspace, true);
    const after = target.sessionId ? await git.state(resolved.workspace, true) : await git.projectState(resolved.owner);
    if (after.branch !== state.branch || after.commits[0]?.hash !== head) throw new Error('读取期间仓库分支或 HEAD 发生变化，请重试');
    const normalized = changes.map(file => ({ ...file, layer: file.staged ? '含暂存区' : '工作区' }));
    return { baseCommit: head, head, baseIsAncestor: true, changes: normalized, truncated: normalized.some(file => file.truncated), fingerprint: hash({ head, branch: state.branch, changes: normalized }) };
  }
  function records(target: ImpactReviewTarget): ImpactReviewRecord[] {
    return store.listImpactReports().filter(isRecord).filter(item => sameTarget(item.target, target));
  }
  function findReport(projectId: string, reportId: string): ImpactReviewRecord {
    project(projectId);
    const record = store.listImpactReports().filter(isRecord).find(item => item.id === reportId && item.projectId === projectId);
    if (!record) throw new Error('当前项目没有此审查报告');
    return record;
  }
  function findings(record: ImpactReviewRecord): ManagedReviewFinding[] {
    return store.listReviewFindings(record.reviewRunId) as ManagedReviewFinding[];
  }
  function stale(record: ImpactReviewRecord, reason: string) {
    if (record.status === 'stale' && record.staleReason === reason) return record;
    const updated: ImpactReviewRecord = { ...record, status: 'stale', staleReason: reason };
    store.saveImpactReport(updated);
    const run = store.listReviewRuns(record.taskId).find(item => item.id === record.reviewRunId);
    if (run) store.saveReviewRun({ ...run, status: 'stale', findings: store.listReviewFindings(run.id) });
    return updated;
  }
  async function refresh(record: ImpactReviewRecord): Promise<ImpactReviewRecord> {
    try {
      const current = await readDiff(record.target);
      if (current.fingerprint !== record.diffFingerprint) return stale(record, '代码、分支或 HEAD 已变化，请重新分析');
      return record;
    } catch {
      return stale(record, '当前代码状态无法复核，历史报告仅供追溯');
    }
  }
  async function detail(projectId: string, reportId: string): Promise<ImpactReviewDetail> {
    const report = await refresh(findReport(projectId, reportId));
    return { report, findings: findings(report) };
  }
  handle('impact-review:list', async (value: unknown) => {
    const { target } = resolveTarget(value);
    const history = records(target).slice(0, 50);
    // 相同范围只读取一次 Git，避免每份历史报告重复扫描仓库。
    let current: ImpactDiffSet | undefined;
    try { current = await readDiff(target); } catch { /* 无法读取时全部按不可复核处理。 */ }
    return history.map(record => !current ? stale(record, '当前代码状态无法复核，历史报告仅供追溯') : current.fingerprint === record.diffFingerprint ? record : stale(record, '代码、分支或 HEAD 已变化，请重新分析'));
  });
  handle('impact-review:analyze', async (value: unknown) => {
    const { target, taskId } = resolveTarget(value);
    const diff = await readDiff(target);
    const analysis = analyzeDiffImpact(diff);
    const previous = records(target)[0];
    const previousFindings = previous ? findings(previous) : [];
    const id = randomUUID(), runId = randomUUID(), now = analysis.generatedAt;
    const currentFindings: ManagedReviewFinding[] = analysis.findings.map(finding => {
      const fingerprint = hash({ path: finding.path, source: finding.source, title: finding.title, line: finding.startLine });
      const old = previousFindings.find(item => item.fingerprint === fingerprint);
      // 规则再次命中只说明疑点仍存在，不证明旧的“忽略/误报”对新正文仍适用。
      return { id: randomUUID(), reviewRunId: runId, fingerprint, severity: finding.risk,
        confidence: finding.evidence === 'observed' ? 'verified' : finding.evidence === 'inferred' ? 'likely' : 'suggestion',
        filePath: finding.path, startLine: finding.startLine, endLine: finding.endLine, title: finding.title,
        description: finding.reason, evidenceRefs: [`git-diff:${diff.fingerprint}:${finding.path}`], status: 'open',
        source: finding.source, suggestion: finding.suggestion, correlation: old ? 'persisting' : 'new', ...(old ? { previousFindingId: old.id } : {}), updatedAt: now };
    });
    const limitations = ['本报告使用 Git 事实及确定性路径规则；未调用 AI 模型。', '范围仅覆盖相对于当前 HEAD 的未提交变更（含新增文件），不覆盖此前已提交的分支成果。', '建议回归未自动执行；未命中规则不表示代码正确或安全。'];
    if (analysis.truncated) limitations.push('变更或正文达到读取上限，不能覆盖完整范围。');
    const report: ImpactReviewRecord = { id, taskId, projectId: target.projectId, diffFingerprint: diff.fingerprint, status: 'completed', createdAt: now,
      findings: analysis.findings.map(item => ({ path: item.path, status: item.risk, reason: item.reason, evidence: item.evidence })), recommendedSuites: analysis.recommendedCommands.map(item => item.command),
      kind: 'static-impact-v1', target, analysis, reviewRunId: runId, scopeDescription: target.sessionId ? '当前会话工作区 · 相对于 HEAD 的未提交变更' : '当前项目仓库 · 相对于 HEAD 的未提交变更', limitations };
    store.saveReviewRun({ id: runId, taskId, projectId: target.projectId, diffFingerprint: diff.fingerprint, status: 'completed', findings: currentFindings, createdAt: now });
    for (const finding of currentFindings) store.saveReviewFinding(finding);
    store.saveImpactReport(report);
    for (const older of records(target).filter(item => item.id !== id && item.diffFingerprint !== diff.fingerprint && item.status !== 'stale')) stale(older, '后续分析发现代码状态变化');
    return { report, findings: currentFindings } satisfies ImpactReviewDetail;
  });
  handle('impact-review:detail', async (value: unknown) => { const parsed = reportSchema.parse(value); return detail(parsed.projectId, parsed.reportId); });
  handle('impact-review:finding-update', async (value: unknown) => {
    const parsed = dispositionSchema.parse(value);
    if ((parsed.status === 'ignored' || parsed.status === 'false_positive') && !parsed.reason) throw new Error('忽略或标记误报时必须填写理由');
    const result = await detail(parsed.projectId, parsed.reportId);
    if (result.report.status === 'stale') throw new Error('代码已经变化，请重新分析后处置问题');
    const finding = result.findings.find(item => item.id === parsed.findingId);
    if (!finding) throw new Error('当前报告没有此问题');
    const updated: ManagedReviewFinding = { ...finding, status: parsed.status, dispositionReason: parsed.reason, updatedAt: new Date().toISOString() };
    store.saveReviewFinding(updated);
    const all = result.findings.map(item => item.id === finding.id ? updated : item);
    const run = store.listReviewRuns(result.report.taskId).find(item => item.id === result.report.reviewRunId);
    if (run) store.saveReviewRun({ ...run, findings: all });
    return { report: result.report, findings: all } satisfies ImpactReviewDetail;
  });
  handle('impact-review:export', async (value: unknown) => {
    const parsed = reportSchema.parse(value);
    const result = await detail(parsed.projectId, parsed.reportId);
    const outputPath = await input.selectExportPath(`代码影响分析-${result.report.id.slice(0, 8)}.md`);
    if (!outputPath) return { cancelled: true };
    // 在保存对话框关闭后再次复核；报告与当前代码不一致时导出明确的过期状态。
    const latest = await detail(parsed.projectId, parsed.reportId);
    await writeFile(outputPath, impactReportMarkdown(latest), 'utf8');
    return { cancelled: false, path: outputPath };
  });
}

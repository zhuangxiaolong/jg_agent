import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DeliveryPackageRecord, JiraIssue, JiraWritebackRecord, Project, VerificationRunSummary } from '../../../../packages/domain/src';
import type { DeliveryPreview, DeliveryRequest, DeliverySnapshot, DeliveryWritebackPreview } from '../../../../packages/domain/src/delivery';
import { buildDeliveryPackage, deliveryHash, nextDeliveryRevision, renderDeliverySummary } from '../../../../packages/delivery/src';
import type { GitConnector } from '../../../../packages/git-connector/src';
import type { JiraConnector } from '../../../../packages/jira-connector/src';
import type { LocalStore } from '../../../../packages/storage/src';

type DeliveryStore = Pick<LocalStore, 'listSessions' | 'listAgentTasks' | 'listTaskEvidence' | 'listTaskPlans' | 'listTaskPlanSteps' | 'listImpactReports' | 'listReviewRuns' | 'listReviewFindings' | 'listDeliveryPackages' | 'saveDeliveryPackage' | 'listJiraWritebackRecords' | 'saveJiraWritebackRecord' | 'getJira'>;
export interface DeliveryIpcDependencies {
  handle: (channel: string, fn: (...args: any[]) => any) => void;
  store: DeliveryStore;
  git: Pick<GitConnector, 'projectState' | 'changesSince'>;
  project: (value: unknown) => Project;
  selectOutput: (suggestedName: string) => Promise<string | null>;
  jira: () => Pick<JiraConnector, 'getIssue' | 'addComment' | 'uploadAttachment'>;
  jiraScope: () => string;
  assertJiraScope: (scope: string) => void;
  assertCleanText: (text: string) => void;
  verificationRuns?: (projectId: string, sessionId?: string) => Promise<VerificationRunSummary[]>;
}
const id = z.string().trim().min(1).max(160);
const projectId = z.string().regex(/^[a-f0-9]{24}$/i);
const jiraKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}-[1-9]\d{0,19}$/);
const requestSchema = z.object({ projectId, sessionId: id.optional(), taskId: id.optional(), jiraKey: jiraKey.optional(), implementationNotes: z.string().max(12000).optional(), remainingItems: z.string().max(12000).optional() }).strict();
const writebackSchema = z.object({ previewId: z.string().uuid(), operation: z.enum(['comment', 'attachment']), comment: z.string().trim().min(1).max(30000).optional(), packageId: id.optional() }).strict();
const MAX_AGE_MS = 30 * 60 * 1000;
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function issueFingerprint(issue: JiraIssue): string { return deliveryHash(JSON.stringify({ id: issue.id, key: issue.key, summary: issue.summary, description: issue.description, status: issue.status, updated: issue.updated, attachments: issue.attachments.map(item => ({ id: item.id, name: item.name, size: item.size })) })); }

export function registerDeliveryIpc(deps: DeliveryIpcDependencies): void {
  const { handle, store, git } = deps;
  const previews = new Map<string, DeliveryPreview>();
  const confirmations = new Map<string, { record: JiraWritebackRecord; scope: string; issueHash: string; expires: number; comment?: string; package?: DeliveryPackageRecord }>();
  const busyExports = new Set<string>();
  function safeReason(error: unknown): string { const message = reason(error).slice(0, 2000); try { deps.assertCleanText(message); return message; } catch { return '操作失败，敏感错误明细已隐藏'; } }
  function previewById(value: unknown): DeliveryPreview {
    const preview = previews.get(z.string().uuid().parse(value));
    if (!preview || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('交付预览已失效，请重新采集证据');
    deps.project(preview.snapshot.project.id);
    return preview;
  }
  function saveResult(record: JiraWritebackRecord, resultStatus: JiraWritebackRecord['resultStatus'], extra: Partial<JiraWritebackRecord> = {}) {
    const result = { ...record, ...extra, resultStatus }; store.saveJiraWritebackRecord(result); return result;
  }
  handle('delivery:preview', async (value: unknown): Promise<DeliveryPreview> => {
    const input = requestSchema.parse(value) as DeliveryRequest;
    const project = deps.project(input.projectId);
    const session = input.sessionId ? store.listSessions().find(item => item.id === input.sessionId) : undefined;
    if (input.sessionId && (!session || session.projectId !== project.id)) throw new Error('所选会话不属于当前项目');
    const taskId = input.taskId ?? session?.id ?? project.id;
    let tasks = store.listAgentTasks(input.sessionId).filter(task => task.projectId === project.id || (session && task.sessionId === session.id));
    if (input.taskId) { tasks = tasks.filter(task => task.id === input.taskId); if (!tasks.length && !store.listTaskPlans(input.taskId).some(plan => plan.projectId === project.id)) throw new Error('所选任务不属于当前项目或没有可追溯记录'); }
    if (tasks.length > 200) throw new Error('项目任务超过 200 项，请选择具体会话或任务再生成交付档案');
    const workspacePath = (input.taskId && tasks[0]?.workspacePath) || session?.workspacePath || project.path;
    tasks = tasks.map(({ input: _input, workspacePath: _workspacePath, ...task }) => task);
    const plans = store.listTaskPlans(taskId).filter(plan => plan.projectId === project.id).map(plan => ({ plan, steps: store.listTaskPlanSteps(plan.id) }));
    const snapshot: DeliverySnapshot = { schemaVersion: 1, project: { id: project.id, name: project.name }, taskId, ...(session ? { sessionId: session.id } : {}), goal: session?.jiraIssue?.summary ?? plans[0]?.plan.goal ?? tasks[0]?.description ?? session?.title ?? project.name, implementationNotes: input.implementationNotes ?? '', remainingItems: input.remainingItems ?? '', tasks, plans, evidence: tasks.flatMap(task => store.listTaskEvidence(task.sessionId, task.id)), verificationRuns: [], impacts: store.listImpactReports(taskId).filter(item => item.projectId === project.id), reviews: store.listReviewRuns(taskId).filter(item => item.projectId === project.id).map(run => ({ ...run, findings: store.listReviewFindings(run.id) })), capturedAt: new Date().toISOString() };
    const key = input.jiraKey ?? session?.jiraIssue?.key;
    if (key) {
      jiraKey.parse(key);
      try {
        const scope = deps.jiraScope(); const issue = await deps.jira().getIssue(key, key.slice(0, key.lastIndexOf('-'))); deps.assertJiraScope(scope); snapshot.jira = issue; snapshot.goal = issue.summary;
        const prior = store.listDeliveryPackages(taskId).find(item => item.projectId === project.id && item.jiraKey === key && item.status === 'success')?.sourceSnapshot.jira as JiraIssue | undefined;
        if (prior && issueFingerprint(prior) !== issueFingerprint(issue)) snapshot.jiraWarning = `源需求已更新：历史版本 ${prior.updated ?? '未知'} → 当前 ${issue.updated ?? '未知'}；标题 ${prior.summary} → ${issue.summary}；状态 ${prior.status} → ${issue.status}。本次使用重新抓取的快照。`;
      }
      catch (error) { if (session?.jiraIssue?.key === key) snapshot.jira = session.jiraIssue; snapshot.jiraWarning = `Jira 未能实时刷新${snapshot.jira ? '，使用会话历史快照' : ''}：${safeReason(error)}`; }
    }
    try {
      const state = await git.projectState({ ...project, path: workspacePath });
      const headSha = state.commits[0]?.hash;
      if (!headSha) throw new Error('仓库没有可读取的 HEAD 提交');
      const changes = await git.changesSince(workspacePath, headSha);
      snapshot.git = { workspacePath, branch: state.branch, headSha, diffFingerprint: changes.fingerprint, files: changes.changes.map(file => ({ path: file.path, status: file.status, layer: file.layer })), truncated: changes.truncated };
      snapshot.impacts = snapshot.impacts.map(report => report.diffFingerprint && report.diffFingerprint !== changes.fingerprint ? { ...report, status: 'stale' } : report);
      snapshot.reviews = snapshot.reviews.map(run => run.diffFingerprint !== changes.fingerprint ? { ...run, status: 'stale' } : run);
    } catch (error) { snapshot.gitWarning = safeReason(error); }
    if (deps.verificationRuns) {
      try { snapshot.verificationRuns = (await deps.verificationRuns(project.id, session?.id)).filter(run => run.projectId === project.id && (!session || run.sessionId === session.id)); }
      catch (error) { snapshot.remainingItems += `\n验证历史读取失败：${safeReason(error)}`; }
    }
    deps.assertCleanText(JSON.stringify(snapshot));
    const revision = nextDeliveryRevision(store.listDeliveryPackages(taskId), taskId);
    const preview: DeliveryPreview = { id: randomUUID(), revision, snapshot, markdown: renderDeliverySummary(snapshot, revision), expiresAt: new Date(Date.now() + MAX_AGE_MS).toISOString() };
    for (const [key, entry] of previews) if (Date.parse(entry.expiresAt) < Date.now()) previews.delete(key);
    if (previews.size >= 30) previews.delete(previews.keys().next().value!);
    previews.set(preview.id, preview); return preview;
  });
  handle('delivery:export', async (value: unknown): Promise<DeliveryPackageRecord | null> => {
    const preview = previewById(value);
    if (busyExports.has(preview.snapshot.taskId)) throw new Error('此任务正在生成交付包，请等待');
    busyExports.add(preview.snapshot.taskId);
    try {
      const revision = nextDeliveryRevision(store.listDeliveryPackages(preview.snapshot.taskId), preview.snapshot.taskId);
      const name = `DeliveryPackage_${preview.snapshot.jira?.key ?? preview.snapshot.project.id}_${preview.snapshot.capturedAt.slice(0, 10)}_r${revision}_${randomUUID().slice(0, 8)}.zip`;
      const target = await deps.selectOutput(name);
      if (!target) return null;
      if (path.extname(target).toLowerCase() !== '.zip') throw new Error('交付包必须保存为 ZIP 文件');
      if (preview.snapshot.git) {
        const project = deps.project(preview.snapshot.project.id);
        const state = await git.projectState({ ...project, path: preview.snapshot.git.workspacePath });
        const head = state.commits[0]?.hash;
        if (state.branch !== preview.snapshot.git.branch || head !== preview.snapshot.git.headSha || (await git.changesSince(preview.snapshot.git.workspacePath, head)).fingerprint !== preview.snapshot.git.diffFingerprint) throw new Error('Git 变更已更新，请重新采集证据后生成交付包');
      }
      const built = buildDeliveryPackage(preview.snapshot, { revision });
      deps.assertCleanText(built.markdown);
      const record: DeliveryPackageRecord = { id: randomUUID(), taskId: preview.snapshot.taskId, projectId: preview.snapshot.project.id, ...(preview.snapshot.jira ? { jiraKey: preview.snapshot.jira.key } : {}), revision, sourceSnapshot: JSON.parse(JSON.stringify(preview.snapshot)), outputPath: target, outputSha256: built.sha256, status: 'building', createdAt: new Date().toISOString() };
      store.saveDeliveryPackage(record);
      try { await writeFile(target, built.bytes, { flag: 'wx' }); record.status = 'success'; store.saveDeliveryPackage(record); return record; }
      catch (error) { record.status = 'failed'; store.saveDeliveryPackage(record); throw new Error(`交付包生成失败，历史记录已保留：${safeReason(error)}`); }
    } finally { busyExports.delete(preview.snapshot.taskId); }
  });
  handle('delivery:history', (value: unknown) => { const input = z.object({ projectId, taskId: id.optional() }).strict().parse(value); deps.project(input.projectId); return store.listDeliveryPackages(input.taskId).filter(item => item.projectId === input.projectId); });
  handle('delivery:jira-preview', async (value: unknown): Promise<DeliveryWritebackPreview> => {
    const input = writebackSchema.parse(value);
    const preview = previewById(input.previewId);
    if (!preview.snapshot.jira) throw new Error('请先关联并读取 Jira 任务，再预览回写');
    const key = preview.snapshot.jira.key;
    const scope = deps.jiraScope();
    const issue = await deps.jira().getIssue(key, key.slice(0, key.lastIndexOf('-'))); deps.assertJiraScope(scope);
    if (issueFingerprint(issue) !== issueFingerprint(preview.snapshot.jira)) throw new Error('源需求已更新，请重新采集交付证据后预览回写');
    const actor = store.getJira().account;
    let comment: string | undefined; let deliveryPackage: DeliveryPackageRecord | undefined;
    if (input.operation === 'comment') { comment = input.comment ?? preview.markdown; if (!comment.trim() || comment.length > 30000) throw new Error('评论须为 1 至 30000 字，请编辑后再预览'); deps.assertCleanText(comment); }
    else {
      deliveryPackage = store.listDeliveryPackages(preview.snapshot.taskId).find(item => item.id === input.packageId && item.projectId === preview.snapshot.project.id && item.jiraKey === key && item.status === 'success');
      if (!deliveryPackage) throw new Error('请选择此任务已成功生成的本地交付包');
      const bytes = await readFile(deliveryPackage.outputPath);
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Jira 附件不能超过 8 MiB；本地交付包已保留');
      if (deliveryHash(bytes) !== deliveryPackage.outputSha256) throw new Error('交付包文件已变化，请重新生成交付包');
    }
    const expires = Date.now() + MAX_AGE_MS;
    const body = { previewId: preview.id, projectId: preview.snapshot.project.id, actor, issueId: issue.id, issueUpdated: issue.updated, targetSummary: issue.summary, comment, packageId: deliveryPackage?.id, packageSha256: deliveryPackage?.outputSha256, fileName: deliveryPackage ? path.basename(deliveryPackage.outputPath) : undefined, expiresAt: new Date(expires).toISOString() };
    deps.assertCleanText(JSON.stringify(body));
    const requestHash = deliveryHash(JSON.stringify({ key, operation: input.operation, scope, issueHash: issueFingerprint(issue), body }));
    const record: JiraWritebackRecord = { id: randomUUID(), jiraKey: key, operation: input.operation, preview: body, requestHash, resultStatus: 'pending_confirmation', createdAt: new Date().toISOString() };
    store.saveJiraWritebackRecord(record);
    for (const [key, entry] of confirmations) if (entry.expires < Date.now()) confirmations.delete(key);
    if (confirmations.size >= 30) confirmations.delete(confirmations.keys().next().value!);
    confirmations.set(record.id, { record, scope, issueHash: issueFingerprint(issue), expires, comment, package: deliveryPackage });
    return { record, issue: { key, summary: issue.summary, status: issue.status, updated: issue.updated }, expiresAt: new Date(expires).toISOString() };
  });
  handle('delivery:jira-confirm', async (value: unknown): Promise<JiraWritebackRecord> => {
    const input = z.object({ recordId: z.string().uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/), confirmed: z.literal(true) }).strict().parse(value);
    const confirmation = confirmations.get(input.recordId);
    if (!confirmation || confirmation.record.requestHash !== input.requestHash) throw new Error('回写预览不存在、已使用或内容发生变化，请重新预览');
    confirmations.delete(input.recordId);
    const { record } = confirmation;
    try {
      if (confirmation.expires <= Date.now()) throw new Error('回写预览已过期，请重新预览');
      deps.project(record.preview.projectId);
      deps.assertJiraScope(confirmation.scope);
      const connector = deps.jira();
      const issue = await connector.getIssue(record.jiraKey, record.jiraKey.slice(0, record.jiraKey.lastIndexOf('-'))); deps.assertJiraScope(confirmation.scope);
      if (issueFingerprint(issue) !== confirmation.issueHash) throw new Error('Jira 任务已更新，请刷新预览并再次确认');
      if (store.getJira().account !== record.preview.actor) throw new Error('Jira 执行账号已变化，请重新预览');
      let responseId: string;
      if (record.operation === 'comment') { deps.assertCleanText(confirmation.comment!); deps.assertJiraScope(confirmation.scope); responseId = (await connector.addComment(record.jiraKey, confirmation.comment!)).id; }
      else {
        const deliveryPackage = confirmation.package!;
        const bytes = await readFile(deliveryPackage.outputPath);
        if (deliveryHash(bytes) !== deliveryPackage.outputSha256) throw new Error('交付包在预览后发生变化，未上传');
        deps.assertJiraScope(confirmation.scope);
        responseId = (await connector.uploadAttachment(record.jiraKey, path.basename(deliveryPackage.outputPath), bytes, 'application/zip')).id;
      }
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(responseId)) throw new Error('Jira 回执 ID 无法校验，请在 Jira 核对操作结果后再重试');
      deps.assertCleanText(responseId);
      return saveResult(record, 'success', { responseId });
    } catch (error) { const message = safeReason(error); return saveResult(record, 'failed', { errorMessage: `${message}；本地交付包保留。若请求可能已送达，请先核对 Jira 后再重试。` }); }
  });
  handle('delivery:jira-cancel', (value: unknown) => { const recordId = z.string().uuid().parse(value); const pending = confirmations.get(recordId); if (!pending) throw new Error('回写预览不存在或已使用'); confirmations.delete(recordId); return saveResult(pending.record, 'cancelled'); });
  handle('delivery:jira-history', (value: unknown) => store.listJiraWritebackRecords(jiraKey.parse(value)));
}

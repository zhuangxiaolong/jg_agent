import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DeliveryActivity, DeliveryDocument, DeliveryDocumentCategory, DeliveryIssue, DeliveryIssueInput, DeliveryMeeting, DeliveryMeetingInput, DeliveryMilestone, DeliveryMilestoneInput, DeliveryProject, DeliveryProjectInput, DeliveryProjectBundle, DeliveryReport, DeliveryReportInput, DeliveryTask, DeliveryTaskBatchInput, DeliveryTaskInput } from '../../../../packages/domain/src/delivery-workbench';
import { deliveryHealth, deliveryOverview, deliveryReportMarkdown } from '../../../../packages/delivery-workbench/src';
import type { LocalStore } from '../../../../packages/storage/src';

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '日期无效');
const idSchema = z.string().uuid();
const prioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
const projectInputSchema = z.object({
  id: idSchema.optional(), code: z.string().trim().max(32).optional(), name: z.string().trim().min(1).max(120),
  customerName: z.string().trim().min(1).max(120), systemType: z.enum(['MES5', 'MES6', 'WMS', 'OTHER']),
  productVersions: z.array(z.string().trim().min(1).max(80)).max(20), stage: z.string().trim().min(1).max(80),
  status: z.enum(['active', 'on_hold', 'completed']), projectManager: z.string().trim().max(80).optional(),
  members: z.array(z.string().trim().min(1).max(80)).max(100), plannedStartDate: daySchema.optional(),
  plannedEndDate: daySchema.optional(), description: z.string().max(8000).optional(),
  jiraKey: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,15}-[1-9]\d{0,8}$/).optional(), linkedCodeProjectId: idSchema.optional(),
}).strict();
const milestoneInputSchema = z.object({
  id: idSchema.optional(), name: z.string().trim().min(1).max(160), description: z.string().max(4000).optional(),
  sortOrder: z.number().int().min(0).max(100000), plannedDate: daySchema.optional(), actualDate: daySchema.optional(),
  owner: z.string().trim().max(80).optional(), status: z.enum(['not_started', 'in_progress', 'completed', 'blocked', 'cancelled']),
}).strict();
const taskInputSchema = z.object({
  id: idSchema.optional(), milestoneId: idSchema.optional(), title: z.string().trim().min(1).max(200),
  description: z.string().max(8000).optional(), owner: z.string().trim().max(80).optional(), priority: prioritySchema,
  status: z.enum(['todo', 'in_progress', 'blocked', 'completed', 'cancelled']), startDate: daySchema.optional(),
  dueDate: daySchema.optional(), completedAt: z.string().datetime().optional(), completionNote: z.string().max(4000).optional(),
  linkedIssueIds: z.array(idSchema).max(100), linkedMeetingIds: z.array(idSchema).max(100),
}).strict();
const taskBatchInputSchema = z.array(z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(8000).optional(),
  owner: z.string().trim().max(80).optional(), priority: prioritySchema,
  startDate: daySchema.optional(), dueDate: daySchema.optional(), milestoneId: idSchema.optional(),
}).strict()).min(1).max(100);
const issueInputSchema = z.object({
  id: idSchema.optional(), title: z.string().trim().min(1).max(200), description: z.string().max(8000).optional(),
  type: z.enum(['issue', 'blocker', 'risk', 'question', 'change']), priority: prioritySchema,
  status: z.enum(['open', 'in_progress', 'pending_customer', 'resolved', 'closed']), owner: z.string().trim().max(80).optional(),
  discoveredAt: z.string().datetime(), dueDate: daySchema.optional(), mitigation: z.string().max(4000).optional(),
  resolution: z.string().max(4000).optional(), linkedTaskIds: z.array(idSchema).max(100), linkedMilestoneId: idSchema.optional(),
  linkedMeetingIds: z.array(idSchema).max(100), sourceRefs: z.array(z.object({ kind: z.enum(['document', 'meeting', 'jira', 'manual']), id: idSchema.optional(), label: z.string().trim().min(1).max(200) }).strict()).max(50),
}).strict();
const meetingInputSchema = z.object({
  id: idSchema.optional(), title: z.string().trim().min(1).max(200), meetingAt: z.string().datetime(),
  meetingType: z.enum(['internal', 'customer', 'onsite', 'remote', 'other']), attendees: z.array(z.string().trim().min(1).max(80)).max(100),
  minutes: z.string().max(30000), linkedTaskIds: z.array(idSchema).max(100), linkedIssueIds: z.array(idSchema).max(100), linkedMilestoneId: idSchema.optional(),
}).strict();
const reportInputSchema = z.object({
  id: idSchema.optional(), reportType: z.enum(['weekly', 'risk', 'plan', 'meeting_summary', 'other']),
  title: z.string().trim().min(1).max(160), periodStart: daySchema.optional(), periodEnd: daySchema.optional(),
  markdown: z.string().max(30000), status: z.enum(['draft', 'final']), sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const projectIdSchema = idSchema;
const documentActionSchema = z.object({ projectId: projectIdSchema, id: idSchema, reveal: z.boolean().optional() }).strict();

interface IpcOptions {
  handle(channel: string, fn: (...args: any[]) => any): void;
  store: LocalStore;
  dataRoot: string;
  selectFile(title: string, extensions: string[]): Promise<string | undefined>;
  selectSave(name: string, extensions: string[]): Promise<string | undefined>;
  openPath(file: string): Promise<string>;
  revealPath(file: string): void;
}

export function registerDeliveryWorkbenchIpc(options: IpcOptions): void {
  const { handle, store } = options;
  handle('delivery-workbench:overview', () => {
    const bundles = store.listDeliveryProjects(true).map(project => bundleFor(project));
    return deliveryOverview(bundles, store.listRecentDeliveryActivities(100));
  });
  handle('delivery-workbench:projects', (value?: unknown) => store.listDeliveryProjects(value === undefined ? false : z.boolean().parse(value)));
  handle('delivery-workbench:code-projects', () => store.listProjects().map(item => ({ id: item.id, name: item.name })));
  handle('delivery-workbench:project-create', (value: unknown) => {
    const input = projectInputSchema.parse(value);
    validateProjectDates(input);
    validateCodeProject(input.linkedCodeProjectId);
    const now = new Date().toISOString();
    const project: DeliveryProject = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
    store.saveDeliveryProject(project, activity(project.id, 'project', project.id, 'created', `创建交付项目“${project.name}”`));
    return project;
  });
  handle('delivery-workbench:project-update', (idValue: unknown, inputValue: unknown) => {
    const id = idSchema.parse(idValue);
    const existing = requireProject(id);
    if (existing.status === 'archived') throw new Error('已归档项目不能编辑');
    const input = projectInputSchema.parse({ ...(inputValue as object), id });
    validateProjectDates(input);
    validateCodeProject(input.linkedCodeProjectId);
    const project: DeliveryProject = { ...existing, ...input, updatedAt: new Date().toISOString() };
    store.saveDeliveryProject(project, activity(id, 'project', id, 'updated', `更新交付项目“${project.name}”`));
    return project;
  });
  handle('delivery-workbench:project-archive', (value: unknown) => {
    const existing = requireProject(idSchema.parse(value));
    if (existing.status === 'archived') return existing;
    const now = new Date().toISOString();
    const project: DeliveryProject = { ...existing, status: 'archived', archivedAt: now, updatedAt: now };
    store.saveDeliveryProject(project, activity(project.id, 'project', project.id, 'archived', `归档交付项目“${project.name}”`));
    return project;
  });
  handle('delivery-workbench:project', (value: unknown) => {
    const id = idSchema.parse(value);
    const project = store.getDeliveryProject(id);
    return project ? bundleFor(project) : null;
  });
  registerRecordHandlers();
  registerDocumentHandlers();
  registerReportHandlers();

  function requireProject(id: string, writable = false): DeliveryProject {
    const project = store.getDeliveryProject(id);
    if (!project) throw new Error('交付项目不存在');
    if (writable && project.status === 'archived') throw new Error('已归档项目不能修改');
    return project;
  }
  function validateCodeProject(id?: string): void {
    if (id && !store.listProjects().some(item => item.id === id)) throw new Error('关联的本地代码项目不存在');
  }
  function bundleFor(project: DeliveryProject): DeliveryProjectBundle {
    const milestones = store.listDeliveryRecords<DeliveryMilestone>('delivery_milestones', project.id).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
    const tasks = store.listDeliveryRecords<DeliveryTask>('delivery_tasks', project.id);
    const issues = store.listDeliveryRecords<DeliveryIssue>('delivery_issues', project.id);
    const meetings = store.listDeliveryRecords<DeliveryMeeting>('delivery_meetings', project.id);
    const documents = store.listDeliveryRecords<DeliveryDocument>('delivery_documents', project.id);
    const reports = store.listDeliveryRecords<DeliveryReport>('delivery_reports', project.id);
    const result = deliveryHealth({ project, milestones, tasks, issues });
    return { project, milestones, tasks, issues, meetings, documents, reports, activities: store.listDeliveryActivities(project.id, 100), health: result.health, healthReasons: result.reasons };
  }
  function validateProjectDates(input: DeliveryProjectInput): void {
    if (input.plannedStartDate && input.plannedEndDate && input.plannedStartDate > input.plannedEndDate) throw new Error('计划结束日期不能早于开始日期');
  }
  function validateReferences(projectId: string, values: Array<{ table: string; ids: string[] }>): void {
    for (const entry of values) {
      if (entry.ids.some(id => !store.listDeliveryRecords<{ id: string }>(entry.table as any, projectId).some(item => item.id === id))) throw new Error('关联记录不存在或不属于当前交付项目');
    }
  }
  function ensureSameProject<T extends { id: string; deliveryProjectId: string }>(table: any, projectId: string, id: string): T | undefined {
    return store.listDeliveryRecords<T>(table, projectId).find(item => item.id === id);
  }
  function activity(projectId: string, entityType: DeliveryActivity['entityType'], entityId: string, action: DeliveryActivity['action'], summary: string): DeliveryActivity {
    return { id: randomUUID(), deliveryProjectId: projectId, entityType, entityId, action, summary: summary.slice(0, 300), actor: '本机用户', createdAt: new Date().toISOString() };
  }
  function saveRecord<T extends DeliveryMilestone | DeliveryTask | DeliveryIssue | DeliveryMeeting>(table: any, projectId: string, input: any, entityType: DeliveryActivity['entityType'], label: string): T {
    const project = requireProject(projectId, true);
    const current = input.id ? ensureSameProject<T>(table, project.id, input.id) : undefined;
    if (input.id && !current) throw new Error('记录不存在或不属于当前交付项目');
    const now = new Date().toISOString();
    const value = { ...input, id: current?.id ?? randomUUID(), deliveryProjectId: project.id, createdAt: current?.createdAt ?? now, updatedAt: now } as T;
    const currentStatus = (current as { status?: string } | undefined)?.status;
    const nextStatus = (value as { status?: string }).status;
    const action = currentStatus && nextStatus !== currentStatus ? 'status_changed' : current ? 'updated' : 'created';
    store.saveDeliveryRecord(table, value, activity(project.id, entityType, value.id, action, `${current ? '更新' : '新增'}${label}“${input.title ?? input.name}”`));
    return value;
  }
  function registerRecordHandlers(): void {
    handle('delivery-workbench:milestone-save', (projectValue: unknown, value: unknown) => {
      const projectId = idSchema.parse(projectValue);
      const input = milestoneInputSchema.parse(value) as DeliveryMilestoneInput;
      if (input.status === 'completed' && !input.actualDate) input.actualDate = localDay();
      return saveRecord<DeliveryMilestone>('delivery_milestones', projectId, input, 'milestone', '里程碑');
    });
    handle('delivery-workbench:milestone-delete', (projectValue: unknown, idValue: unknown) => deleteRecord('delivery_milestones', 'milestone', idSchema.parse(projectValue), idSchema.parse(idValue), '里程碑'));
    handle('delivery-workbench:task-save', (projectValue: unknown, value: unknown) => {
      const projectId = idSchema.parse(projectValue); const input = taskInputSchema.parse(value) as DeliveryTaskInput;
      if (input.milestoneId && !ensureSameProject('delivery_milestones', projectId, input.milestoneId)) throw new Error('里程碑不存在或不属于当前交付项目');
      validateReferences(projectId, [{ table: 'delivery_issues', ids: input.linkedIssueIds }, { table: 'delivery_meetings', ids: input.linkedMeetingIds }]);
      if (input.status === 'completed' && !input.completedAt) input.completedAt = new Date().toISOString();
      if (input.status !== 'completed') input.completedAt = undefined;
      return saveRecord<DeliveryTask>('delivery_tasks', projectId, input, 'task', '任务');
    });
    handle('delivery-workbench:tasks-batch-save', (projectValue: unknown, value: unknown) => {
      const projectId = idSchema.parse(projectValue); const project = requireProject(projectId, true);
      const inputs = taskBatchInputSchema.parse(value) as DeliveryTaskBatchInput[];
      if (inputs.some(input => input.milestoneId && !ensureSameProject('delivery_milestones', projectId, input.milestoneId))) throw new Error('里程碑不存在或不属于当前交付项目');
      const now = new Date().toISOString();
      const tasks = inputs.map(input => ({
        ...input, id: randomUUID(), deliveryProjectId: project.id, status: 'todo' as const,
        linkedIssueIds: [], linkedMeetingIds: [], createdAt: now, updatedAt: now,
      }));
      const activities = tasks.map(task => activity(project.id, 'task', task.id, 'created', `批量新增任务“${task.title}”`));
      store.saveDeliveryTasks(tasks, activities);
      return tasks;
    });
    handle('delivery-workbench:task-delete', (projectValue: unknown, idValue: unknown) => deleteRecord('delivery_tasks', 'task', idSchema.parse(projectValue), idSchema.parse(idValue), '任务'));
    handle('delivery-workbench:issue-save', (projectValue: unknown, value: unknown) => {
      const projectId = idSchema.parse(projectValue); const input = issueInputSchema.parse(value) as DeliveryIssueInput;
      if (input.linkedMilestoneId && !ensureSameProject('delivery_milestones', projectId, input.linkedMilestoneId)) throw new Error('里程碑不存在或不属于当前交付项目');
      validateReferences(projectId, [{ table: 'delivery_tasks', ids: input.linkedTaskIds }, { table: 'delivery_meetings', ids: input.linkedMeetingIds }]);
      if ((input.status === 'resolved' || input.status === 'closed') && !input.resolution?.trim()) throw new Error('已解决或已关闭的问题必须填写解决说明');
      return saveRecord<DeliveryIssue>('delivery_issues', projectId, input, 'issue', '问题/风险');
    });
    handle('delivery-workbench:issue-delete', (projectValue: unknown, idValue: unknown) => {
      const projectId = idSchema.parse(projectValue), issueId = idSchema.parse(idValue);
      if (store.findDiagnosticCaseByDeliveryIssue(projectId, issueId)) throw new Error('该问题已关联现场诊断，请先在诊断档案中解除关联');
      return deleteRecord('delivery_issues', 'issue', projectId, issueId, '问题/风险');
    });
    handle('delivery-workbench:meeting-save', (projectValue: unknown, value: unknown) => {
      const projectId = idSchema.parse(projectValue); const input = meetingInputSchema.parse(value) as DeliveryMeetingInput;
      if (input.linkedMilestoneId && !ensureSameProject('delivery_milestones', projectId, input.linkedMilestoneId)) throw new Error('里程碑不存在或不属于当前交付项目');
      validateReferences(projectId, [{ table: 'delivery_tasks', ids: input.linkedTaskIds }, { table: 'delivery_issues', ids: input.linkedIssueIds }]);
      return saveRecord<DeliveryMeeting>('delivery_meetings', projectId, input, 'meeting', '会议');
    });
    handle('delivery-workbench:meeting-delete', (projectValue: unknown, idValue: unknown) => deleteRecord('delivery_meetings', 'meeting', idSchema.parse(projectValue), idSchema.parse(idValue), '会议记录'));
  }
  function deleteRecord(table: any, type: DeliveryActivity['entityType'], projectId: string, id: string, label: string): void {
    requireProject(projectId, true);
    const current = ensureSameProject<{ id: string; deliveryProjectId: string; title?: string; name?: string }>(table, projectId, id);
    if (!current) throw new Error('记录不存在或不属于当前交付项目');
    store.deleteDeliveryRecord(table, projectId, id, activity(projectId, type, id, 'deleted', `删除${label}“${current.title ?? current.name}”`));
  }
  function registerDocumentHandlers(): void {
    handle('delivery-workbench:document-import', async (projectValue: unknown, categoryValue: unknown) => {
      const projectId = idSchema.parse(projectValue); requireProject(projectId, true);
      const category = z.enum(['contract', 'handover', 'requirement', 'blueprint', 'test', 'go_live', 'acceptance', 'manual', 'other']).parse(categoryValue);
      const source = await options.selectFile('导入交付项目资料', ['*']);
      if (!source) return null;
      const document = await importFile(projectId, category, source);
      const log = activity(projectId, 'document', document.id, 'imported', `导入项目资料“${document.fileName}”`);
      try { store.saveDeliveryRecord('delivery_documents', document, log); }
      catch (error) { await unlink(path.join(managedRoot(), document.relativePath)).catch(() => undefined); throw error; }
      return document;
    });
    handle('delivery-workbench:document-detach', (projectValue: unknown, idValue: unknown) => {
      const projectId = idSchema.parse(projectValue); requireProject(projectId, true); const id = idSchema.parse(idValue);
      const current = ensureSameProject<DeliveryDocument>('delivery_documents', projectId, id);
      if (!current) throw new Error('项目资料不存在或不属于当前项目');
      store.deleteDeliveryRecord('delivery_documents', projectId, id, activity(projectId, 'document', id, 'detached', `解除项目资料关联“${current.fileName}”`));
    });
    handle('delivery-workbench:document-open', async (value: unknown) => {
      const input = documentActionSchema.parse(value); requireProject(input.projectId);
      const document = ensureSameProject<DeliveryDocument>('delivery_documents', input.projectId, input.id);
      if (!document) throw new Error('项目资料不存在或不属于当前项目');
      const filename = await verifiedDocumentPath(document);
      if (input.reveal) options.revealPath(filename);
      else {
        const error = await options.openPath(filename);
        if (error) throw new Error(error);
      }
    });
  }
  function registerReportHandlers(): void {
    handle('delivery-workbench:report-save', (projectValue: unknown, value: unknown) => {
      const projectId = idSchema.parse(projectValue); requireProject(projectId, true);
      const input = reportInputSchema.parse(value) as DeliveryReportInput;
      if (input.periodStart && input.periodEnd && input.periodStart > input.periodEnd) throw new Error('报告周期结束日期不能早于开始日期');
      const existing = input.id ? ensureSameProject<DeliveryReport>('delivery_reports', projectId, input.id) : undefined;
      if (input.id && !existing) throw new Error('报告不存在或不属于当前交付项目');
      const now = new Date().toISOString();
      const report: DeliveryReport = { ...(existing ?? {} as DeliveryReport), ...input, id: existing?.id ?? randomUUID(), deliveryProjectId: projectId, createdAt: existing?.createdAt ?? now, updatedAt: now };
      store.saveDeliveryRecord('delivery_reports', report, activity(projectId, 'report', report.id, existing ? 'updated' : 'created', `${existing ? '更新' : '保存'}报告“${report.title}”`));
      return report;
    });
    handle('delivery-workbench:report-build', (projectValue: unknown, inputValue: unknown) => {
      const projectId = idSchema.parse(projectValue); const input = z.object({ reportType: z.enum(['weekly', 'risk']), periodStart: daySchema.optional(), periodEnd: daySchema.optional() }).strict().parse(inputValue);
      if (input.periodStart && input.periodEnd && input.periodStart > input.periodEnd) throw new Error('报告周期结束日期不能早于开始日期');
      const project = requireProject(projectId, true);
      const bundle = bundleFor(project);
      const sourceSnapshotHash = createHash('sha256').update(JSON.stringify({ project: bundle.project, milestones: bundle.milestones, tasks: bundle.tasks, issues: bundle.issues, meetings: bundle.meetings })).digest('hex');
      const now = new Date().toISOString();
      const report: DeliveryReport = { id: randomUUID(), deliveryProjectId: projectId, reportType: input.reportType, title: input.reportType === 'weekly' ? '项目周报数据草稿' : '项目风险巡检数据草稿', periodStart: input.periodStart, periodEnd: input.periodEnd, markdown: deliveryReportMarkdown(bundle, input.reportType, sourceSnapshotHash, input.periodStart, input.periodEnd), status: 'draft', sourceSnapshotHash, generatedAt: now, createdAt: now, updatedAt: now };
      store.saveDeliveryRecord('delivery_reports', report, activity(projectId, 'report', report.id, 'created', `生成报告草稿“${report.title}”`));
      return report;
    });
    handle('delivery-workbench:report-export', async (projectValue: unknown, idValue: unknown) => {
      const projectId = idSchema.parse(projectValue); const report = ensureSameProject<DeliveryReport>('delivery_reports', projectId, idSchema.parse(idValue));
      if (!report) throw new Error('报告不存在或不属于当前交付项目');
      const filename = await options.selectSave(`${safeFilename(report.title)}.md`, ['md']);
      if (!filename) return null;
      await writeFile(filename, report.markdown, { encoding: 'utf8', flag: 'wx' }).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await writeFile(filename, report.markdown, 'utf8');
      });
      store.recordDeliveryActivity(activity(projectId, 'report', report.id, 'exported', `导出报告“${report.title}”`));
      return filename;
    });
  }

  function managedRoot(): string { return path.join(options.dataRoot, 'delivery-workbench'); }
  async function importFile(projectId: string, category: DeliveryDocumentCategory, source: string): Promise<DeliveryDocument> {
    const original = await lstat(source);
    if (!original.isFile() || original.isSymbolicLink()) throw new Error('仅支持普通文件，不能导入符号链接');
    if (original.size > 50 * 1024 * 1024) throw new Error('单个项目资料不能超过 50 MiB');
    const canonical = await realpath(source);
    const handle = await open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let destination: string | undefined;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 50 * 1024 * 1024 || before.dev !== original.dev || before.ino !== original.ino || before.nlink !== 1) throw new Error('所选文件在读取前发生变化或不是普通文件');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) throw new Error('文件在导入期间发生变化，请重新选择');
      const root = managedRoot();
      const projectDir = path.join(root, projectId);
      await mkdir(projectDir, { recursive: true });
      const canonicalRoot = await realpath(root);
      const canonicalProjectDir = await realpath(projectDir);
      if (!inside(canonicalRoot, canonicalProjectDir)) throw new Error('项目资料目录路径越界');
      const extension = path.extname(canonical).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 16);
      const name = `${randomUUID()}${extension}`;
      destination = path.join(canonicalProjectDir, name);
      const destinationHandle = await open(destination, 'wx');
      try { await destinationHandle.writeFile(bytes); await destinationHandle.sync(); } finally { await destinationHandle.close(); }
      const now = new Date().toISOString();
      return { id: randomUUID(), deliveryProjectId: projectId, fileName: path.basename(canonical).slice(0, 255), relativePath: path.join(projectId, name), category, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: mimeForExtension(extension), extractedTextStatus: 'not_extracted', createdAt: now, updatedAt: now };
    } catch (error) {
      if (destination) await unlink(destination).catch(() => undefined);
      throw error;
    } finally { await handle.close(); }
  }
  async function verifiedDocumentPath(document: DeliveryDocument): Promise<string> {
    if (path.isAbsolute(document.relativePath) || document.relativePath.split(/[\\/]/).some(part => part === '..' || part === '')) throw new Error('项目资料相对路径无效');
    const root = managedRoot();
    const canonicalRoot = await realpath(root);
    const candidate = path.resolve(canonicalRoot, document.relativePath);
    if (!inside(canonicalRoot, candidate)) throw new Error('项目资料路径越界');
    const details = await lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) throw new Error('项目资料文件状态异常');
    const actual = await realpath(candidate);
    if (!inside(canonicalRoot, actual) || path.resolve(actual) !== path.resolve(candidate)) throw new Error('项目资料真实路径越界');
    const handle = await open(actual, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== document.sizeBytes) throw new Error('项目资料大小已变化，请重新导入');
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
        store.saveDeliveryRecord('delivery_documents', { ...document, extractedTextStatus: 'stale', updatedAt: new Date().toISOString() }, activity(document.deliveryProjectId, 'document', document.id, 'updated', `项目资料“${document.fileName}”校验失败，已标记过期`));
        throw new Error('项目资料内容已变化，已标记为过期，请重新导入');
      }
      return actual;
    } finally { await handle.close(); }
  }
}

function inside(root: string, value: string): boolean { const relative = path.relative(root, value); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function mimeForExtension(extension: string): string | undefined {
  return ({ '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' } as Record<string, string>)[extension];
}
function safeFilename(value: string): string { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || '交付报告'; }
function localDay(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

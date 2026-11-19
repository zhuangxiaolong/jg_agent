import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Project, FieldMapping, MappingJob, MappingRuleSet, MappingValidationIssue, ProjectWorkspaceContext, ProjectResourceLink, ProjectFact, ProjectDecision } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { alignMappingsToTemplate, buildProjectContext, createMappingRun, exportCsv, exportXlsx, parseSourceData, suggestMappings, validateAndConvert, mappingTransformSchema } from '../../../../packages/second-iteration/src';
import { readDocumentTextFile } from '../../../../packages/knowledge/src';
import { idSchema, projectIdSchema } from './security';

type Dependencies = { handle: (channel: string, fn: (...args: any[]) => any) => void; store: LocalStore; project: (id: unknown) => Project; dataRoot: string; selectFile: (title: string, extensions: string[]) => Promise<string | undefined>; reveal: (path: string) => void; selectSave: (name: string, extensions: string[]) => Promise<string | undefined> };

export async function assembleProjectContext(store: LocalStore, projectId: string, taskId?: string) {
  const workspace = store.getProjectWorkspace(projectId);
  if (!workspace || workspace.status === 'archived') return undefined;
  const resources = store.listProjectResourceLinks(projectId); const resourceTexts: Record<string, string> = {};
  for (const resource of resources.filter(item => item.status === 'active' && item.localPath)) {
    try {
      const document = await readDocumentTextFile(resource.localPath!, { maxCharacters: 80000, maxFileBytes: 8 * 1024 * 1024 });
      if (document.digest !== resource.sourceSha256) { resource.status = 'unavailable'; store.saveProjectResourceLink(resource); continue; }
      resourceTexts[resource.id] = document.content.slice(0, 4000);
    } catch { resource.status = 'unavailable'; store.saveProjectResourceLink(resource); }
  }
  const facts = store.listProjectFacts(projectId);
  const decisions = store.listProjectDecisions(projectId);
  const built = buildProjectContext(workspace, resources, facts, decisions, { taskId, resourceTexts });
  const now = new Date().toISOString();
  const replacedFacts = new Set(facts.filter(item => item.projectId === projectId && item.status === 'confirmed').map(item => item.supersedesFactId).filter((id): id is string => !!id));
  const replacedDecisions = new Set(decisions.filter(item => item.projectId === projectId && item.status === 'confirmed').map(item => item.supersedesDecisionId).filter((id): id is string => !!id));
  const candidates = [
    { id: `project:${projectId}`, sourceType: 'project_resource' as const, sourceId: `workspace:${projectId}`, scope: 'project' as const, projectId, contentHash: createHash('sha256').update(JSON.stringify(workspace)).digest('hex'), updatedAt: workspace.updatedAt, trust: 'user_confirmed' as const, status: 'active' as const, title: workspace.name, text: [workspace.name, workspace.projectCode, workspace.systemType, workspace.productVersions.join(' '), workspace.stage, workspace.description].filter(Boolean).join(' '), systemType: workspace.systemType, reasons: ['当前会话绑定的项目工作区'] },
    ...facts.filter(item => item.projectId === projectId && item.status === 'confirmed' && !replacedFacts.has(item.id) && (!item.validFrom || item.validFrom <= now) && (!item.validTo || item.validTo >= now)).map(item => {
      const text = `事实：${item.title}；${item.content}`;
      return { id: `fact:${item.id}`, sourceType: 'project_fact' as const, sourceId: item.id, scope: 'project' as const, projectId, contentHash: createHash('sha256').update(text).digest('hex'), updatedAt: item.updatedAt, trust: 'user_confirmed' as const, status: 'confirmed' as const, title: item.title, text, systemType: workspace.systemType, reasons: ['已确认且有效的项目事实'] };
    }),
    ...decisions.filter(item => item.projectId === projectId && item.status === 'confirmed' && !replacedDecisions.has(item.id)).map(item => {
      const text = `决策：${item.title}；${item.decision}${item.reason ? `；原因：${item.reason}` : ''}`;
      return { id: `decision:${item.id}`, sourceType: 'project_decision' as const, sourceId: item.id, scope: 'project' as const, projectId, contentHash: createHash('sha256').update(text).digest('hex'), updatedAt: item.updatedAt, trust: 'user_confirmed' as const, status: 'confirmed' as const, title: item.title, text, systemType: workspace.systemType, reasons: ['已确认且未被替代的项目决策'] };
    }),
    ...resources.filter(item => item.projectId === projectId && item.status === 'active' && item.sourceSha256 && resourceTexts[item.id]).map(item => {
      const text = `项目资源：${item.displayName}${item.versionLabel ? `（${item.versionLabel}）` : ''}\n${resourceTexts[item.id]}`;
      return { id: `resource:${item.id}:${item.sourceSha256}`, sourceType: 'project_resource' as const, sourceId: item.id, scope: 'project' as const, projectId, contentHash: item.sourceSha256!, updatedAt: item.linkedAt, trust: 'untrusted_project_data' as const, status: 'active' as const, title: item.displayName, text, systemType: workspace.systemType, reasons: ['当前项目资源，正文已通过 SHA256 校验'] };
    }),
  ];
  return { ...built, candidates };
}

export function registerIterationIpc(deps: Dependencies) {
  const { handle, store, project: iterationProject, dataRoot } = deps;
  const projectContextInputSchema = z.object({ projectCode: z.string().trim().max(100).optional(), name: z.string().trim().min(1).max(160), customerName: z.string().trim().max(160).optional(), systemType: z.enum(['MES5', 'MES6', 'WMS', 'OTHER']), productVersions: z.array(z.string().trim().min(1).max(80)).max(20), stage: z.string().trim().min(1).max(80), owner: z.string().trim().max(120).optional(), description: z.string().max(4000).optional(), status: z.enum(['active', 'archived']) }).strict();
  const projectResourceInputSchema = z.object({ id: idSchema.optional(), resourceType: z.enum(['repository', 'jira_project', 'knowledge_document', 'operation_manual', 'requirement', 'data_template', 'agent_task', 'other']), resourceId: z.string().trim().min(1).max(256), displayName: z.string().trim().min(1).max(240), versionLabel: z.string().trim().max(120).optional(), status: z.enum(['active', 'superseded', 'unavailable', 'archived']), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict();
  const projectFactInputSchema = z.object({ id: idSchema.optional(), title: z.string().trim().min(1).max(240), content: z.string().trim().min(1).max(12000), category: z.string().trim().min(1).max(100), status: z.enum(['proposed', 'confirmed', 'rejected', 'superseded']), sourceRefs: z.array(z.object({ type: z.string().trim().min(1).max(80), id: z.string().trim().min(1).max(256), anchor: z.string().trim().max(240).optional() }).strict()).max(50), confirmedBy: z.string().trim().max(120).optional(), confirmedAt: z.string().datetime().optional(), validFrom: z.string().datetime().optional(), validTo: z.string().datetime().optional(), supersedesFactId: z.string().trim().max(256).optional() }).strict();
  const projectDecisionInputSchema = z.object({ id: idSchema.optional(), title: z.string().trim().min(1).max(240), decision: z.string().trim().min(1).max(12000), reason: z.string().trim().max(4000).optional(), status: z.enum(['proposed', 'confirmed', 'rejected', 'superseded']), decisionMaker: z.string().trim().max(120).optional(), decisionAt: z.string().datetime().optional(), sourceRefs: z.array(z.object({ type: z.string().trim().min(1).max(80), id: z.string().trim().min(1).max(256), anchor: z.string().trim().max(240).optional() }).strict()).max(50), supersedesDecisionId: z.string().trim().max(256).optional() }).strict();
  const mappingSelectionSchema = z.object({ projectId: projectIdSchema.optional(), systemType: z.enum(['MES5', 'MES6', 'WMS']), productVersion: z.string().trim().max(80).optional(), dataType: z.string().trim().min(1).max(120) }).strict();
  const mappingJobView = (job: MappingJob) => { const view = { ...job } as Record<string, unknown>; delete view.sourcePath; delete view.templatePath; if (job.templatePath) view.templateFileName = path.basename(job.templatePath); return view; };
  const mappingJob = (value: unknown) => { const id = idSchema.parse(value); const job = store.listMappingJobs().find(item => item.id === id); if (!job) throw new Error('映射任务不存在'); if(job.projectId) iterationProject(job.projectId); return job; };
  const parseOptions = z.object({ sheetName: z.string().max(200).optional(), headerRow: z.number().int().min(0).max(100000).optional(), dataStartRow: z.number().int().min(1).max(100001).optional() }).strict();
  handle('iteration:mapping-reparse', async (value: unknown) => {
    const input = z.object({jobId:idSchema,kind:z.enum(['source','template']),options:parseOptions}).strict().parse(value); const job = mappingJob(input.jobId);
    const file = input.kind === 'source' ? job.sourcePath : job.templatePath; if (!file) throw new Error('请先选择文件');
    const parsed = parseSourceData(file, await readFile(file), input.options);
    if (parsed.preview.digest !== (input.kind === 'source' ? job.sourceSha256 : job.templateSha256)) throw new Error('文件内容已改变，请重新选择文件创建新快照');
    const updated = {...job,[input.kind === 'source' ? 'sourceOptions' : 'templateOptions']:input.options,mappingRuleSetId:undefined,status:'mapping' as const,updatedAt:new Date().toISOString()}; store.saveMappingJob(updated);
    return parsed.preview;
  });
  handle('iteration:mapping-history', (value:unknown) => { const project = iterationProject(value); return store.listMappingJobs(project.id).map(job => ({job:mappingJobView(job),runs:store.listMappingRuns(job.id)})); });
  handle('iteration:mapping-reuse', async (value:unknown) => {
    const input=z.object({jobId:idSchema,ruleJobId:idSchema}).strict().parse(value);const job=mappingJob(input.jobId);const previous=mappingJob(input.ruleJobId);
    if(job.projectId!==previous.projectId||job.systemType!==previous.systemType||job.dataType!==previous.dataType||!job.templateSha256||job.templateSha256!==previous.templateSha256) throw new Error('只允许复用本项目同系统、同资料类型、同模板指纹的规则');
    const rules=previous.mappingRuleSetId?store.getMappingRuleSet(previous.mappingRuleSetId):undefined;if(!rules||rules.status!=='confirmed') throw new Error('历史规则尚未确认');
    const source=parseSourceData(job.sourcePath,await readFile(job.sourcePath),job.sourceOptions);
    if(source.preview.digest!==job.sourceSha256)throw new Error('源文件已变化，请重新选择');
    return (JSON.parse(rules.rulesJson) as FieldMapping[]).map(item=>{const candidates=source.preview.columns.filter(column=>column.label===item.sourceColumnLabel);const column=candidates.length===1?candidates[0]:undefined;return {...item,id:randomUUID(),ruleSetId:'draft',sourceColumnKey:column?.key??'',sourceColumnLabel:column?.label??'',status:column?'suggested':'unmapped',rationale:'本项目历史规则副本，需再次确认源列与业务差异'};});
  });
  handle('iteration:mapping-restore', async (value:unknown) => {
    const job = mappingJob(value); const source = parseSourceData(job.sourcePath,await readFile(job.sourcePath),job.sourceOptions); const template = job.templatePath ? parseSourceData(job.templatePath,await readFile(job.templatePath),job.templateOptions) : undefined;
    if(source.preview.digest !== job.sourceSha256 || (template && template.preview.digest !== job.templateSha256)) throw new Error('源文件或模板已变化，请创建新的转换任务');
    const rules = job.mappingRuleSetId ? store.getMappingRuleSet(job.mappingRuleSetId) : undefined;
    return {job:mappingJobView(job),source:source.preview,template:template?.preview,mappings:rules?JSON.parse(rules.rulesJson):[]};
  });
  handle('iteration:mapping-reveal', (value:unknown) => { const runId=idSchema.parse(value); const run=store.listMappingRuns().find(item=>item.id===runId); if(!run) throw new Error('转换记录不存在'); const file=run.outputPath??run.reportPath; if(!file || !path.resolve(file).startsWith(path.resolve(dataRoot,'iteration')+path.sep)) throw new Error('没有可打开的受管结果'); deps.reveal(file); });
  handle('iteration:project-context-get', (value: unknown) => { const project = iterationProject(value); return { workspace: store.getProjectWorkspace(project.id), resources: store.listProjectResourceLinks(project.id), facts: store.listProjectFacts(project.id), decisions: store.listProjectDecisions(project.id) }; });
  handle('iteration:project-context-save', (projectValue: unknown, inputValue: unknown) => { const project = iterationProject(projectValue); const input = projectContextInputSchema.parse(inputValue); const current = store.getProjectWorkspace(project.id); const now = new Date().toISOString(); const value: ProjectWorkspaceContext = { ...input, id: project.id, createdAt: current?.createdAt ?? now, updatedAt: now }; store.saveProjectWorkspace(value); return value; });
  handle('iteration:project-resource-save', (projectValue: unknown, inputValue: unknown) => { const project = iterationProject(projectValue); const input = projectResourceInputSchema.parse(inputValue); const previous = input.id ? store.listProjectResourceLinks(project.id).find(item => item.id === input.id) : store.listProjectResourceLinks(project.id).find(item => item.resourceId === input.resourceId); if (input.id && !previous) throw new Error('项目资源不存在'); const value: ProjectResourceLink = { ...previous, ...input, id: input.id ?? previous?.id ?? randomUUID(), projectId: project.id, linkedAt: previous?.linkedAt ?? new Date().toISOString() }; store.saveProjectResourceLink(value); return value; });
  handle('iteration:project-fact-save', (projectValue: unknown, inputValue: unknown) => { const project = iterationProject(projectValue); const input = projectFactInputSchema.parse(inputValue); const previous = input.id ? store.listProjectFacts(project.id).find(item => item.id === input.id) : undefined; if (input.id && !previous) throw new Error('项目事实不存在'); const now = new Date().toISOString(); const value: ProjectFact = { ...input, id: input.id ?? randomUUID(), projectId: project.id, createdAt: previous?.createdAt ?? now, updatedAt: now }; store.saveProjectFact(value); return value; });
  handle('iteration:project-decision-save', (projectValue: unknown, inputValue: unknown) => { const project = iterationProject(projectValue); const input = projectDecisionInputSchema.parse(inputValue); const previous = input.id ? store.listProjectDecisions(project.id).find(item => item.id === input.id) : undefined; if (input.id && !previous) throw new Error('项目决策不存在'); const now = new Date().toISOString(); const value: ProjectDecision = { ...input, id: input.id ?? randomUUID(), projectId: project.id, createdAt: previous?.createdAt ?? now, updatedAt: now }; store.saveProjectDecision(value); return value; });
  handle('iteration:project-context-build', async (projectValue: unknown, taskValue?: unknown) => { const project = iterationProject(projectValue); const built = await assembleProjectContext(store, project.id, taskValue === undefined ? undefined : idSchema.parse(taskValue)); if (!built) throw new Error('请先完善并恢复项目上下文'); store.saveProjectContextSnapshot(built.snapshot); return built; });
  handle('iteration:project-resource-select', async (projectValue: unknown) => {
    const project = iterationProject(projectValue); const localPath = await deps.selectFile('关联项目资料（仅本项目使用）', ['md','txt','json','csv','sql','xlsx','docx','pptx','pdf']);
    if (!localPath) return null;
    const snapshot = await readDocumentTextFile(localPath, { maxCharacters: 80000, maxFileBytes: 8 * 1024 * 1024 });
    const value: ProjectResourceLink = { id: randomUUID(), projectId: project.id, resourceId: randomUUID(), displayName: path.basename(localPath), resourceType: 'requirement', status: 'active', sourceSha256: snapshot.digest, localPath, sourceSize: (await stat(localPath)).size, linkedAt: new Date().toISOString() };
    store.saveProjectResourceLink(value); return value;
  });
  handle('iteration:project-config-export', async (projectValue: unknown) => {
    const project = iterationProject(projectValue); const workspace = store.getProjectWorkspace(project.id); if (!workspace) throw new Error('请先保存项目资料');
    const file = await deps.selectSave('项目配置.json', ['json']); if (!file) return null;
    const resources = store.listProjectResourceLinks(project.id).map(({ localPath, ...item }) => ({ ...item, status: 'unavailable' as const }));
    await writeFile(file, JSON.stringify({ schemaVersion: 1, workspace, resources, facts: store.listProjectFacts(project.id), decisions: store.listProjectDecisions(project.id) }, null, 2), { flag: 'wx' }); return file;
  });
  handle('iteration:project-config-import', async (projectValue: unknown) => {
    const project = iterationProject(projectValue); const file = await deps.selectFile('导入项目配置为待确认副本', ['json']); if (!file) return null;
    if ((await stat(file)).size > 1024 * 1024) throw new Error('项目配置超过 1 MiB');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.schemaVersion !== 1) throw new Error('项目配置版本不支持');
    const { id: ignoredId, createdAt, updatedAt, ...workspaceInput } = value.workspace ?? {};
    const workspace = projectContextInputSchema.parse(workspaceInput);
    const facts = z.array(projectFactInputSchema.omit({id:true})).max(500).parse((value.facts ?? []).map(({id,projectId,createdAt,updatedAt,...item}:any) => ({...item,status:'proposed',confirmedAt:undefined,confirmedBy:undefined,supersedesFactId:undefined})));
    const decisions = z.array(projectDecisionInputSchema.omit({id:true})).max(500).parse((value.decisions ?? []).map(({id,projectId,createdAt,updatedAt,...item}:any) => ({...item,status:'proposed',decisionAt:undefined,decisionMaker:undefined,supersedesDecisionId:undefined})));
    const resources = z.array(projectResourceInputSchema.omit({id:true})).max(500).parse((value.resources ?? []).map(({id,projectId,linkedAt,localPath,sourceSize,...item}:any) => ({...item,status:'unavailable'})));
    const now = new Date().toISOString();
    // 安全合并：项目已有基本信息保留，导入断开本机路径，事实和决策均重新确认。
    if (!store.getProjectWorkspace(project.id)) store.saveProjectWorkspace({...workspace,id:project.id,createdAt:now,updatedAt:now});
    for (const item of facts) store.saveProjectFact({...item,id:randomUUID(),projectId:project.id,createdAt:now,updatedAt:now});
    for (const item of decisions) store.saveProjectDecision({...item,id:randomUUID(),projectId:project.id,createdAt:now,updatedAt:now});
    for (const item of resources) store.saveProjectResourceLink({...item,id:randomUUID(),resourceId:randomUUID(),projectId:project.id,linkedAt:now});
    return {facts:facts.length,decisions:decisions.length,resources:resources.length};
  });
  handle('iteration:mapping-source-select', async (inputValue: unknown) => { const input = mappingSelectionSchema.parse(inputValue); if (input.projectId) iterationProject(input.projectId); const sourcePath = await deps.selectFile('选择客户基础资料源文件', ['csv','xlsx']); if (!sourcePath) return null; const parsed = parseSourceData(sourcePath, await readFile(sourcePath)); const now = new Date().toISOString(); const job: MappingJob = { id: randomUUID(), ...(input.projectId ? { projectId: input.projectId } : {}), systemType: input.systemType, ...(input.productVersion ? { productVersion: input.productVersion } : {}), dataType: input.dataType, sourceFileName: path.basename(sourcePath), sourceSha256: parsed.preview.digest, sourcePath, sourceOptions: {}, templateSha256: '', status: 'draft', createdAt: now, updatedAt: now }; store.saveMappingJob(job); return { job: mappingJobView(job), preview: parsed.preview }; });
  handle('iteration:mapping-template-select', async (jobValue: unknown) => { const job = mappingJob(jobValue); const templatePath = await deps.selectFile('选择系统导入模板', ['xlsx','csv']); if (!templatePath) return null; const parsed = parseSourceData(templatePath, await readFile(templatePath)); const updated: MappingJob = { ...job, templatePath, templateOptions: {}, mappingRuleSetId: undefined, templateSha256: parsed.preview.digest, updatedAt: new Date().toISOString(), status: 'mapping' }; store.saveMappingJob(updated); return { job: mappingJobView(updated), preview: parsed.preview }; });
  handle('iteration:mapping-suggest', async (jobValue: unknown) => { const job = mappingJob(jobValue); if (!job.templatePath) throw new Error('请先选择目标导入模板'); const source = parseSourceData(job.sourcePath, await readFile(job.sourcePath), job.sourceOptions); const template = parseSourceData(job.templatePath, await readFile(job.templatePath), job.templateOptions); return suggestMappings(source.preview.columns, template.preview.columns.map(column => column.label), job.mappingRuleSetId ?? 'draft').map((item,index)=>({...item,mapping:{...item.mapping,targetFieldKey:template.preview.columns[index].key}})); });
  handle('iteration:mapping-convert', async (inputValue: unknown) => {
    const input = z.object({ jobId: idSchema, mappings: z.array(z.object({ id: idSchema, ruleSetId: z.string().min(1).max(256), sourceColumnKey: z.string().max(128), sourceColumnLabel: z.string().max(500), targetFieldKey: z.string().min(1).max(256), targetFieldLabel: z.string().max(500), transformDsl: mappingTransformSchema, confidence: z.number().min(0).max(1).optional(), rationale: z.string().max(1000).optional(), status: z.enum(['suggested', 'confirmed', 'rejected', 'unmapped', 'conflict']) }).strict()).max(512), format: z.enum(['csv', 'xlsx']), warningsConfirmed: z.boolean().optional() }).strict().parse(inputValue);
    const job = mappingJob(input.jobId);
    if (!job.templatePath) throw new Error('请先选择目标导入模板');
    const source = parseSourceData(job.sourcePath, await readFile(job.sourcePath), job.sourceOptions);
    const template = parseSourceData(job.templatePath, await readFile(job.templatePath), job.templateOptions);
    if (source.preview.digest !== job.sourceSha256 || template.preview.digest !== job.templateSha256) throw new Error('源文件或模板指纹已改变，请重新选择文件；未使用过期映射导出');
    if (source.preview.uncachedFormulaCount || template.preview.uncachedFormulaCount) throw new Error('源文件或模板中的公式没有缓存值，请先在表格软件中重新计算并另存文件；不能仅确认警告后将公式导出为空值');
    if (!source.rows.length) throw new Error('源数据没有业务行，未生成导入文件');
    const ruleSetId = randomUUID();
    if(source.preview.structureValid===false||template.preview.structureValid===false) throw new Error('文件表头与数据列数不一致，请在工作表设置中重新选择表头并解析');
    const ruleSetVersion = Math.max(0,...store.listMappingRuns(job.id).map(item=>item.ruleSetVersion)) + 1;
    const mappings = alignMappingsToTemplate(template.preview.columns, input.mappings as FieldMapping[], ruleSetId);
    const runId = randomUUID();
    const result = validateAndConvert(source.rows, source.preview.columns, mappings, runId, {sourceRowNumbers:source.sourceRowNumbers,sheetName:source.preview.sheetName});
    const confirmationIssues: MappingValidationIssue[] = mappings.filter(item => item.status !== 'confirmed').map(item => ({ id: randomUUID(), mappingRunId: runId, severity: 'error', ruleId: item.id, sourceColumn: item.sourceColumnKey || undefined, targetField: item.targetFieldKey, message: `目标字段“${item.targetFieldLabel}”的映射尚未人工确认`, blocking: true, status: 'open' }));
    if ((source.preview.warnings?.length || template.preview.warnings?.length) && !input.warningsConfirmed) confirmationIssues.push({id:randomUUID(),mappingRunId:runId,severity:'error',ruleId:'parse-warnings',message:'请核对并确认文件解析警告后再导出',blocking:true,status:'open'});
    const issues = [...result.issues, ...confirmationIssues];
    const errorCount = result.errorCount + confirmationIssues.length;
    const confirmed = mappings.length > 0 && mappings.every(item => item.status === 'confirmed');
    const readyForExport = confirmed && errorCount === 0;
    const now = new Date().toISOString();
    const ruleSet: MappingRuleSet = { id: ruleSetId, ...(job.projectId ? { projectId: job.projectId } : {}), systemType: job.systemType, dataType: job.dataType, templateSha256: job.templateSha256, version: ruleSetVersion, rulesJson: JSON.stringify(mappings), status: readyForExport ? 'confirmed' : 'draft', ...(readyForExport ? { confirmedAt: now } : {}), createdAt: now };
    store.saveMappingRuleSet(ruleSet);
    const run = createMappingRun({ id: runId, jobId: job.id, ruleSetVersion, sourceSha256: source.preview.digest, templateSha256: template.preview.digest, rowCount: source.rows.length, result: { successCount: confirmationIssues.length ? 0 : result.successCount, errorCount, warningCount: result.warningCount } });
    run.status='running';
    store.saveMappingRun(run);
    for (const issue of issues) store.saveMappingValidationIssue(issue);
    const jobStatus = errorCount > 0 ? 'has_errors' : 'ready';
    const updatedJob: MappingJob = { ...job, mappingRuleSetId: ruleSet.id, status: jobStatus, updatedAt: now };
    store.saveMappingJob(updatedJob);
    const headers = template.preview.columns.map(column => column.label);
    const outputDir = path.join(dataRoot, 'iteration', 'mapping-output',runId);
    await mkdir(outputDir, { recursive: true });
    const reportPath=path.join(outputDir,'转换报告.json');
    await writeFile(reportPath, JSON.stringify({run,source:{...source.preview,rows:undefined,columns:source.preview.columns.map(({sampleValues,...column})=>column)},template:{...template.preview,rows:undefined},issues,ruleSet},null,2),{flag:'wx'});
    await writeFile(path.join(outputDir,'错误明细.csv'), '\uFEFF'+exportCsv(['工作表','源行号','源列','目标字段','原始值','转换值','问题说明'],issues.map(item=>[item.sheetName??'',String(item.sourceRow??''),item.sourceColumn??'',item.targetField??'',item.sourceValue??'',item.convertedValue??'',item.message])),{flag:'wx'});
    await writeFile(path.join(outputDir,'映射规则.json'),JSON.stringify(ruleSet,null,2),{flag:'wx'});
    run.reportPath=reportPath;
    if (!readyForExport) { run.status='has_errors';store.saveMappingRun(run);await writeFile(reportPath,JSON.stringify({run,ruleSet,issues},null,2));return { run, headers, preview: result.output.slice(0, 20), issues }; }
    const extension = input.format === 'csv' ? 'csv' : 'xlsx';
    const outputPath = path.join(outputDir, `${job.id}-${run.id}.${extension}`);
    const bytes = input.format === 'csv' ? Buffer.from(exportCsv(headers, result.output), 'utf8') : Buffer.from(exportXlsx(headers, result.output, template.preview.sheetName));
    try { await writeFile(outputPath, bytes,{flag:'wx'}); } catch(error) {store.saveMappingRun({...run,status:'failed'});store.saveMappingJob({...updatedJob,status:'failed'});throw error;}
    const completed = { ...run, status:'passed' as const, outputPath, outputSha256: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(reportPath,JSON.stringify({run:completed,ruleSet,issues},null,2));
    store.saveMappingRun(completed);
    store.saveMappingJob({...updatedJob,status:'exported'});
    return { run: completed, headers, preview: result.output.slice(0, 20), issues, path: outputPath };
  });

}

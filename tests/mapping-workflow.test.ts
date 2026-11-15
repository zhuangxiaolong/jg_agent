import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { FieldMapping, MappingConversionResult, MappingSourcePreview, MappingSuggestion, Project } from '../packages/domain/src';
import { LocalStore } from '../packages/storage/src';
import { exportCsv, exportXlsx, parseCsv, parseSourceBytes } from '../packages/second-iteration/src';
import { registerIterationIpc } from '../apps/desktop/src/main/iteration-ipc';

// 仅使用临时目录、真实 SQLite 和明确合成的客户文件；不调用 Electron、生产导入或网络服务。
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-mapping-workflow-'));
  const database = join(root, 'agent.db');
  const store = await LocalStore.open(database);
  const projects: Project[] = [
    { id: '111111111111111111111111', name: '合成甲项目', path: join(root, 'project-a'), branch: 'fixture' },
    { id: '222222222222222222222222', name: '合成乙项目', path: join(root, 'project-b'), branch: 'fixture' },
  ];
  for (const project of projects) { await mkdir(project.path); store.saveProject(project); }
  const files: Array<string | undefined> = []; const saves: Array<string | undefined> = []; const revealed: string[] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  registerIterationIpc({ handle: (channel, handler) => handlers.set(channel, handler), store, project: value => { const project = projects.find(item => item.id === value); if (!project) throw new Error('合成测试项目不存在'); return project; }, dataRoot: root, selectFile: async () => files.shift(), selectSave: async () => saves.shift(), reveal: file => { revealed.push(file); } });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  async function call<T = any>(channel: string, ...args: unknown[]): Promise<T> { const handler = handlers.get(channel); assert.ok(handler, `未注册 IPC：${channel}`); return handler(...args); }
  async function selectMapping(source: string[][], headers: string[] = source[0], extension: 'csv' | 'xlsx' = 'csv') {
    const sourcePath = join(root, `source-${store.listMappingJobs().length}.${extension}`);
    const templatePath = join(root, `template-${store.listMappingJobs().length}.xlsx`);
    await writeFile(sourcePath, extension === 'csv' ? exportCsv(source[0], source.slice(1)) : exportXlsx(source[0], source.slice(1)));
    await writeFile(templatePath, exportXlsx(headers, []));
    files.push(sourcePath, templatePath);
    const selected = await call('iteration:mapping-source-select', { projectId: projects[0].id, systemType: 'MES6', productVersion: '合成版本', dataType: '合成物料主数据' });
    const template = await call('iteration:mapping-template-select', selected.job.id);
    const suggestions = await call<MappingSuggestion[]>('iteration:mapping-suggest', selected.job.id);
    const mappings = suggestions.map(item => ({ ...item.mapping, status: 'confirmed' as const }));
    return { sourcePath, templatePath, selected, template, suggestions, mappings, jobId: selected.job.id as string };
  }
  return { root, database, store, projects, files, saves, revealed, call, selectMapping };
}

test('F02 实际 IPC → SQLite → 本地文件：真实模板列顺序、人工确认、转换规则、版本和历史重启可读', async t => {
  const fx = await fixture(t);
  const flow = await fx.selectMapping([['编码', '名称', '状态'], ['000123', ' 螺丝 ', '启用'], ['000124', '垫片', '停用']], ['名称', '编码', '状态']);
  assert.equal(flow.selected.preview.totalRows, 2);
  assert.deepEqual(flow.template.preview.columns.map((column: { label: string }) => column.label), ['名称', '编码', '状态']);
  assert.equal('sourcePath' in flow.selected.job, false);
  assert.equal('templatePath' in flow.template.job, false);
  assert.ok(flow.suggestions.every(item => item.mapping.status === 'suggested'));
  // 故意把调用参数反序，生产 IPC 仍必须按真实模板顺序输出。
  const first = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId: flow.jobId, mappings: [...flow.mappings].reverse(), format: 'xlsx' });
  assert.equal(first.run.status, 'passed'); assert.equal(first.run.errorCount, 0); assert.equal(first.run.successCount, 2);
  assert.deepEqual(first.headers, ['名称', '编码', '状态']); assert.ok(first.path); assert.ok(first.run.reportPath);
  const firstBytes = await readFile(first.path);
  const parsed = parseSourceBytes('result.xlsx', firstBytes);
  assert.deepEqual(parsed.rows, [['螺丝', '000123', '启用'], ['垫片', '000124', '停用']]);
  assert.equal(createHash('sha256').update(firstBytes).digest('hex'), first.run.outputSha256);
  const secondMappings = flow.mappings.map(mapping => mapping.targetFieldLabel === '编码' ? { ...mapping, transformDsl: { prefix: 'M-' } } : mapping);
  const second = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId: flow.jobId, mappings: secondMappings, format: 'csv' });
  assert.equal(second.run.ruleSetVersion, first.run.ruleSetVersion + 1); assert.notEqual(second.path, first.path); assert.notEqual(second.run.id, first.run.id);
  assert.deepEqual(await readFile(first.path), firstBytes);
  assert.deepEqual(parseCsv(await readFile(second.path!, 'utf8')), [['名称', '编码', '状态'], ['螺丝', 'M-000123', '启用'], ['垫片', 'M-000124', '停用']]);
  assert.equal(fx.store.listMappingRuns(flow.jobId).length, 2);
  const restore = await fx.call('iteration:mapping-restore', flow.jobId);
  assert.equal(restore.mappings.find((item: FieldMapping) => item.targetFieldLabel === '编码').transformDsl.prefix, 'M-');
  assert.equal(restore.job.status, 'exported');
  const reopened = await LocalStore.open(fx.database);
  try { assert.equal(reopened.listMappingRuns(flow.jobId).length, 2); assert.equal(reopened.getMappingRuleSet(restore.job.mappingRuleSetId)?.version, 2); }
  finally { reopened.close(); }
  await fx.call('iteration:mapping-reveal', first.run.id); assert.deepEqual(fx.revealed, [first.path]);
});

test('F02 源文件或真实模板内容改变时阻断旧映射，未留下伪成功 Run 或导入文件', async t => {
  const fx = await fixture(t);
  for (const kind of ['sourcePath', 'templatePath'] as const) {
    const flow = await fx.selectMapping([['编码', '名称'], ['0001', '合成物料']]);
    await writeFile(flow[kind], kind === 'sourcePath' ? '编码,名称\n0002,已改变\n' : exportXlsx(['编码', '新字段'], []));
    await assert.rejects(fx.call('iteration:mapping-convert', { jobId: flow.jobId, mappings: flow.mappings, format: 'xlsx' }), /指纹已改变|已改变|已变化/);
    await assert.rejects(fx.call('iteration:mapping-restore', flow.jobId), /已变化/);
    assert.equal(fx.store.listMappingRuns(flow.jobId).length, 0);
  }
  assert.equal(fx.store.listMappingRuns().length, 0);
});

test('F02 切换源文件或模板工作表后不能从历史恢复旧确认规则，旧成果保留且新列必须重新确认', async t => {
  const fx = await fixture(t);
  const archive = unzipSync(exportXlsx(['编码', '名称'], [['0001', '螺丝']]));
  const other = unzipSync(exportXlsx(['名称', '编码'], [['垫片', '0002']]));
  archive['xl/workbook.xml'] = strToU8(strFromU8(archive['xl/workbook.xml']).replace('</sheets>', '<sheet name="反序资料" sheetId="2" r:id="rId2"/></sheets>'));
  archive['xl/_rels/workbook.xml.rels'] = strToU8(strFromU8(archive['xl/_rels/workbook.xml.rels']).replace('</Relationships>', '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>'));
  archive['[Content_Types].xml'] = strToU8(strFromU8(archive['[Content_Types].xml']).replace('</Types>', '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
  archive['xl/worksheets/sheet2.xml'] = other['xl/worksheets/sheet1.xml'];
  for (const kind of ['source', 'template'] as const) {
    const sourcePath = join(fx.root, `${kind}-源.xlsx`); const templatePath = join(fx.root, `${kind}-模板.xlsx`);
    await writeFile(sourcePath, kind === 'source' ? zipSync(archive) : exportXlsx(['编码', '名称'], [['0001', '螺丝']]));
    await writeFile(templatePath, kind === 'template' ? zipSync(archive) : exportXlsx(['编码', '名称'], []));
    fx.files.push(sourcePath, templatePath);
    const selected = await fx.call('iteration:mapping-source-select', { projectId: fx.projects[0].id, systemType: 'MES6', dataType: '合成物料' });
    const jobId = selected.job.id; await fx.call('iteration:mapping-template-select', jobId);
    const suggestions = await fx.call<MappingSuggestion[]>('iteration:mapping-suggest', jobId);
    const first = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId, mappings: suggestions.map(item => ({ ...item.mapping, status: 'confirmed' })), format: 'xlsx' });
    assert.equal(first.run.status, 'passed'); const original = await readFile(first.path!);
    const reparsed = await fx.call<MappingSourcePreview>('iteration:mapping-reparse', { jobId, kind, options: { sheetName: '反序资料' } });
    assert.deepEqual(reparsed.columns.map(item => item.label), ['名称', '编码']);
    const restored = await fx.call('iteration:mapping-restore', jobId);
    assert.equal(restored.job.mappingRuleSetId, undefined); assert.deepEqual(restored.mappings, []);
    const blocked = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId, mappings: restored.mappings, format: 'xlsx' });
    assert.equal(blocked.run.status, 'has_errors'); assert.equal(blocked.path, undefined);
    const fresh = await fx.call<MappingSuggestion[]>('iteration:mapping-suggest', jobId);
    assert.ok(fresh.every(item => item.mapping.status === 'suggested'));
    const final = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId, mappings: fresh.map(item => ({ ...item.mapping, status: 'confirmed' })), format: 'xlsx' });
    assert.equal(final.run.status, 'passed');
    const finalPreview = parseSourceBytes('结果.xlsx', await readFile(final.path!));
    assert.deepEqual(finalPreview.rows, kind === 'source' ? [['0002', '垫片']] : [['螺丝', '0001']]);
    assert.equal(finalPreview.sheetName, kind === 'template' ? '反序资料' : '转换结果');
    assert.deepEqual(await readFile(first.path!), original); assert.equal(fx.store.listMappingRuns(jobId).length, 3);
  }
});

test('F02 无缓存公式显示原公式并阻断空值导出，普通警告确认不能绕过', async t => {
  const fx = await fixture(t);
  for (const kind of ['source', 'template'] as const) {
    const archive = unzipSync(exportXlsx(['编码', '数量'], [['0001', '2']]));
    const formulaSheet = strFromU8(archive['xl/worksheets/sheet1.xml']).replace(/<c r="B2"[^>]*>[\s\S]*?<\/c>/, '<c r="B2"><f>1+1</f></c>');
    assert.match(formulaSheet, /<f>1\+1<\/f>/);
    archive['xl/worksheets/sheet1.xml'] = strToU8(formulaSheet);
    const sourcePath = join(fx.root, `${kind}-公式源.xlsx`); const templatePath = join(fx.root, `${kind}-公式模板.xlsx`);
    await writeFile(sourcePath, kind === 'source' ? zipSync(archive) : exportXlsx(['编码', '数量'], [['0001', '2']]));
    await writeFile(templatePath, kind === 'template' ? zipSync(archive) : exportXlsx(['编码', '数量'], []));
    fx.files.push(sourcePath, templatePath);
    const selected = await fx.call('iteration:mapping-source-select', { projectId: fx.projects[0].id, systemType: 'MES6', dataType: '合成物料' });
    const template = await fx.call('iteration:mapping-template-select', selected.job.id);
    const preview: MappingSourcePreview = kind === 'source' ? selected.preview : template.preview;
    assert.equal(preview.uncachedFormulaCount, 1); assert.match(preview.warnings?.join('\n') ?? '', /B2.*=1\+1.*没有缓存值/);
    const suggestions = await fx.call<MappingSuggestion[]>('iteration:mapping-suggest', selected.job.id);
    await assert.rejects(fx.call('iteration:mapping-convert', { jobId: selected.job.id, mappings: suggestions.map(item => ({ ...item.mapping, status: 'confirmed' })), format: 'xlsx', warningsConfirmed: true }), /公式没有缓存值/);
    assert.equal(fx.store.listMappingRuns(selected.job.id).length, 0);
  }
});

test('F02 未确认、必填、枚举和重复错误均无可导入文件，真实行号与受管错误报告仍可打开', async t => {
  const fx = await fixture(t);
  const cases: Array<{ name: string; rows: string[][]; change: (mapping: FieldMapping) => FieldMapping; message: RegExp }> = [
    { name: '未确认', rows: [['编码', '状态'], ['0001', '启用']], change: mapping => ({ ...mapping, status: 'suggested' }), message: /尚未人工确认/ },
    { name: '必填', rows: [['编码', '状态'], ['', '启用']], change: mapping => ({ ...mapping, transformDsl: mapping.targetFieldLabel === '编码' ? { required: true } : {} }), message: /必填字段.*为空/ },
    { name: '枚举', rows: [['编码', '状态'], ['0001', '未知状态']], change: mapping => ({ ...mapping, transformDsl: mapping.targetFieldLabel === '状态' ? { allowedValues: ['启用', '停用'] } : {} }), message: /不在允许枚举/ },
    { name: '重复', rows: [['编码', '状态'], ['0001', '启用'], ['0001', '停用']], change: mapping => ({ ...mapping, transformDsl: mapping.targetFieldLabel === '编码' ? { unique: true } : {} }), message: /与第 2 行重复/ },
  ];
  for (const scenario of cases) {
    const flow = await fx.selectMapping(scenario.rows);
    const result = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId: flow.jobId, mappings: flow.mappings.map(scenario.change), format: 'xlsx' });
    assert.equal(result.run.status, 'has_errors', scenario.name); assert.ok(result.run.errorCount > 0); assert.equal(result.path, undefined); assert.equal(result.run.outputPath, undefined);
    assert.match(result.issues.map(issue => issue.message).join('\n'), scenario.message);
    assert.ok(result.run.reportPath);
    const files = await readdir(dirname(result.run.reportPath));
    assert.deepEqual(files.sort(), ['映射规则.json', '转换报告.json', '错误明细.csv'].sort());
    const report = JSON.parse(await readFile(result.run.reportPath, 'utf8'));
    assert.equal(report.run.id, result.run.id); assert.equal(report.ruleSet.status, 'draft');
    assert.ok(report.issues.every((issue: { mappingRunId: string }) => issue.mappingRunId === result.run.id));
    if (scenario.name === '重复') assert.equal(result.issues.find(issue => /重复/.test(issue.message))?.sourceRow, 3);
    if (scenario.name === '必填') assert.equal(result.issues.find(issue => /必填/.test(issue.message))?.sourceRow, 2);
    assert.ok(fx.store.listMappingValidationIssues(result.run.id).length > 0);
    await fx.call('iteration:mapping-reveal', result.run.id); assert.equal(fx.revealed.at(-1), result.run.reportPath);
  }
});

test('F01 实际项目资料按 SHA 校验、来源隔离；配置导入只合并待确认副本，项目已有信息与历史快照不被覆盖', async t => {
  const fx = await fixture(t);
  const [a, b] = fx.projects;
  const workspace = (name: string) => ({ name, systemType: 'MES6', productVersions: ['6.fixture'], stage: '实施', status: 'active' });
  await fx.call('iteration:project-context-save', a.id, workspace('甲项目原信息'));
  await fx.call('iteration:project-context-save', b.id, workspace('乙项目原信息'));
  const aFact = await fx.call('iteration:project-fact-save', a.id, { title: '同名业务规则', content: '甲项目唯一事实', category: '合成业务', status: 'confirmed', sourceRefs: [] });
  await fx.call('iteration:project-fact-save', a.id, { title: '未确认规则', content: '甲项目草稿不得加载', category: '合成业务', status: 'proposed', sourceRefs: [] });
  await fx.call('iteration:project-decision-save', a.id, { title: '甲决策', decision: '甲项目唯一决策', status: 'confirmed', sourceRefs: [] });
  await fx.call('iteration:project-fact-save', b.id, { title: '同名业务规则', content: '乙项目唯一事实', category: '合成业务', status: 'confirmed', sourceRefs: [] });
  const aFile = join(a.path, '同名需求.md'); const bFile = join(b.path, '同名需求.md');
  await writeFile(aFile, '# 甲项目专属资料\n仅合成甲流程'); await writeFile(bFile, '# 乙项目专属资料\n仅合成乙流程');
  fx.files.push(aFile, bFile);
  const aResource = await fx.call('iteration:project-resource-select', a.id); const bResource = await fx.call('iteration:project-resource-select', b.id);
  assert.notEqual(aResource.sourceSha256, bResource.sourceSha256);
  const aContext = await fx.call('iteration:project-context-build', a.id);
  const bContext = await fx.call('iteration:project-context-build', b.id);
  assert.match(aContext.text, /甲项目唯一事实/); assert.match(aContext.text, /甲项目专属资料/); assert.doesNotMatch(aContext.text, /乙项目|草稿不得加载/);
  assert.match(bContext.text, /乙项目唯一事实/); assert.match(bContext.text, /乙项目专属资料/); assert.doesNotMatch(bContext.text, /甲项目唯一|甲项目专属/);
  const exportFile = join(fx.root, '项目配置.json'); fx.saves.push(exportFile);
  assert.equal(await fx.call('iteration:project-config-export', a.id), exportFile);
  const exported = JSON.parse(await readFile(exportFile, 'utf8'));
  assert.equal(exported.schemaVersion, 1); assert.equal(exported.workspace.id, a.id);
  assert.equal(exported.resources[0].localPath, undefined); assert.equal(exported.resources[0].status, 'unavailable'); assert.match(exported.resources[0].sourceSha256, /^[a-f0-9]{64}$/);
  fx.files.push(exportFile);
  const imported = await fx.call('iteration:project-config-import', b.id);
  assert.deepEqual(imported, { facts: 2, decisions: 1, resources: 1 });
  assert.equal(fx.store.getProjectWorkspace(b.id)?.name, '乙项目原信息');
  const importedFact = fx.store.listProjectFacts(b.id).find(item => item.content === aFact.content);
  assert.ok(importedFact); assert.notEqual(importedFact.id, aFact.id); assert.equal(importedFact.status, 'proposed'); assert.equal(importedFact.confirmedBy, undefined);
  assert.ok(fx.store.listProjectDecisions(b.id).every(item => item.status === 'proposed'));
  const importedResource = fx.store.listProjectResourceLinks(b.id).find(item => item.sourceSha256 === aResource.sourceSha256);
  assert.ok(importedResource); assert.notEqual(importedResource.id, aResource.id); assert.equal(importedResource.localPath, undefined); assert.equal(importedResource.status, 'unavailable');
  const afterImport = await fx.call('iteration:project-context-build', b.id);
  assert.doesNotMatch(afterImport.text, /甲项目唯一|甲项目专属/); assert.match(afterImport.text, /乙项目唯一事实/);
  assert.equal(fx.store.listProjectContextSnapshots(a.id).find(item => item.id === aContext.snapshot.id)?.contextHash, aContext.snapshot.contextHash);
  await writeFile(aFile, '甲资料内容已变化');
  const afterChange = await fx.call('iteration:project-context-build', a.id);
  assert.doesNotMatch(afterChange.text, /甲项目专属资料|甲资料内容已变化/); assert.equal(fx.store.listProjectResourceLinks(a.id)[0].status, 'unavailable');
  await fx.call('iteration:project-context-save', a.id, { ...workspace('甲项目原信息'), status: 'archived' });
  await assert.rejects(fx.call('iteration:project-context-build', a.id), /恢复项目上下文/);
  assert.ok(fx.store.listProjectFacts(a.id).length > 0); assert.ok(fx.store.listProjectContextSnapshots(a.id).length > 0);
});

test('F01/F02 JSON 与规则只按数据解析：脚本 DSL 被拒绝，公式按文本导出，报告不会执行任意代码', async t => {
  const fx = await fixture(t);
  const marker = '__jinggongMappingWorkflowExecuted';
  const globalMarker = globalThis as typeof globalThis & Record<string, unknown>;
  assert.equal(globalMarker[marker], undefined);
  const literalCode = `globalThis.${marker} = true`;
  const formula = '=HYPERLINK("https://example.invalid","合成公式")';
  const flow = await fx.selectMapping([['编码', '说明'], ['0001', literalCode]], ['编码', '说明'], 'xlsx');
  const maliciousRules = flow.mappings.map(mapping => ({ ...mapping, transformDsl: { script: literalCode } }));
  await assert.rejects(fx.call('iteration:mapping-convert', { jobId: flow.jobId, mappings: maliciousRules, format: 'xlsx' }), /unrecognized|Unrecognized/);
  assert.equal(fx.store.listMappingRuns(flow.jobId).length, 0); assert.equal(globalMarker[marker], undefined);
  const literalMappings = flow.mappings.map(mapping => mapping.targetFieldLabel === '说明' ? { ...mapping, transformDsl: { constant: formula } } : mapping);
  const csv = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId: flow.jobId, mappings: literalMappings, format: 'csv' });
  assert.equal(parseCsv(await readFile(csv.path!, 'utf8'))[1][1], `'${formula}`);
  const xlsx = await fx.call<MappingConversionResult>('iteration:mapping-convert', { jobId: flow.jobId, mappings: literalMappings, format: 'xlsx' });
  const archive = unzipSync(await readFile(xlsx.path!)); const sheet = strFromU8(archive['xl/worksheets/sheet1.xml']);
  assert.match(sheet, /t="inlineStr"/); assert.doesNotMatch(sheet, /<f(?:\s|>)/); assert.equal(parseSourceBytes('safe.xlsx', await readFile(xlsx.path!)).rows[0][1], formula);
  const report = JSON.parse(await readFile(xlsx.run.reportPath!, 'utf8'));
  assert.equal(JSON.parse(report.ruleSet.rulesJson).find((mapping: FieldMapping) => mapping.targetFieldLabel === '说明').transformDsl.constant, formula);
  assert.equal(globalMarker[marker], undefined);
  const maliciousConfig = join(fx.root, 'script-config.json');
  await writeFile(maliciousConfig, `globalThis.${marker}=true;`); fx.files.push(maliciousConfig);
  await assert.rejects(fx.call('iteration:project-config-import', fx.projects[1].id), /JSON|Unexpected/);
  assert.equal(fx.store.getProjectWorkspace(fx.projects[1].id), undefined); assert.equal(globalMarker[marker], undefined);
  await assert.rejects(access(join(fx.root, marker)));
});

test('F01 不能凭另一项目的事实 ID 或资源 ID 写入当前项目，也不允许从 renderer 注入文件路径', async t => {
  const fx = await fixture(t); const [a, b] = fx.projects;
  const fact = await fx.call('iteration:project-fact-save', a.id, { title: '合成事实', content: '仅甲项目', category: '合成', status: 'confirmed', sourceRefs: [] });
  await assert.rejects(fx.call('iteration:project-fact-save', b.id, { id: fact.id, title: '跨项目覆盖', content: '不应写入', category: '合成', status: 'confirmed', sourceRefs: [] }), /项目事实不存在/);
  await assert.rejects(fx.call('iteration:project-resource-save', b.id, { resourceType: 'requirement', resourceId: 'fixture', displayName: '任意路径', status: 'active', localPath: 'C:\\Windows\\win.ini' }), /unrecognized|Unrecognized/);
  assert.equal(fx.store.listProjectFacts(a.id)[0].content, '仅甲项目'); assert.equal(fx.store.listProjectFacts(b.id).length, 0); assert.equal(fx.store.listProjectResourceLinks(b.id).length, 0);
});

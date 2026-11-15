import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src/index';
import { assertTaskPlanSteps, type ProjectWorkspaceContext, type TaskPlanStep } from '../packages/domain/src';
import { alignMappingsToTemplate, buildProjectContext, exportCsv, exportXlsx, parseCsv, parseSourceBytes, suggestMappings, validateAndConvert } from '../packages/second-iteration/src';

test('CSV 解析保留引号、逗号、换行与带前导零的编号', () => {
  assert.deepEqual(parseCsv('物料编码,名称,说明\r\n00123,"螺丝, M3","第一行\n第二行"\r\n'), [
    ['物料编码', '名称', '说明'], ['00123', '螺丝, M3', '第一行\n第二行'],
  ]);
  assert.throws(() => parseCsv('a,b\n"未闭合,x'), /未闭合/);
});

test('CSV/XLSX 预览与导出可往返，字段建议可确定性转换并定位必填错误', () => {
  const source = Buffer.from('编码,名称\r\n00123, 螺丝 \r\n,垫片\r\n', 'utf8');
  const preview = parseSourceBytes('物料.csv', source);
  assert.equal(preview.columns[0].label, '编码');
  assert.equal(preview.rows[0][0], '00123');
  assert.equal(preview.totalRows, 2);
  const suggestions = suggestMappings(preview.columns, ['编码', '名称']);
  const mappings = suggestions.map(item => ({ ...item.mapping, transformDsl: { trim: true, ...(item.mapping.targetFieldKey === '编码' ? { required: true } : {}) }, status: 'confirmed' as const }));
  const converted = validateAndConvert(preview.rows, preview.columns, mappings, 'run-1');
  assert.equal(converted.output[0][0], '00123');
  assert.equal(converted.errorCount, 1);
  assert.equal(converted.issues[0].mappingRunId, 'run-1');
  assert.match(exportCsv(['编码', '名称'], converted.output), /00123/);

  const workbook = exportXlsx(['编码', '名称'], [['0007', '垫片']]);
  const xlsxPreview = parseSourceBytes('结果.xlsx', workbook);
  assert.deepEqual(xlsxPreview.rows, [['0007', '垫片']]);

  const wideHeaders = Array.from({ length: 30 }, (_, index) => `列${index + 1}`);
  const widePreview = parseSourceBytes('宽表.xlsx', exportXlsx(wideHeaders, [wideHeaders]));
  assert.equal(widePreview.columns.length, 30);
  assert.deepEqual(widePreview.rows[0].slice(-4), ['列27', '列28', '列29', '列30']);
});

test('真实模板字段会补齐未映射项，阻断错误时不得视为可导入结果', () => {
  const source = parseSourceBytes('源.csv', Buffer.from('编码,名称\r\n001,螺丝\r\n', 'utf8'));
  const template = source.columns.map((column, index) => ({ key: `target_${index + 1}`, label: index === 0 ? '编码' : '规格', sampleValues: [] }));
  const suggestion = suggestMappings(source.columns, ['编码']).map(item => ({ ...item.mapping, status: 'confirmed' as const }));
  const mappings = alignMappingsToTemplate(template, suggestion, 'rules-1');
  assert.deepEqual(mappings.map(item => item.targetFieldLabel), ['编码', '规格']);
  assert.equal(mappings[1].status, 'unmapped');
  const converted = validateAndConvert(source.rows, source.columns, mappings, 'run-blocked');
  assert.equal(converted.errorCount, 1);
  assert.equal(converted.issues[0].blocking, true);
});

test('项目上下文仅包含本项目生效资料与已确认事实决策', () => {
  const project: ProjectWorkspaceContext = { id: 'p1', name: 'MES 项目', systemType: 'MES6', productVersions: ['6.0'], stage: '实施', status: 'active', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' };
  const { text, snapshot } = buildProjectContext(project, [
    { id: 'r1', projectId: 'p1', resourceType: 'repository', resourceId: 'repo-1', displayName: '代码库', status: 'active', linkedAt: '2026-11-14T00:00:00Z' },
    { id: 'r2', projectId: 'p1', resourceType: 'repository', resourceId: 'repo-2', displayName: '旧代码库', status: 'superseded', linkedAt: '2026-11-14T00:00:00Z' },
    { id: 'r3', projectId: 'p2', resourceType: 'repository', resourceId: 'repo-3', displayName: '其他项目', status: 'active', linkedAt: '2026-11-14T00:00:00Z' },
  ], [
    { id: 'f1', projectId: 'p1', title: '数据库', content: 'Oracle', category: '技术', status: 'confirmed', sourceRefs: [], createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' },
    { id: 'f2', projectId: 'p1', title: '未核实', content: '待确认', category: '技术', status: 'proposed', sourceRefs: [], createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' },
  ], [
    { id: 'd1', projectId: 'p1', title: '版本', decision: '6.0', status: 'confirmed', sourceRefs: [], createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' },
  ]);
  assert.match(text, /代码库/);
  assert.match(text, /Oracle/);
  assert.match(text, /6\.0/);
  assert.doesNotMatch(text, /旧代码库|其他项目|待确认/);
  assert.deepEqual(snapshot.selectedSources.map(item => item.sourceId), ['f1', 'd1', 'repo-1']);
  assert.match(snapshot.contextHash, /^[a-f0-9]{64}$/);
});

test('任务计划步骤拒绝不存在的依赖和依赖环', () => {
  const step = (stepKey: string, dependsOn: string[]): TaskPlanStep => ({ id: stepKey, planId: 'plan', stepKey, title: stepKey, description: '', order: 1, dependsOn, status: 'pending', required: true, evidenceRefs: [] });
  assert.throws(() => assertTaskPlanSteps([step('a', ['missing'])]), /依赖不存在/);
  assert.throws(() => assertTaskPlanSteps([step('a', ['b']), step('b', ['a'])]), /依赖环/);
  assert.doesNotThrow(() => assertTaskPlanSteps([step('a', []), step('b', ['a'])]));
});

test('SQLite v12 保存并恢复第二迭代的项目和任务记录，隔离查询按项目过滤', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-second-iteration-'));
  const filename = join(root, 'agent.db');
  let store: LocalStore | undefined;
  const workspace: ProjectWorkspaceContext = { id: 'project-1', projectCode: 'MES-01', name: 'MES 一期', systemType: 'MES6', productVersions: ['6.0'], stage: '实施', status: 'active', createdAt: '2026-11-14T00:00:00Z', updatedAt: '2026-11-14T00:00:00Z' };
  try {
    store = await LocalStore.open(filename);
    store.saveProjectWorkspace(workspace);
    store.saveProjectWorkspace({ ...workspace, id: 'project-2', name: '其他项目' });
    store.saveProjectFact({ id: 'fact-1', projectId: 'project-1', title: '数据库', content: 'Oracle', category: '技术', status: 'confirmed', sourceRefs: [], createdAt: workspace.createdAt, updatedAt: workspace.updatedAt });
    const plan = { id: 'plan-1', taskId: 'task-1', projectId: workspace.id, revision: 1, goal: '升级', assumptions: [], acceptanceCriteria: ['通过测试'], status: 'confirmed' as const, createdAt: workspace.createdAt };
    store.saveTaskPlan(plan);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getProjectWorkspace('project-1')?.name, 'MES 一期');
    assert.deepEqual(store.listProjectFacts('project-1').map(item => item.id), ['fact-1']);
    assert.deepEqual(store.listProjectFacts('project-2'), []);
    assert.deepEqual(store.listTaskPlans('task-1'), [plan]);
    assert.equal(store.listProjectWorkspaces().length, 2);
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

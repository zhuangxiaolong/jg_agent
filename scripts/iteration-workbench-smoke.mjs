import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { strFromU8, unzipSync } from 'fflate';
import initSqlJs from 'sql.js';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

// 使用真实 Electron、Git、SQLite 和本地文件。只替换原生文件选择，不替换 IPC、规则或业务结果。
const workspace = process.cwd();
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-iteration-workbench-'));
const repo = path.join(root, '工作台验收项目');
const data = path.join(root, 'data');
const output = path.resolve(workspace, 'test-results');
const startedAt = new Date().toISOString();
await mkdir(repo); await mkdir(output, { recursive: true });
// Windows Node 24 的 tsImport namespace 不能可靠解析多层 TS re-export；临时打包同一源码作为文件读写助手。
const helperFile = path.join(root, 'mapping-helper.cjs');
await build({ entryPoints: [path.join(workspace, 'packages/second-iteration/src/index.ts')], outfile: helperFile, bundle: true, platform: 'node', format: 'cjs' });
const { exportXlsx, parseSourceBytes, parseCsv } = createRequire(import.meta.url)(helperFile);
const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
git(['init', '-b', 'main']); git(['config', 'user.name', '精工测试']); git(['config', 'user.email', 'test@example.invalid']);
await writeFile(path.join(repo, 'README.md'), '# 第二迭代本地验收基线\n');
git(['add', '.']); git(['commit', '-m', '建立工作台验收基线']);
const sourceFile = path.join(root, '合成客户物料.csv');
const templateFile = path.join(root, '合成真实目标模板.xlsx');
const resourceFile = path.join(root, '合成项目需求.md');
const zipFile = path.join(root, '本地交付包-r1.zip');
await writeFile(sourceFile, '编码,名称,状态\r\n000123, 螺丝 ,启用\r\n000124,垫片,停用\r\n');
await writeFile(templateFile, exportXlsx(['名称', '编码', '状态'], []));
await writeFile(resourceFile, '# 合成资料\n物料编码保留前导零；本资料仅为独立验收使用。\n');
const checks = [], screenshots = [], errors = [];
let app, page, session, project, failure;
function check(id, evidence) { checks.push({ id, passed: true, evidence }); console.log(`通过：${id}`); }
async function shot(name) { const filename = path.join(output, `iteration-workbench-${name}.png`); await page.screenshot({ path: filename }); screenshots.push(filename); }
async function pickFile(filename) { await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, filename); }
async function saveFile(filename) { await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, filename); }
async function mappingHistory() { return page.evaluate(id => window.jinggong.iteration.mappingHistory(id), project.id); }

try {
  const env = { ...process.env, JINGGONG_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: workspace, env });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1600, 1000); window.show(); });
  await pickFile(repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  const group = page.getByRole('region', { name: '项目 工作台验收项目', exact: true });
  await group.locator('.project-item').waitFor();
  await group.locator('.project-item').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入任务', exact: true }).waitFor();
  const boot = await page.evaluate(() => window.jinggong.bootstrap());
  project = boot.projects.find(item => item.name === '工作台验收项目');
  assert.ok(project); assert.equal(await realpath(project.path), await realpath(repo)); session = boot.sessions.find(item => item.projectId === project.id); assert.ok(session);
  assert.equal(boot.dataDirectory.toLowerCase(), data.toLowerCase());
  check('独立数据目录、真实 Git 项目与会话由 UI 创建', { projectId: project.id, sessionId: session.id, root, rendererUrl: page.url() });

  const iteration = page.getByRole('button', { name: '0.7 工作台', exact: true });
  if (!(await iteration.isVisible())) { const show = page.getByRole('button', { name: '显示右侧面板', exact: true }); if (await show.isVisible()) await show.click(); }
  await iteration.click();
  const workbench = page.locator('.iteration-workbench');
  const tabs = workbench.getByRole('group', { name: '0.7工作台功能', exact: true });
  async function tab(name) { await tabs.getByRole('button', { name, exact: true }).click(); await expect(tabs.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true'); }
  await tab('项目上下文');
  await workbench.getByLabel('项目名称', { exact: true }).fill('合成 MES6 交付项目');
  await workbench.getByLabel('客户名称', { exact: true }).fill('离线合成客户');
  await workbench.getByLabel('项目编号', { exact: true }).fill('SYNTHETIC-071');
  await workbench.getByRole('button', { name: '保存项目资料', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(id => window.jinggong.iteration.getProjectContext(id), project.id)).workspace?.projectCode).toBe('SYNTHETIC-071');
  await pickFile(resourceFile); await workbench.getByRole('button', { name: '关联本地资料', exact: true }).click();
  await expect(workbench.getByText('合成项目需求.md', { exact: true })).toBeVisible();
  await workbench.getByLabel('事实标题', { exact: true }).fill('编码前导零规则');
  await workbench.getByLabel('事实内容', { exact: true }).fill('合成客户物料编码保留前导零，不自动转换数值。');
  await workbench.getByRole('button', { name: '保存事实草稿', exact: true }).click();
  const factState = workbench.getByLabel('编码前导零规则的事实状态', { exact: true });
  await expect(factState).toHaveValue('proposed');
  await workbench.getByRole('button', { name: '刷新来源与上下文', exact: true }).click();
  await expect(workbench.locator('.iteration-context-preview')).toContainText('合成资料');
  await expect(workbench.locator('.iteration-context-preview')).not.toContainText('合成客户物料编码保留前导零');
  await factState.selectOption('confirmed'); await expect(factState).toHaveValue('confirmed');
  await workbench.getByRole('button', { name: '刷新来源与上下文', exact: true }).click();
  await expect(workbench.locator('.iteration-context-preview')).toContainText('合成客户物料编码保留前导零');
  const context = await page.evaluate(id => window.jinggong.iteration.getProjectContext(id), project.id);
  assert.equal(context.facts.length, 1); assert.equal(context.facts[0].status, 'confirmed'); assert.equal(context.resources.length, 1);
  await shot('project-context'); check('项目保存、SHA 资料关联、事实草稿不注入及确认后注入', { workspace: context.workspace, factId: context.facts[0].id, resourceId: context.resources[0].id });

  await tab('数据映射');
  await workbench.getByLabel('资料类型', { exact: true }).fill('合成物料主数据');
  await pickFile(sourceFile); await workbench.getByRole('button', { name: '选择 CSV/XLSX 源文件', exact: true }).click();
  await expect(workbench.getByText('合成客户物料.csv', { exact: true }).first()).toBeVisible();
  await pickFile(templateFile); await workbench.getByRole('button', { name: '选择并解析目标模板', exact: true }).click();
  await expect(workbench.getByText('合成真实目标模板.xlsx', { exact: true })).toBeVisible();
  await workbench.locator('summary').filter({ hasText: /^源数据样本/ }).click();
  await workbench.locator('summary').filter({ hasText: /^模板样本/ }).click();
  await shot('mapping-source');
  await workbench.getByRole('button', { name: '生成映射建议', exact: true }).click();
  await expect(workbench.locator('.iteration-rule-card')).toHaveCount(3);
  const codeRule = workbench.locator('.iteration-rule-card').filter({ has: page.getByLabel('编码 的映射状态', { exact: true }) });
  await codeRule.locator('summary').click();
  await codeRule.getByLabel('编码 的规则 JSON', { exact: true }).fill('{"trim":true,"required":true,"unique":true}');
  await codeRule.getByRole('button', { name: '检查并应用规则', exact: true }).click();
  await workbench.getByRole('button', { name: '确认可用建议', exact: true }).click();
  for (const label of ['名称', '编码', '状态']) await expect(workbench.getByLabel(`${label} 的映射状态`, { exact: true })).toHaveValue('confirmed');
  await workbench.getByRole('button', { name: '校验并导出 XLSX', exact: true }).click();
  await expect(workbench.getByRole('heading', { name: '转换结果与校验报告', exact: true })).toBeVisible();
  await expect(workbench.getByText(/成功 2\/2 行 · 错误 0 项/).first()).toBeVisible();
  let history = await mappingHistory(); assert.equal(history.length, 1); assert.equal(history[0].runs.length, 1);
  const firstRun = history[0].runs[0]; assert.equal(firstRun.status, 'passed'); assert.ok(firstRun.outputPath);
  const xlsx = await readFile(firstRun.outputPath); assert.equal(createHash('sha256').update(xlsx).digest('hex'), firstRun.outputSha256);
  assert.deepEqual(parseSourceBytes('output.xlsx', xlsx).rows, [['螺丝', '000123', '启用'], ['垫片', '000124', '停用']]);
  await workbench.getByRole('button', { name: '校验并导出 CSV', exact: true }).click();
  await expect.poll(async () => (await mappingHistory())[0]?.runs.filter(item => item.outputPath).length).toBe(2);
  history = await mappingHistory(); const csvRun = history[0].runs.find(item => item.id !== firstRun.id);
  assert.equal(csvRun.ruleSetVersion, 2); assert.notEqual(csvRun.outputPath, firstRun.outputPath); assert.deepEqual(await readFile(firstRun.outputPath), xlsx);
  assert.deepEqual(parseCsv(await readFile(csvRun.outputPath, 'utf8')), [['名称', '编码', '状态'], ['螺丝', '000123', '启用'], ['垫片', '000124', '停用']]);
  await workbench.getByRole('button', { name: '刷新历史', exact: true }).click();
  await expect(workbench.getByText('版本 2 · 2/2 行 · 错误 0 · passed', { exact: true })).toBeVisible();
  await workbench.locator('summary').filter({ hasText: /^转换结果预览/ }).click();
  await workbench.getByRole('heading', { name: '转换结果与校验报告', exact: true }).scrollIntoViewIfNeeded();
  await shot('mapping-result'); check('真实 CSV/XLSX 解析、受限规则、人工确认、双格式输出和独立版本历史', { jobId: history[0].job.id, firstRun, csvRun });

  await tab('任务计划');
  const planPanel = workbench.locator('.task-governance-panel');
  await expect(planPanel.getByRole('heading', { name: '编辑计划', exact: true })).toBeVisible();
  await planPanel.getByLabel('任务目标', { exact: true }).fill('离线验证工作台的数据转换和交付证据');
  await planPanel.getByLabel('验收标准（每行一项）', { exact: true }).fill('输出文件保持前导零\n交付包可离线读取');
  await planPanel.getByLabel('阶段名称', { exact: true }).fill('核对输入资料');
  await planPanel.getByLabel('说明、预期产出与失败处理', { exact: true }).fill('只核对本机合成资料，不调用真实模型。');
  await planPanel.getByRole('button', { name: '添加阶段', exact: true }).click();
  const secondStep = planPanel.locator('.governance-edit-step').nth(1);
  await secondStep.getByLabel('阶段名称', { exact: true }).fill('归集本地交付证据');
  await secondStep.getByLabel('依赖阶段标识（逗号分隔）', { exact: true }).fill('step-1');
  await planPanel.getByRole('button', { name: '保存待确认计划', exact: true }).click();
  await expect(planPanel.getByRole('button', { name: '确认计划', exact: true })).toBeVisible();
  await planPanel.getByRole('button', { name: '确认计划', exact: true }).click();
  await expect(planPanel.getByRole('button', { name: '执行本阶段', exact: true })).toBeEnabled();
  const plans = await page.evaluate(id => window.jinggong.taskGovernance.listPlans(id), session.id);
  assert.equal(plans.length, 1); assert.equal(plans[0].plan.status, 'confirmed'); assert.deepEqual(plans[0].steps.map(item => item.status), ['ready', 'pending']);
  await shot('task-plan'); check('任务计划真实创建、两阶段依赖与用户确认（没有发送模型）', { planId: plans[0].plan.id, steps: plans[0].steps.map(item => ({ stepKey: item.stepKey, status: item.status })) });

  await writeFile(path.join(repo, 'InventoryService.ts'), 'export const quantity = 1; // 合成本地待审查变更\n');
  await tab('影响审查');
  await workbench.getByRole('button', { name: '分析当前变更', exact: true }).click();
  await expect(workbench.getByRole('heading', { name: '分析范围与证据', exact: true })).toBeVisible();
  await expect(workbench.getByText('InventoryService.ts', { exact: true }).first()).toBeVisible();
  await expect(workbench.getByText('此入口不调用 AI 模型；建议回归尚未执行。', { exact: true })).toBeVisible();
  const impacts = await page.evaluate(target => window.jinggong.impactReview.list(target), { projectId: project.id, sessionId: session.id });
  assert.equal(impacts.length, 1); assert.ok(impacts[0].analysis.files.some(item => item.path === 'InventoryService.ts'));
  await shot('impact-analysis'); check('真实 Git 变更静态影响分析及证据分层', { reportId: impacts[0].id, files: impacts[0].analysis.files, diffFingerprint: impacts[0].diffFingerprint });

  await tab('交付包');
  const delivery = workbench.getByRole('region', { name: '任务交付档案' });
  // 面板使用 aria-label 的普通 div，兼容未声明 region 的宿主。
  const deliveryScope = (await delivery.count()) ? delivery : workbench.locator('[aria-label="任务交付档案"]');
  await deliveryScope.getByLabel('实现内容补充', { exact: true }).fill('仅合成资料：完成本地映射与证据整理，未验证真实客户环境。');
  await deliveryScope.getByLabel('遗留问题、风险和待确认事项', { exact: true }).fill('尚未运行真实模型、客户生产导入或真实 Jira 回写。');
  await deliveryScope.getByRole('button', { name: '采集证据并预览交付包', exact: true }).click();
  await expect(deliveryScope.getByRole('button', { name: '生成 ZIP 交付包', exact: true })).toBeVisible();
  await expect(deliveryScope.locator('.iteration-context-preview')).toContainText('未提供 / 未执行');
  await saveFile(zipFile); await deliveryScope.getByRole('button', { name: '生成 ZIP 交付包', exact: true }).click();
  await expect(deliveryScope.getByRole('status')).toContainText('交付 ZIP 已生成');
  const packages = await page.evaluate(input => window.jinggong.delivery.listPackages(input), { projectId: project.id });
  assert.equal(packages.length, 1); assert.equal(packages[0].status, 'success'); assert.equal(packages[0].outputPath, zipFile);
  const zip = await readFile(zipFile); assert.equal(createHash('sha256').update(zip).digest('hex'), packages[0].outputSha256);
  const contents = unzipSync(zip); assert.ok(contents['README_交付摘要.md']); assert.ok(contents['manifest.json']);
  assert.ok(strFromU8(contents['README_交付摘要.md']).includes('尚未运行真实模型'));
  assert.match(strFromU8(contents['验证报告/验证汇总.md']), /未提供 \/ 未执行/);
  assert.ok(!Object.keys(contents).some(name => name.includes('合成客户物料') || name.includes('InventoryService.ts')));
  await shot('delivery-package');
  await deliveryScope.getByRole('heading', { name: '本地交付包历史（1）', exact: true }).scrollIntoViewIfNeeded();
  await shot('delivery-history'); check('离线本地交付 ZIP、未知验证状态、Manifest/hash 与历史保留', { packageId: packages[0].id, path: zipFile, sha256: packages[0].outputSha256, files: Object.keys(contents) });
  const end = await page.evaluate(() => window.jinggong.bootstrap());
  assert.equal(end.sessions.find(item => item.id === session.id)?.status, 'idle'); assert.deepEqual(errors, []);
  check('整轮不调用模型、不执行生产导入或真实 Jira 回写，渲染无异常', { sessionStatus: end.sessions.find(item => item.id === session.id)?.status, errors });
} catch (error) {
  failure = { message: error.message, stack: error.stack }; console.error(error);
  if (page) { await shot('failure').catch(() => {}); await writeFile(path.join(output, 'iteration-workbench-failure-dom.txt'), await page.locator('body').innerText().catch(() => ''), 'utf8'); }
} finally {
  if (app) await app.close();
  if (!failure) {
    try {
      const SQL = await initSqlJs(); const database = new SQL.Database(await readFile(path.join(data, 'database', 'jinggong-agent.db')));
      const counts = {};
      for (const table of ['projects', 'sessions', 'project_workspace_contexts', 'project_facts', 'project_resource_links', 'project_context_snapshots', 'mapping_jobs', 'mapping_runs', 'task_plans', 'task_plan_steps', 'impact_reports', 'delivery_packages']) counts[table] = database.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0];
      database.close();
      assert.equal(counts.mapping_runs, 2); assert.equal(counts.task_plan_steps, 2); assert.equal(counts.delivery_packages, 1); assert.ok(counts.project_context_snapshots >= 2);
      check('真实 SQLite 在 Electron 退出后仍保留本轮全部工作台记录', counts);
    } catch (error) { failure = { message: error.message, stack: error.stack }; console.error(error); }
  }
  const report = { passed: !failure, startedAt, finishedAt: new Date().toISOString(), fixtureRoot: root, renderer: path.join(workspace, 'dist', 'renderer', 'index.html'), sourceFiles: { sourceFile, templateFile, resourceFile }, checks, screenshots, errors, ...(failure ? { failure } : {}) };
  const reportPath = path.join(output, 'iteration-workbench-smoke.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, report: reportPath, fixtureRoot: root }, null, 2));
  if (failure) process.exitCode = 1;
}

import assert from 'node:assert/strict';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 Electron、SQLite、Git 和本地索引检查。不配置 Provider，不调用付费模型，
// 失败 Trace 来自真实 sendTurn 失败，绝不注入成功响应或伪造耗时。
const expect = baseExpect.configure({ timeout: 30000 });
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-performance-desktop-')));
const dataRoot = path.join(root, 'data');
const repo = path.join(root, '性能验收临时仓库');
const output = path.resolve('test-results/performance-desktop');
const checks = [];
const evidence = { checkedAt: new Date().toISOString(), modelCalls: 0, checks, traces: [], index: undefined, layout: undefined };
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const boot = () => page.evaluate(() => window.jinggong.bootstrap());
const topCreate = () => page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true });
const report = id => page.evaluate(id => window.jinggong.performance.report(id), id);
async function launch() {
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), cwd: process.cwd(), env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(topCreate()).toBeEnabled();
}
async function sendExpectedFailure(sessionId, prompt) {
  const result = await page.evaluate(async ({ sessionId, prompt }) => {
    try { await window.jinggong.sendTurn(sessionId, prompt); return { failed: false }; }
    catch (reason) { return { failed: true, message: String(reason) }; }
  }, { sessionId, prompt });
  assert.equal(result.failed, true, '未配置 Provider 的真实发送应失败');
  await expect.poll(async () => (await report(sessionId)).latest?.status).toBe('failed');
  const value = await report(sessionId);
  assert.equal(value.latest.sessionId, sessionId);
  assert.ok(value.latest.totalDurationMs >= 0);
  assert.equal(value.sampleCount, 0);
  assert.equal(JSON.stringify(value).includes(prompt), false, 'Trace 不得记录用户正文');
  assert.equal(value.latest.firstVisibleResponseMs, undefined, '没有模型响应不能补造首响应耗时');
  const diagnostic = await page.evaluate(id => window.jinggong.performance.export(id), sessionId);
  assert.equal(diagnostic.includes(prompt), false);
  evidence.traces.push({ sessionId, status: value.latest.status, durationMs: value.latest.totalDurationMs, spans: value.latest.spans, startupError: result.message });
  return value;
}

try {
  await mkdir(output, { recursive: true });
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await mkdir(path.join(repo, 'node_modules'), { recursive: true });
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '-b', 'main']);
  await Promise.all([
    writeFile(path.join(repo, 'README.md'), '# 性能索引验收样本\n仅包含临时回归资料。\n'),
    writeFile(path.join(repo, 'src', 'search.ts'), 'export function findWidget() { return "索引关键字"; }\n'),
    writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'performance-fixture', private: true })),
    writeFile(path.join(repo, '.env'), 'FIXTURE_VALUE=temporary-test-only\n'),
    writeFile(path.join(repo, 'node_modules', 'dependency.ts'), 'export const ignoredDependency = true;\n'),
  ]);
  // 即使敏感/依赖文件被 Git 跟踪，平台过滤也必须生效。
  git(['add', '-f', '--', 'README.md', 'src/search.ts', 'package.json', '.env', 'node_modules/dependency.ts']);
  git(['-c', 'user.name=性能桌面验收', '-c', 'user.email=performance@example.invalid', 'commit', '-m', '建立临时性能验收基线']);
  await launch();
  assert.equal((await boot()).settings.providers.length, 0);
  await topCreate().click();
  await expect(page.locator('.session-item')).toHaveCount(1);
  const standalone = (await boot()).sessions[0];
  assert.equal(standalone.projectId, undefined);
  const standalonePrompt = '性能验收独立会话正文标识_20261111';
  await sendExpectedFailure(standalone.id, standalonePrompt);
  await page.locator('#performance-panel-tab').click();
  const panel = () => page.getByRole('region', { name: '会话执行监控', exact: true });
  await expect(panel()).toContainText('失败');
  await expect(panel()).toContainText('首个可见响应');
  await expect(panel()).toContainText('不可用');
  checks.push('独立会话真实未配置发送失败；失败 Trace 可查询/导出，未记录正文或伪造首响应');

  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  await expect(page.locator('.project-item')).toHaveCount(1);
  await topCreate().click();
  await expect(page.locator('.session-item')).toHaveCount(2);
  const projectSession = (await boot()).sessions.find(item => item.projectId);
  assert.ok(projectSession);
  await page.evaluate(id => window.jinggong.performance.rebuildIndex(id), projectSession.id);
  let state = await page.evaluate(id => window.jinggong.performance.indexStatus(id), projectSession.id);
  assert.equal(state.status, '可用');
  assert.equal(state.fileCount, 3, '.env 与 node_modules 必须从五个已跟踪文件中排除');
  const projectPrompt = '性能验收项目会话正文标识_20261111';
  await sendExpectedFailure(projectSession.id, projectPrompt);
  await page.locator('#performance-panel-tab').click();
  await expect(panel()).toContainText('3 个文件');
  await expect(panel()).toContainText('失败');
  evidence.index = state;
  checks.push('已注册项目隔离工作区真实建立索引，五个已跟踪文件仅计入三个安全源码文件');

  const original = (await report(projectSession.id)).settings;
  const saved = await page.evaluate(() => window.jinggong.performance.settings({ maxParallelReadOperations: 2, retainDays: 7, contextBudgetTokens: 4096 }));
  assert.ok(saved.version > original.version);
  assert.equal(saved.maxParallelReadOperations, 2);
  await app.close(); app = undefined;
  await launch();
  const persisted = (await report(projectSession.id)).settings;
  assert.equal(persisted.maxParallelReadOperations, 2);
  assert.equal(persisted.retainDays, 7);
  assert.equal(persisted.contextBudgetTokens, 4096);
  assert.equal(persisted.version, saved.version);
  checks.push('性能策略真实写入 SQLite，重启 Electron 后并行上限/保留周期/预算完整恢复');

  await page.evaluate(() => window.jinggong.performance.settings({ enabled: false }));
  state = await page.evaluate(id => window.jinggong.performance.indexStatus(id), projectSession.id);
  assert.equal(state.status, '已关闭');
  await assert.rejects(page.evaluate(id => window.jinggong.performance.rebuildIndex(id), projectSession.id), /启用.*索引/);
  const beforeDisabled = (await report(standalone.id)).traces.length;
  await page.evaluate(async id => { try { await window.jinggong.sendTurn(id, '关闭遥测后的真实失败检查'); } catch {} }, standalone.id);
  assert.equal((await report(standalone.id)).traces.length, beforeDisabled, '关闭总开关后不新增 Trace');
  const defaults = await page.evaluate(() => window.jinggong.performance.reset());
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.workspaceIndexEnabled, true);
  assert.equal(defaults.maxParallelReadOperations, 3);
  assert.equal(defaults.retainDays, 30);
  assert.equal(defaults.contextBudgetTokens, 6000);
  checks.push('关闭总开关后索引/新遥测停用，重建受阻；恢复默认策略正常');

  await page.locator('.session-item').filter({ hasText: projectPrompt }).click();
  await page.locator('#performance-panel-tab').click();
  await expect(panel()).toContainText('失败');
  await page.evaluate(id => window.jinggong.performance.rebuildIndex(id), projectSession.id);
  await expect(panel()).toContainText('3 个文件');
  const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight }));
  assert.equal(layout.width, 1366); assert.equal(layout.height, 768);
  assert.ok(layout.bodyWidth <= layout.width && layout.documentWidth <= layout.width, JSON.stringify(layout));
  assert.ok(layout.bodyHeight <= layout.height && layout.documentHeight <= layout.height, JSON.stringify(layout));
  evidence.layout = layout;
  await page.screenshot({ path: path.join(output, 'performance-failed-trace-1366x768.png'), fullPage: true });
  await panel().locator('summary').filter({ hasText: '性能策略' }).click();
  await expect(panel().getByLabel('性能优化总开关', { exact: true })).toBeChecked();
  await page.screenshot({ path: path.join(output, 'performance-settings-1366x768.png'), fullPage: true });
  checks.push('1366×768 执行监控与策略面板可见，body/document 无横纵溢出；截图明确为真实失败记录');
  await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  const readBack = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
  assert.equal(readBack.checks.length, 5);
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, error: String(error) }, null, 2));
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

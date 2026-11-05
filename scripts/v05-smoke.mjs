import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';

// 仅 Jira HTTP 与认证输入为合成夹具；真实桌面、IPC、Git Worktree、DPAPI、SQLite 不替换。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-v05-'));
const data = path.join(root, 'data'), repo = path.join(root, '合成中文 项目');
await mkdir(repo); await mkdir('test-results', { recursive: true });
const checks = [], rendererRequests = [];
const reportPath = 'test-results/v05-smoke.json', screenshotPath = 'test-results/v05-docked-workspace.png';
const password = 'synthetic-v05-password', modelKey = 'synthetic-v05-key';
const jiraTimeZone = 'Pacific/Honolulu';
function dateInZone(value, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const field = type => parts.find(part => part.type === type).value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}
const today = dateInZone(new Date(), jiraTimeZone);
const previousDay = new Date(`${today}T12:00:00Z`); previousDay.setUTCDate(previousDay.getUTCDate() - 1);
const historyDay = previousDay.toISOString().slice(0, 10);
const state = { offline: false, searches: [], requests: [], details: 0 };
let app, baseUrl;
const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-b', 'main']); git(['config', 'user.name', '合成验收']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'false']);
await writeFile(path.join(repo, 'README.md'), '# V0.5 合成仓库\n'); git(['add', '--', 'README.md']); git(['commit', '-m', '建立隔离验收基线']);
const sourceHead = git(['rev-parse', 'HEAD']);
function issue(detail = false) { return { id: '10501', key: 'TEST-501', fields: {
  summary: detail ? '合成任务完整详情' : '合成当天任务', description: '此内容为本地 HTTP 合成验收，不含用户业务资料。',
  status: { name: '待开发' }, issuetype: { name: '任务' }, assignee: { displayName: '合成账号' }, customfield_11116: today,
  updated: `${today}T10:00:00.000-1000`, attachment: [],
} }; }
function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' }); response.end(JSON.stringify(value)); }
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  state.requests.push({ method: request.method, path: url.pathname });
  if (state.offline) return json(response, { errorMessages: ['合成离线验收错误'] }, 503);
  if (request.headers.authorization !== `Basic ${Buffer.from(`fixture-user:${password}`).toString('base64')}`) return json(response, { errorMessages: ['合成认证失败'] }, 401);
  if (url.pathname === '/jira/rest/api/2/myself') return json(response, { displayName: '合成账号', timeZone: jiraTimeZone });
  if (url.pathname === '/jira/rest/api/2/field') return json(response, [{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' } }]);
  if (url.pathname === '/jira/rest/api/2/project') return json(response, [{ id: '1', key: 'TEST', name: '合成测试项目' }]);
  if (url.pathname === '/jira/rest/api/2/search') {
    const jql = url.searchParams.get('jql') || ''; state.searches.push({ jql, at: new Date().toISOString() });
    return json(response, { startAt: Number(url.searchParams.get('startAt') || 0), maxResults: 50, total: 1, issues: [issue()] });
  }
  if (url.pathname === '/jira/rest/api/2/issue/TEST-501') { state.details++; return json(response, issue(true)); }
  return json(response, { errorMessages: ['合成资源不存在'] }, 404);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = `http://127.0.0.1:${server.address().port}/jira`;

async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.JINGGONG_TEST_NO_NODE) env.PATH = `${process.env.SystemRoot}\\System32;C:\\Program Files\\Git\\cmd`;
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env });
  const page = await app.firstWindow(); page.on('request', request => { if (/^https?:/.test(request.url())) rendererRequests.push(request.url()); });
  await page.bringToFront();
  await page.getByText('精工 Agent 引擎已就绪', { exact: true }).waitFor({ state: 'attached', timeout: 30000 });
  await expect(page.getByRole('button', { name: /^(隐藏|显示)右侧面板$/, exact: true })).toBeEnabled();
  return page;
}
async function databaseRecord(table, id, keyColumn = 'id') {
  assert.ok(['sessions', 'settings'].includes(table)); assert.ok(['id', 'key'].includes(keyColumn));
  const SQL = await initSqlJs(), database = new SQL.Database(await readFile(path.join(data, 'database/jinggong-agent.db')));
  try { const statement = database.prepare(`SELECT value FROM ${table} WHERE ${keyColumn} = ?`); statement.bind([id]); assert.ok(statement.step()); const value = JSON.parse(statement.get()[0]); statement.free(); return value; }
  finally { database.close(); }
}
async function snapshot(page) { return page.evaluate(() => window.jinggong.bootstrap()); }
async function savedQueries(page) { return page.evaluate(() => window.jinggong.listJiraQueries()); }
async function stop() { await app.close(); app = undefined; }
async function saveReport(passed, extra = {}) {
  await writeFile(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), passed, checks, testData: root, executable: process.env.JINGGONG_TEST_EXE ?? '开发 Electron', evidenceKind: '真实 Electron/UI/IPC/DPAPI/SQLite/Git + 明确合成 Jira HTTP', accountTimeZone: jiraTimeZone, expectedToday: today, machineToday: dateInZone(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone), syntheticSearches: state.searches, syntheticHttpRequests: state.requests, rendererRequests, actualUserJira: '未访问', modelInference: '未调用模型', screenshot: screenshotPath, inputReplacements: ['原生目录选择仅返回隔离合成 Git 仓库'], ...extra }, null, 2));
}
try {
  let page = await launch();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await expect(page.getByRole('main', { name: 'Agent 会话工作区', exact: true })).toBeVisible();
  await expect(page.locator('#jira-panel')).toBeVisible();
  await expect(page.getByText('请先配置 Jira 地址、账号和密码，保存后将自动读取今日分配给您的任务。', { exact: true })).toBeVisible();
  assert.equal(state.requests.length, 0);
  checks.push('未配置 Jira 时主会话工作区与右侧 Jira 同时可见，自动状态明确提示配置，未发送任何 HTTP');

  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, repo);
  await page.getByRole('button', { name: '选择本地项目', exact: true }).click();
  await page.getByRole('button', { name: '新建 Agent 会话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入任务', exact: true }).waitFor();
  const firstSession = (await snapshot(page)).sessions[0];
  assert.equal(firstSession.mode, 'develop'); assert.equal((await databaseRecord('sessions', firstSession.id)).mode, 'develop');
  assert.notEqual(firstSession.workspacePath, repo); assert.match(firstSession.branch, /^agent\//); assert.equal(git(['branch', '--show-current']), 'main');
  checks.push('UI 新建会话默认隔离开发并落真实 SQLite，真实 agent Worktree 独立于源 main');

  await page.getByRole('button', { name: '打开模型设置', exact: true }).click();
  let settings = page.getByRole('dialog');
  await page.locator('#provider-name').fill('合成模式验收'); await page.locator('#provider-url').fill('https://model.example.invalid/v1'); await page.locator('#provider-model').fill('fixture-model'); await page.locator('#provider-key').fill(modelKey);
  await settings.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(settings).toHaveCount(0);
  await page.getByLabel('会话执行模式', { exact: true }).selectOption('read');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await expect.poll(async () => (await databaseRecord('sessions', firstSession.id)).mode).toBe('read');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).sessions.length, { timeout: 30000 }).toBe(2);
  const currentSession = (await snapshot(page)).sessions.find(item => item.id !== firstSession.id);
  assert.equal(currentSession.mode, 'develop');
  await expect(page.getByLabel('会话执行模式', { exact: true })).toHaveValue('develop');
  await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('保留的合成任务草稿，不发送模型');
  checks.push('已保存的只读会话与后续默认开发会话并存，没有自动改写旧只读模式');

  await page.getByRole('button', { name: '打开模型设置', exact: true }).click(); settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Jira 连接', exact: true }).click();
  await page.locator('#jira-url').fill(baseUrl); await page.locator('#jira-account').fill('fixture-user'); await page.locator('#jira-password').fill(password);
  await settings.getByRole('button', { name: '保存 Jira 配置', exact: true }).click(); await expect(page.locator('#jira-password')).toHaveValue('');
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 TEST-501', exact: true }).waitFor({ timeout: 15000 });
  await page.locator('details.jira-query-controls > summary').click();
  await expect(page.getByLabel('Jira 任务日期', { exact: true })).toHaveValue(today);
  await expect(page.getByLabel('Jira 项目范围', { exact: true })).toHaveValue('*');
  await expect(page.getByLabel('Jira 查询范围', { exact: true })).toHaveValue('daily');
  await expect(page.getByLabel('仅我的 Jira 任务', { exact: true })).toBeChecked();
  const autoQuery = (await savedQueries(page))[0]; assert.equal(autoQuery.input.date, today); assert.equal(autoQuery.page.timeZone, jiraTimeZone);
  assert.equal(autoQuery.input.onlyMine, true); assert.equal(autoQuery.input.projectKey, '*'); assert.equal(state.searches.length, 1); assert.ok(state.searches[0].jql.includes(today));
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toHaveValue('保留的合成任务草稿，不发送模型');
  checks.push('保存合成 Jira 连接后无需点击抓取，按 Pacific/Honolulu 账号当天/全部项目/仅本人自动查询一次并写入本地历史，主会话草稿保留');

  const panels = [
    ['项目侧栏', '#project-sidebar', 'leftVisible'], ['右侧面板', '#right-panel', 'rightVisible'], ['底部面板', '#bottom-panel', 'bottomVisible'],
  ];
  for (const [name, selector, field] of panels) {
    await page.getByRole('button', { name: `隐藏${name}`, exact: true }).click(); await expect(page.locator(selector)).toBeHidden();
    await expect.poll(async () => (await databaseRecord('settings', 'layout', 'key'))[field]).toBe(false);
    await page.getByRole('button', { name: `显示${name}`, exact: true }).click(); await expect(page.locator(selector)).toBeVisible();
    await expect.poll(async () => (await databaseRecord('settings', 'layout', 'key'))[field]).toBe(true);
  }
  await page.getByRole('button', { name: '代码变更', exact: true }).click(); await page.getByRole('button', { name: 'Jira', exact: true }).click();
  await page.getByRole('button', { name: 'Jira 任务', exact: true }).click();
  assert.equal(state.searches.length, 1); assert.equal((await savedQueries(page))[0].id, autoQuery.id);
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toHaveValue('保留的合成任务草稿，不发送模型');
  await page.bringToFront();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  checks.push('左/右/底面板逐项隐藏和恢复均通过真实 UI/SQLite，切换标签及 Jira 导航不重复抓取，中央会话和草稿持续存在');

  for (const [name, selector] of panels) { await page.getByRole('button', { name: `隐藏${name}`, exact: true }).click(); await expect(page.locator(selector)).toBeHidden(); }
  const hiddenLayout = { leftVisible: false, rightVisible: false, bottomVisible: false };
  await expect.poll(async () => (await snapshot(page)).layout).toEqual(hiddenLayout);
  await expect.poll(async () => await databaseRecord('settings', 'layout', 'key')).toEqual(hiddenLayout);
  state.offline = true; await stop(); page = await launch();
  assert.deepEqual((await snapshot(page)).layout, hiddenLayout);
  for (const [, selector] of panels) await expect(page.locator(selector)).toBeHidden();
  for (const [name, selector] of panels) { await page.getByRole('button', { name: `显示${name}`, exact: true }).click(); await expect(page.locator(selector)).toBeVisible(); }
  await page.getByRole('button', { name: '查看 Jira 任务 TEST-501', exact: true }).waitFor();
  await page.locator('details.jira-query-controls > summary').click();
  await expect(page.getByLabel('Jira 自动抓取状态', { exact: true })).toContainText(/失败|错误|离线/);
  assert.equal((await savedQueries(page))[0].id, autoQuery.id); assert.equal((await savedQueries(page))[0].savedAt, autoQuery.savedAt);
  const restored = await snapshot(page); assert.equal(restored.sessions.find(item => item.id === firstSession.id).mode, 'read'); assert.equal(restored.sessions.find(item => item.id === currentSession.id).mode, 'develop');
  checks.push('三面板全隐藏状态重启后从 SQLite 恢复，用户可逐项展开；离线自动失败明确显示并保留既有查询ID/内容/时间，旧只读会话保持只读');

  state.offline = false;
  await page.getByRole('button', { name: '重试自动抓取', exact: true }).click();
  await expect.poll(() => state.searches.length).toBe(2);
  await expect(page.getByRole('button', { name: '抓取任务', exact: true })).toBeEnabled();
  await page.getByLabel('Jira 任务日期', { exact: true }).fill(historyDay); await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await expect.poll(() => state.searches.length).toBe(3);
  await expect(page.getByRole('button', { name: '抓取任务', exact: true })).toBeEnabled();
  const manualQuery = (await savedQueries(page))[0]; assert.equal(manualQuery.input.date, historyDay);
  await page.getByLabel('Jira 抓取记录', { exact: true }).selectOption(autoQuery.id);
  await expect(page.getByLabel('Jira 任务日期', { exact: true })).toHaveValue(today);
  assert.equal(state.searches.length, 3);
  await page.getByRole('button', { name: '隐藏右侧面板', exact: true }).click(); await page.getByRole('button', { name: '显示右侧面板', exact: true }).click();
  assert.equal(state.searches.length, 3);
  state.offline = true; await page.getByRole('button', { name: '刷新当前查询', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /已有本地记录将保留/ })).toBeVisible();
  await expect(page.getByLabel('Jira 抓取记录', { exact: true })).toHaveValue(autoQuery.id);
  await expect(page.getByRole('button', { name: '查看 Jira 任务 TEST-501', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看 Jira 任务 TEST-501', exact: true })).toBeEnabled();
  checks.push('恢复自动按钮仅触发一次当日抓取；手动历史日期/选取记录不重发请求；手动刷新失败保留选中的历史与任务，不伪装成功空结果');

  state.offline = false;
  await page.getByRole('button', { name: '查看 Jira 任务 TEST-501', exact: true }).click();
  await page.getByLabel('Jira 任务详情 TEST-501', { exact: true }).waitFor();
  const detailReadsBeforeCreate = state.details;
  await page.getByRole('button', { name: '从此任务创建会话', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).sessions.length, { timeout: 30000 }).toBe(3);
  const jiraSession = (await snapshot(page)).sessions.find(item => item.jiraIssue);
  assert.equal(jiraSession.mode, 'develop'); assert.equal(jiraSession.jiraIssue.key, 'TEST-501'); assert.equal((await databaseRecord('sessions', jiraSession.id)).mode, 'develop');
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toBeVisible(); await expect(page.locator('#jira-panel')).toBeVisible();
  assert.ok(state.details > detailReadsBeforeCreate); assert.equal(jiraSession.jiraIssue.summary, '合成任务完整详情');
  checks.push('Jira 详情关联真实本地 Git 后同样默认隔离开发，读取新详情快照并落 SQLite，中央 Agent 与右侧 Jira 同时可操作，无模型发送');

  assert.equal(git(['rev-parse', 'HEAD']), sourceHead); assert.equal(git(['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), '# V0.5 合成仓库\n');
  const bytes = await readFile(path.join(data, 'database/jinggong-agent.db'));
  assert.equal(bytes.includes(Buffer.from(password)), false); assert.equal(bytes.includes(Buffer.from(modelKey)), false);
  assert.ok(state.requests.every(request => request.method === 'GET')); assert.deepEqual(rendererRequests, []);
  checks.push('全部源 main 文件与 HEAD 保持不变，SQLite 无合成凭据明文，Jira 仅 GET，Renderer 无远程请求，未调用任何模型或用户真实 Jira');
  await page.bringToFront();
  await page.screenshot({ path: screenshotPath, fullPage: true }); await saveReport(true); console.log(JSON.stringify({ passed: true, checks: checks.length, reportPath, testData: root }));
} catch (error) {
  if (app) { try { await (await app.firstWindow()).screenshot({ path: 'test-results/v05-failure.png', fullPage: true }); } catch {} }
  await saveReport(false, { error: String(error?.stack || error) }); console.error(error); process.exitCode = 1;
} finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); server.close(); }

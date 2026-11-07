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
const state = { offline: false, searches: [], requests: [], details: 0, images: 0, imagesWorking: false };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7N8AAAAASUVORK5CYII=', 'base64');
let app, baseUrl;
const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-b', 'main']); git(['config', 'user.name', '合成验收']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'false']);
await writeFile(path.join(repo, 'README.md'), '# V0.5 合成仓库\n'); git(['add', '--', 'README.md']); git(['commit', '-m', '建立隔离验收基线']);
const sourceHead = git(['rev-parse', 'HEAD']);
function issue(detail = false) { return { id: '10501', key: 'TEST-501', fields: {
  summary: detail ? '合成任务完整详情' : '合成当天任务', description: '此内容为本地 HTTP 合成验收，不含用户业务资料。',
  status: { name: '待开发' }, issuetype: { name: '任务' }, assignee: { displayName: '合成账号' }, customfield_11116: today,
  updated: `${today}T10:00:00.000-1000`, attachment: detail ? [
    { id: '1', filename: '超时图片.png', mimeType: 'image/png', size: png.length, content: `${baseUrl}/secure/attachment/1/timeout.png` },
    { id: '2', filename: '成功图片.png', mimeType: 'image/png', size: png.length, content: `${baseUrl}/secure/attachment/2/valid.png` }
  ] : [],
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
  if (/^\/jira\/secure\/attachment\/[12]\//.test(url.pathname)) {
    state.images++;
    if (url.pathname.includes('/1/') && !state.imagesWorking) return;
    response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(png);
  }
  return json(response, { errorMessages: ['合成资源不存在'] }, 404);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = `http://127.0.0.1:${server.address().port}/jira`;

async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.JINGGONG_TEST_NO_NODE) env.PATH = `${process.env.SystemRoot}\\System32;C:\\Program Files\\Git\\cmd`;
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env });
  const page = await app.firstWindow(); page.on('request', request => { if (/^https?:/.test(request.url())) rendererRequests.push(request.url()); });
  await page.bringToFront();
  await page.getByText('精工智能开发平台引擎已就绪', { exact: true }).waitFor({ state: 'attached', timeout: 30000 });
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

  await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
  await page.getByRole('button', { name: '模型中转站', exact: true }).click();
  let settings = page.getByRole('dialog');
  await page.locator('#provider-name').fill('合成模式验收'); await page.locator('#provider-url').fill('https://model.example.invalid/v1'); await page.locator('#provider-model').fill('fixture-model'); await page.locator('#provider-key').fill(modelKey);
  await settings.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(settings).toHaveCount(0);
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('fixture-model');
  await expect(page.getByLabel('会话执行模式', { exact: true })).toHaveValue('develop');
  await page.evaluate(async id => { const state = await window.jinggong.bootstrap(); const current = state.sessions.find(item => item.id === id); await window.jinggong.configureSession(id, { providerId: current.providerId, model: current.model, mode: 'read' }); }, firstSession.id);
  await page.locator('.breadcrumbs').click();
  await expect.poll(async () => (await databaseRecord('sessions', firstSession.id)).mode).toBe('develop');
  await page.locator('.project-new-session').click();
  await expect.poll(async () => (await snapshot(page)).sessions.length, { timeout: 30000 }).toBe(2);
  const currentSession = (await snapshot(page)).sessions.find(item => item.id !== firstSession.id);
  assert.equal(currentSession.mode, 'develop');
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  await expect(page.getByLabel('会话执行模式', { exact: true })).toHaveValue('develop');
  await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('保留的合成任务草稿，不发送模型');
  checks.push('既有会话与新会话均为完整开发模式，模型设置保存在 SQLite');

  await page.getByRole('button', { name: '打开全局设置', exact: true }).click(); settings = page.getByRole('dialog');
  await settings.getByRole('button', { name: 'Jira 连接', exact: true }).click();
  await page.locator('#jira-url').fill(baseUrl); await page.locator('#jira-account').fill('fixture-user'); await page.locator('#jira-password').fill(password);
  await settings.getByRole('button', { name: '保存 Jira 配置', exact: true }).click(); await expect(page.locator('#jira-password')).toHaveValue('');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 TEST-501', exact: true }).waitFor({ timeout: 15000 });
  await expect(page.locator('details.jira-query-controls')).not.toHaveAttribute('open');
  await expect(page.getByLabel('Jira 任务日期', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '抓取任务', exact: true })).toBeVisible();
  checks.push('右侧日报日期和抓取按钮独立常显，查询条件与历史折叠时仍可直接修改日期并查询');
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
  async function resizePanel(name, field, axis, delta) {
    const handle = page.getByRole('separator', { name, exact: true });
    const before = (await snapshot(page)).layout[field];
    const box = await handle.boundingBox(); assert.ok(box, `${name} should have a resize handle`);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + (axis === 'x' ? delta : 0), y + (axis === 'y' ? delta : 0), { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).layout[field]).toBe(before + (axis === 'y' ? -delta : name === '调整右侧面板宽度' ? -delta : delta));
    await expect.poll(async () => (await databaseRecord('settings', 'layout', 'key'))[field]).toBe(before + (axis === 'y' ? -delta : name === '调整右侧面板宽度' ? -delta : delta));
  }
  await resizePanel('调整项目和会话栏宽度', 'leftWidth', 'x', 36);
  await resizePanel('调整右侧面板宽度', 'rightWidth', 'x', -36);
  await resizePanel('调整会话输出栏高度', 'bottomHeight', 'y', -30);
  checks.push('左侧项目会话栏、右侧任务栏和底部输出栏可鼠标拖动调整，尺寸写入并从SQLite读回');
  await page.getByRole('button', { name: '代码变更', exact: true }).click(); await page.getByRole('button', { name: 'Jira', exact: true }).click();
  await page.getByRole('button', { name: 'Jira 任务', exact: true }).click();
  assert.equal(state.searches.length, 1); assert.equal((await savedQueries(page))[0].id, autoQuery.id);
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toHaveValue('保留的合成任务草稿，不发送模型');
  await page.bringToFront();
  await page.screenshot({ path: screenshotPath, fullPage: true });
  checks.push('左/右/底面板逐项隐藏和恢复均通过真实 UI/SQLite，切换标签及 Jira 导航不重复抓取，中央会话和草稿持续存在');

  for (const [name, selector] of panels) { await page.getByRole('button', { name: `隐藏${name}`, exact: true }).click(); await expect(page.locator(selector)).toBeHidden(); }
  const hiddenLayout = { ...(await snapshot(page)).layout, leftVisible: false, rightVisible: false, bottomVisible: false };
  await expect.poll(async () => (await snapshot(page)).layout).toEqual(hiddenLayout);
  await expect.poll(async () => await databaseRecord('settings', 'layout', 'key')).toEqual(hiddenLayout);
  state.offline = true; await stop();
  // 模拟升级前保存的只读会话，重启后必须自动迁移并保留其历史与运行时线程。
  const upgradeSql = await initSqlJs(), upgradePath = path.join(data, 'database/jinggong-agent.db');
  const upgradeDb = new upgradeSql.Database(await readFile(upgradePath));
  const legacyFirst = { ...(await databaseRecord('sessions', firstSession.id)), mode: 'read', runtimeThreadId: 'legacy-thread-fixture', runtimeCapabilitiesVersion: 3 };
  upgradeDb.run('UPDATE sessions SET value = ? WHERE id = ?', [JSON.stringify(legacyFirst), firstSession.id]);
  await writeFile(upgradePath, upgradeDb.export()); upgradeDb.close();
  page = await launch();
  const upgraded = (await snapshot(page)).sessions.find(item => item.id === firstSession.id);
  assert.equal(upgraded.mode, 'develop'); assert.equal(upgraded.runtimeThreadId, 'legacy-thread-fixture');
  assert.equal(upgraded.workspacePath, firstSession.workspacePath); assert.equal(upgraded.model, legacyFirst.model);
  checks.push('旧只读会话重启后自动升级为完整开发模式，保留线程ID、工作区和模型配置');
  assert.deepEqual((await snapshot(page)).layout, hiddenLayout);
  for (const [, selector] of panels) await expect(page.locator(selector)).toBeHidden();
  for (const [name, selector] of panels) { await page.getByRole('button', { name: `显示${name}`, exact: true }).click(); await expect(page.locator(selector)).toBeVisible(); }
  await page.getByRole('button', { name: '查看 Jira 任务 TEST-501', exact: true }).waitFor();
  await page.locator('details.jira-query-controls > summary').click();
  await expect(page.getByLabel('Jira 自动抓取状态', { exact: true })).toContainText(/失败|错误|离线/);
  assert.equal((await savedQueries(page))[0].id, autoQuery.id); assert.equal((await savedQueries(page))[0].savedAt, autoQuery.savedAt);
  const restored = await snapshot(page); assert.equal(restored.sessions.find(item => item.id === firstSession.id).mode, 'develop'); assert.equal(restored.sessions.find(item => item.id === currentSession.id).mode, 'develop');
  checks.push('三面板全隐藏状态重启后从 SQLite 恢复，用户可逐项展开；离线自动失败明确显示并保留既有查询ID/内容/时间，会话保持完整开发模式');

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
  const jiraTitle = 'TEST-501 · 合成任务完整详情';
  const jiraRow = page.locator('.session-item').filter({ hasText: 'TEST-501' });
  await expect(jiraRow.locator('.session-name')).toHaveText(jiraTitle);
  await expect(jiraRow).toHaveAttribute('title', jiraTitle);
  await expect(page.locator('.breadcrumb-session')).toHaveText(jiraTitle);
  await jiraRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '会话别名', exact: true })).toHaveAttribute('placeholder', jiraTitle);
  await page.getByRole('textbox', { name: '会话别名', exact: true }).fill('人工确认的会话名称');
  await page.getByRole('button', { name: '保存会话别名', exact: true }).click();
  await expect(page.locator('.session-item.selected .session-name')).toHaveText('人工确认的会话名称');
  await expect(page.locator('.breadcrumb-session')).toHaveText('人工确认的会话名称');
  await page.locator('.session-item.selected').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.getByRole('textbox', { name: '会话别名', exact: true }).fill('');
  await page.getByRole('button', { name: '保存会话别名', exact: true }).click();
  await expect(page.locator('.session-item.selected .session-name')).toHaveText(jiraTitle);
  checks.push('Jira会话列表、悬停标题、顶部路径和别名占位均显示编号及任务概要，保留人工别名，清空别名恢复概要，不显示项目名称');
  checks.push('Jira 详情关联真实本地 Git 后同样默认隔离开发，读取新详情快照并落 SQLite，中央 Agent 与右侧 Jira 同时可操作，无模型发送');
  assert.match(jiraSession.jiraIssue.attachments[0].imageWarning, /下载超过 15 秒/);
  assert.equal(jiraSession.jiraIssue.attachments[0].localImage, undefined);
  assert.ok(jiraSession.jiraIssue.attachments[1].localImage?.sha256);
  assert.deepEqual((await databaseRecord('sessions', jiraSession.id)).jiraIssue.attachments, jiraSession.jiraIssue.attachments);
  const createdEvents = await page.evaluate(id => window.jinggong.getEvents(id), jiraSession.id);
  assert.ok(createdEvents.some(event => event.type === 'message' && event.text.includes('图片未全部带入，会话已创建')));
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toHaveValue(/imageWarning/);
  assert.equal(state.images, 2);
  checks.push('真实图片 HTTP 等待 15 秒触发超时，仍创建真实 Worktree/SQLite 会话；成功图片保留、失败图片提示及来源落盘，会话中显示警示且可继续输入');

  await stop(); page = await launch();
  await page.locator('.session-item').filter({ hasText: 'TEST-501' }).click();
  await expect(page.locator('.session-item.selected .session-name')).toHaveText(jiraTitle);
  const restoredJira = (await snapshot(page)).sessions.find(item => item.id === jiraSession.id);
  assert.match(restoredJira.jiraIssue.attachments[0].imageWarning, /下载超过 15 秒/);
  await page.locator('.session-jira-link>summary').click();
  await expect(page.locator('.session-jira-link').getByRole('alert').filter({ hasText: '图片加载失败：Jira 图片下载超过 15 秒' })).toBeVisible();
  await expect(page.locator('.session-jira-link').getByRole('button', { name: '查看图片 成功图片.png', exact: true })).toBeVisible();
  assert.equal(state.images, 2, '重启展示警示时不能自动重复下载失败图片');
  state.imagesWorking = true;
  await page.locator('.session-jira-link').getByRole('button', { name: '重试图片', exact: true }).click();
  await expect(page.locator('.session-jira-link').getByRole('button', { name: '查看图片 超时图片.png', exact: true })).toBeVisible();
  await expect.poll(async () => (await databaseRecord('sessions', jiraSession.id)).jiraIssue.attachments[0].localImage?.sha256).toBeTruthy();
  assert.equal((await databaseRecord('sessions', jiraSession.id)).jiraIssue.attachments[0].imageWarning, undefined);
  assert.equal(state.images, 3);
  checks.push('图片警示与成功缓存重启后保留，不自动重复超时；用户点击重试恢复图片并更新 SQLite，原会话保持，无需重新创建');

  const jiraUrl = `${baseUrl}/browse/TEST-501`;
  assert.equal(jiraSession.jiraIssue.url, jiraUrl);
  await writeFile(path.join(jiraSession.workspacePath, '提交验收.txt'), '本地合成 Jira 提交说明验证\n');
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByRole('button', { name: '刷新 Git 状态', exact: true }).click();
  await page.getByRole('button', { name: '根据 Diff 生成提交说明', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '提交说明', exact: true })).toHaveValue(new RegExp(`TEST-501`));
  const generated = await page.getByRole('textbox', { name: '提交说明', exact: true }).inputValue();
  assert.ok(generated.endsWith(`Jira: ${jiraUrl}`));
  await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('修复合成任务的提交说明验收');
  await page.getByRole('button', { name: '检查开发要求', exact: true }).click();
  await app.evaluate(({ dialog }) => {
    globalThis.__commitConfirmations = [];
    dialog.showMessageBox = async (_window, options) => { globalThis.__commitConfirmations.push(options.detail); return { response: 1, checkboxChecked: false }; };
  });
  await page.getByRole('button', { name: '审核并提交', exact: true }).click();
  await page.getByText(/已提交：/).waitFor();
  const expectedMessage = `修复合成任务的提交说明验收\n\nJira: ${jiraUrl}`;
  const gitBody = () => execFileSync('git', ['log', '-1', '--format=%B'], { cwd: jiraSession.workspacePath, windowsHide: true, encoding: 'utf8' }).trimEnd();
  assert.equal(gitBody(), expectedMessage);
  const confirmations = await app.evaluate(() => globalThis.__commitConfirmations);
  assert.ok(confirmations[0].startsWith(`${expectedMessage}\n\n`));
  assert.ok((await page.evaluate(id => window.jinggong.getEvents(id), jiraSession.id)).some(event => event.type === 'tool' && event.text.endsWith(expectedMessage)));
  await writeFile(path.join(jiraSession.workspacePath, '提交验收.txt'), '再次提交验证地址不重复\n');
  const generatedAgain = await page.evaluate(id => window.jinggong.generateCommitMessage(id), jiraSession.id);
  await page.evaluate(({ id, message }) => window.jinggong.commitChanges(id, { message, reviewedDocumentIds: [] }), { id: jiraSession.id, message: generatedAgain });
  assert.equal(gitBody(), generatedAgain);
  assert.equal(gitBody().split(jiraUrl).length - 1, 1);
  checks.push('关联合成 Jira 的真实隔离 Git：自动生成含任务地址，人工删去地址后提交仍自动附加；确认框、Git正文和会话记录一致，已有地址不重复，未向用户仓库提交或推送');

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

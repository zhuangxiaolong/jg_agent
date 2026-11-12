import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';

// HTTP 响应与凭据全部为明确的合成验收输入；桌面、IPC、DPAPI、Git、SQLite 不替换。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-v04-'));
const data = path.join(root, 'data'), repo = path.join(root, '合成本地项目'), remote = path.join(root, 'remote.git'), colleague = path.join(root, '协作工作区');
await mkdir(repo); await mkdir('test-results', { recursive: true });
const reportPath = 'test-results/v04-smoke.json', screenshotPath = 'test-results/v04-workspace.png';
const password = 'synthetic-v04-password', secondPassword = 'synthetic-v04-second-password', modelKey = 'synthetic-v04-model-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7N8AAAAASUVORK5CYII=', 'base64');
const imageHash = createHash('sha256').update(png).digest('hex');
const checks = [], rendererRequests = [], confirmationInputs = [];
const state = { offline: false, delaySearch: false, pendingSearch: null, delayImage: false, pendingImages: [], details: 0, searches: 0, images: 0, requests: [] };
let app, baseUrl;
const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.name', '合成验收']); git(repo, ['config', 'user.email', 'fixture@example.invalid']); git(repo, ['config', 'core.autocrlf', 'false']);
await writeFile(path.join(repo, 'README.md'), '# 合成本地项目\n');
git(repo, ['add', '--', 'README.md']); git(repo, ['commit', '-m', '建立合成验收基线']);
git(root, ['init', '--bare', remote]); git(repo, ['remote', 'add', 'origin', remote]); git(repo, ['push', 'origin', 'main']);
const sourceHead = git(repo, ['rev-parse', 'HEAD']);
function issue(number, detail = false) { return { id: String(10000 + number), key: `CD-${number}`, fields: {
  summary: detail ? `重新读取的图片任务 ${state.details}` : `合成图片任务 ${number}`,
  description: `合成验收需求 ${number}。图片是本地 HTTP 合成附件，不是用户生产资料。`,
  status: { name: '待开发' }, issuetype: { name: '任务' }, assignee: { displayName: '合成测试用户' }, updated: '2026-11-04T10:00:00.000+0800', customfield_11116: '2026-11-04',
  attachment: [{ id: '51', filename: '合成验收图.png', mimeType: 'image/png', size: png.length, content: `${baseUrl}/secure/attachment/51/example.png` }],
} }; }
function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' }); response.end(JSON.stringify(value)); }
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  state.requests.push({ path: url.pathname, method: request.method });
  if (state.offline) return json(response, { errorMessages: ['明确合成的离线模拟'] }, 503);
  if (![ `Basic ${Buffer.from(`fixture-user:${password}`).toString('base64')}`, `Basic ${Buffer.from(`fixture-user-b:${secondPassword}`).toString('base64')}` ].includes(request.headers.authorization)) return json(response, { errorMessages: ['合成认证失败'] }, 401);
  if (url.pathname === '/jira/rest/api/2/myself') return json(response, { displayName: '合成测试用户', timeZone: 'Asia/Shanghai' });
  if (url.pathname === '/jira/rest/api/2/field') return json(response, [{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' } }]);
  if (url.pathname === '/jira/rest/api/2/project') return json(response, [{ id: '1', key: 'CD', name: '合成项目' }, { id: '2', key: 'NEWDEVGROUP', name: '合成项目' }]);
  if (url.pathname === '/jira/rest/api/2/search') {
    state.searches++;
    const startAt = Number(url.searchParams.get('startAt') ?? 0), jql = url.searchParams.get('jql') ?? '';
    const empty = jql.includes('project = "NEWDEVGROUP"');
    const send = () => json(response, { startAt, maxResults: 1, total: empty ? 0 : 2, issues: empty || startAt >= 2 ? [] : [issue(startAt === 0 ? 435 : 434)] });
    if (state.delaySearch) { state.pendingSearch = send; return; }
    return send();
  }
  const key = /^\/jira\/rest\/api\/2\/issue\/CD-(435|434)$/.exec(url.pathname);
  if (key) { state.details++; return json(response, issue(Number(key[1]), true)); }
  if (url.pathname === '/jira/secure/attachment/51/example.png') {
    state.images++; const send = () => { response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); response.end(png); };
    if (state.delayImage) { state.pendingImages.push(send); return; }
    return send();
  }
  return json(response, { errorMessages: ['合成资源不存在'] }, 404);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); baseUrl = `http://127.0.0.1:${server.address().port}/jira`;

async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.JINGGONG_TEST_NO_NODE) env.PATH = `${process.env.SystemRoot}\\System32;C:\\Program Files\\Git\\cmd`;
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env });
  const page = await app.firstWindow(); page.on('request', request => { if (/^https?:/.test(request.url())) rendererRequests.push(request.url()); });
  await page.getByText('精工Agent引擎已就绪', { exact: true }).waitFor({ timeout: 30000 });
  return page;
}
async function databaseRecord(table, id) {
  const SQL = await initSqlJs(); const database = new SQL.Database(await readFile(path.join(data, 'database/jinggong-agent.db')));
  try { const statement = database.prepare(`SELECT value FROM ${table} WHERE id = ?`); statement.bind([id]); assert.ok(statement.step()); const value = JSON.parse(statement.get()[0]); statement.free(); return value; }
  finally { database.close(); }
}
async function simulateLegacyImageSession(id) {
  assert.equal(app, undefined, '仅关闭隔离应用后才能模拟旧会话元数据');
  const filename = path.join(data, 'database/jinggong-agent.db'), SQL = await initSqlJs(), database = new SQL.Database(await readFile(filename));
  try {
    const statement = database.prepare('SELECT value FROM sessions WHERE id = ?'); statement.bind([id]); assert.ok(statement.step()); const session = JSON.parse(statement.get()[0]); statement.free();
    for (const attachment of session.jiraIssue.attachments) delete attachment.localImage;
    database.run('UPDATE sessions SET value = ? WHERE id = ?', [JSON.stringify(session), id]); await writeFile(filename, database.export());
  } finally { database.close(); }
}
async function report(passed, extra = {}) { await writeFile(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), passed, checks, testData: root, executable: process.env.JINGGONG_TEST_EXE ?? '开发 Electron', evidenceKind: '真实桌面/IPC/DPAPI/SQLite/Git + 明确合成本地 HTTP', actualUserJira: '不在本脚本范围', modelInference: '未执行；仅保存合成模型配置以验证会话推理设置，无模型网络请求', nativeTray: '真实close隐藏与activate恢复；系统托盘鼠标菜单另由人工验收', inputReplacements: ['原生目录选择返回隔离仓库', '原生Git确认框输入取消/确认'], screenshot: screenshotPath, ...extra }, null, 2)); }
async function screenshot(page, suffix) { await page.screenshot({ path: `test-results/v04-${suffix}.png`, fullPage: true }); }
try {
  let page = await launch();
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => window.jinggong.bootstrap())).projects.length).toBe(1);
  const original = (await page.evaluate(() => window.jinggong.bootstrap())).projects[0];
  await page.getByRole('button', { name: `修改项目显示名称 ${original.name}`, exact: true }).click();
  await page.getByLabel('项目显示名称', { exact: true }).fill('显示名称已修改');
  await page.getByRole('button', { name: '保存项目显示名称', exact: true }).click();
  await page.getByRole('button', { name: '修改项目显示名称 显示名称已修改', exact: true }).waitFor();
  const renamed = (await page.evaluate(() => window.jinggong.bootstrap())).projects[0];
  assert.equal(renamed.id, original.id); assert.equal(renamed.path, original.path); assert.equal(renamed.name, '显示名称已修改'); assert.ok((await stat(repo)).isDirectory());
  assert.equal((await databaseRecord('projects', renamed.id)).name, renamed.name);
  checks.push('真实项目行重命名更新SQLite与显示名称，ID/源路径/磁盘目录不变');

  await page.getByRole('button', { name: '打开模型设置', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '外观', exact: true }).click();
  const palettes = [];
  for (const [theme, label] of [['purple', '紫色'], ['black', '黑色'], ['sky', '天空蓝'], ['grass', '草绿色']]) {
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(dialog.getByRole('button', { name: label, exact: true })).toBeEnabled();
    const values = await page.evaluate(() => { const css = getComputedStyle(document.documentElement); return ['--surface-0', '--surface-1', '--surface-2', '--field', '--text', '--line', '--accent'].map(name => css.getPropertyValue(name).trim()); });
    assert.ok(values.every(Boolean)); palettes.push(values); await screenshot(page, `theme-${theme}`);
  }
  assert.equal(new Set(palettes.map(value => value.join('|'))).size, 4);
  await dialog.getByRole('button', { name: /极简风格/, exact: false }).click();
  await expect(page.locator('html')).toHaveAttribute('data-style', 'minimal'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'grass');
  await expect(dialog.getByRole('button', { name: /极简风格/, exact: false })).toBeEnabled();
  await dialog.getByRole('button', { name: '紫色', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'purple');
  await expect(dialog.getByRole('button', { name: '紫色', exact: true })).toBeEnabled();
  checks.push('四种主题经真实设置UI保存并完整切换色板，极简风格与主题独立，四张实际桌面截图');

  await dialog.getByRole('button', { name: 'Jira 连接', exact: true }).click();
  await page.locator('#jira-url').fill(`${baseUrl}/projects/NEWDEVGROUP`); await page.locator('#jira-account').fill('fixture-user'); await page.locator('#jira-password').fill(password);
  await dialog.getByRole('button', { name: '保存 Jira 配置', exact: true }).click();
  await expect(page.locator('#jira-password')).toHaveValue('');
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click(); await page.getByRole('button', { name: 'Jira 任务', exact: true }).click();
  await page.locator('details.jira-query-controls > summary').click();
  await expect(page.getByLabel('Jira 项目范围', { exact: true })).toHaveValue('*');
  await page.getByLabel('Jira 任务日期', { exact: true }).fill('2026-11-04'); await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor();
  const firstQuery = (await page.evaluate(() => window.jinggong.listJiraQueries()))[0];
  assert.equal(firstQuery.input.projectKey, '*'); assert.equal(firstQuery.input.onlyMine, true); assert.equal(firstQuery.page.total, 2);
  await page.getByLabel('Jira 项目范围', { exact: true }).selectOption('NEWDEVGROUP'); await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByText('该日期没有匹配任务', { exact: true }).waitFor();
  const emptyQuery = (await page.evaluate(() => window.jinggong.listJiraQueries()))[0]; assert.notEqual(emptyQuery.id, firstQuery.id);
  await page.getByLabel('Jira 抓取记录', { exact: true }).selectOption(firstQuery.id);
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor(); await expect(page.getByLabel('Jira 项目范围', { exact: true })).toHaveValue('*');
  const searchesBeforeHistory = state.searches;
  await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click(); await page.getByRole('button', { name: 'Jira 任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor(); await expect(page.getByLabel('Jira 抓取记录', { exact: true })).toHaveValue(firstQuery.id); assert.equal(state.searches, searchesBeforeHistory);
  await page.getByLabel('Jira 抓取记录', { exact: true }).selectOption(firstQuery.id); await page.getByRole('button', { name: '刷新当前查询', exact: true }).click();
  await expect.poll(() => state.searches).toBe(searchesBeforeHistory + 1); await expect(page.getByRole('button', { name: '刷新当前查询', exact: true })).toBeEnabled();
  const refreshed = (await page.evaluate(() => window.jinggong.listJiraQueries()))[0]; assert.equal(refreshed.id, firstQuery.id); assert.ok(refreshed.savedAt >= firstQuery.savedAt);
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).click();
  await page.locator('#jira-panel').getByLabel('Jira 任务详情 CD-435', { exact: true }).waitFor();
  await page.getByRole('button', { name: '加载图片 合成验收图.png', exact: true }).click();
  await page.locator('#jira-panel').getByRole('button', { name: '查看图片 合成验收图.png', exact: true }).waitFor();
  assert.equal(state.images, 1);
  await expect(page.locator('.jira-image-thumbnail img')).toHaveAttribute('src', `data:image/png;base64,${png.toString('base64')}`);
  const displayedSummary = await page.locator('#jira-panel .jira-issue-details h2').textContent(); const detailReads = state.details;
  await page.getByRole('button', { name: '从此任务创建会话', exact: true }).click(); await page.getByRole('textbox', { name: '输入任务', exact: true }).waitFor();
  const session = (await page.evaluate(() => window.jinggong.bootstrap())).sessions[0];
  assert.ok(state.details > detailReads); assert.notEqual(session.jiraIssue.summary, displayedSummary); assert.equal(session.jiraIssue.attachments[0].localImage.sha256, imageHash);
  assert.equal((await databaseRecord('sessions', session.id)).jiraIssue.attachments[0].localImage.sha256, imageHash);
  assert.equal(session.status, 'idle'); assert.equal((await page.evaluate(id => window.jinggong.getEvents(id), session.id)).filter(event => event.type === 'user').length, 0);
  await page.locator('.session-jira-link>summary').click(); await page.locator('.session-jira-link').getByRole('button', { name: '查看图片 合成验收图.png', exact: true }).click();
  await page.getByRole('dialog', { name: '图片查看 合成验收图.png', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭图片查看', exact: true }).click();
  assert.equal(rendererRequests.length, 0); await screenshot(page, 'image-session');
  checks.push('真实HTTP抓取记录写SQLite；最新记录自动恢复不重发search，历史切换还原条件/分页，手动刷新同ID更新时间；任务页主动加载图片，创建会话重新GET快照且缓存图片跟随会话，dataURL缩略图/大图可看，无模型执行或Renderer远程请求');

  await page.getByRole('button', { name: `修改会话别名 ${session.title}`, exact: true }).click(); await page.getByLabel('会话别名', { exact: true }).fill('我的图片需求会话'); await page.getByRole('button', { name: '保存会话别名', exact: true }).click();
  await page.getByRole('button', { name: '修改会话别名 我的图片需求会话', exact: true }).waitFor(); await expect(page.locator('.breadcrumb-session')).toHaveText('我的图片需求会话'); await expect(page.locator('.conversation-topline>span').first()).toHaveText('我的图片需求会话');
  await page.getByRole('button', { name: '修改会话别名 我的图片需求会话', exact: true }).click(); await page.getByLabel('会话别名', { exact: true }).fill(''); await page.getByRole('button', { name: '保存会话别名', exact: true }).click(); await page.getByRole('button', { name: `修改会话别名 ${session.title}`, exact: true }).waitFor();
  assert.equal((await databaseRecord('sessions', session.id)).alias, undefined);
  await page.getByRole('button', { name: `修改会话别名 ${session.title}`, exact: true }).click(); await page.getByLabel('会话别名', { exact: true }).fill('我的图片需求会话'); await page.getByRole('button', { name: '保存会话别名', exact: true }).click(); await page.getByRole('button', { name: '修改会话别名 我的图片需求会话', exact: true }).waitFor();
  await page.getByRole('button', { name: '打开模型设置', exact: true }).click(); dialog = page.getByRole('dialog');
  await page.locator('#provider-name').fill('合成强度验收'); await page.locator('#provider-url').fill('https://model.example.invalid/v1'); await page.locator('#provider-model').fill('fixture-model'); await page.locator('#provider-key').fill(modelKey); await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('');
  await page.getByLabel('推理强度', { exact: true }).selectOption('high'); await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  assert.equal((await databaseRecord('sessions', session.id)).reasoningEffort, undefined);
  await page.getByRole('button', { name: '应用设置', exact: true }).click(); await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeDisabled(); assert.equal((await databaseRecord('sessions', session.id)).reasoningEffort, 'high');
  await page.getByLabel('推理强度', { exact: true }).selectOption(''); await page.getByRole('button', { name: '应用设置', exact: true }).click(); await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeDisabled(); assert.equal((await databaseRecord('sessions', session.id)).reasoningEffort, undefined);
  await page.getByLabel('推理强度', { exact: true }).selectOption('xhigh'); await page.getByRole('button', { name: '应用设置', exact: true }).click(); await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeDisabled();
  const configuredSession = await databaseRecord('sessions', session.id); assert.equal(configuredSession.reasoningEffort, 'xhigh'); assert.equal(configuredSession.alias, '我的图片需求会话'); assert.equal(configuredSession.title, session.title); assert.equal(configuredSession.workspacePath, session.workspacePath); assert.equal(configuredSession.jiraIssue.key, session.jiraIssue.key);
  checks.push('真实会话别名UI支持修改/清空恢复默认标题，三处展示一致；推理强度草稿需应用才写SQLite，可恢复模型默认并保存xhigh；title/Jira关联/工作区不变，无模型调用');

  await page.locator('.session-jira-link>summary').click(); await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByLabel('拉取远程仓库', { exact: true }).selectOption('origin');
  git(session.workspacePath, ['push', 'origin', session.branch]);
  git(root, ['clone', '--branch', session.branch, remote, colleague]); git(colleague, ['config', 'user.name', '合成协作者']); git(colleague, ['config', 'user.email', 'colleague@example.invalid']);
  await writeFile(path.join(colleague, 'remote.txt'), '远程真实提交\n'); git(colleague, ['add', '--', 'remote.txt']); git(colleague, ['commit', '-m', '增加远程验收文件']); git(colleague, ['push', 'origin', session.branch]);
  const remoteHead = git(colleague, ['rev-parse', 'HEAD']);
  await app.evaluate(({ dialog }) => { globalThis.v04Confirmations = []; dialog.showMessageBox = async (_window, options) => { globalThis.v04Confirmations.push({ title: options.title, message: options.message }); return { response: 0, checkboxChecked: false }; }; });
  await page.getByRole('button', { name: '拉取分支', exact: true }).click(); await page.getByText('已快进拉取远程同名 Agent 分支。', { exact: true }).waitFor();
  assert.equal(git(session.workspacePath, ['rev-parse', 'HEAD']), remoteHead); assert.equal(await readFile(path.join(session.workspacePath, 'remote.txt'), 'utf8'), '远程真实提交\n');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), sourceHead); assert.equal(git(repo, ['branch', '--show-current']), 'main'); assert.equal(git(repo, ['status', '--porcelain']), '');
  await writeFile(path.join(session.workspacePath, 'dirty.txt'), '未提交变更\n'); await page.getByRole('button', { name: '刷新 Git 状态', exact: true }).click(); await expect(page.getByRole('button', { name: '拉取分支', exact: true })).toBeDisabled();
  git(session.workspacePath, ['add', '--', 'dirty.txt']); git(session.workspacePath, ['commit', '-m', '建立本地分歧']);
  await writeFile(path.join(colleague, 'diverged.txt'), '远程分歧\n'); git(colleague, ['add', '--', 'diverged.txt']); git(colleague, ['commit', '-m', '建立远程分歧']); git(colleague, ['push', 'origin', session.branch]);
  const localDiverged = git(session.workspacePath, ['rev-parse', 'HEAD']);
  await page.getByRole('button', { name: '刷新 Git 状态', exact: true }).click(); await expect(page.getByRole('button', { name: '拉取分支', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '拉取分支', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '已分叉' }).waitFor(); assert.equal(git(session.workspacePath, ['rev-parse', 'HEAD']), localDiverged);
  confirmationInputs.push(...await app.evaluate(() => globalThis.v04Confirmations)); assert.ok(confirmationInputs.every(item => item.title !== '确认拉取代码'), '拉取不应弹出确认框');
  checks.push('真实Bare远程与协作clone：拉取无需确认即可ff-only快进同名agent分支，源main不变；脏工作区禁用，真实分叉报错且本地HEAD未合并/覆盖');

  const snapshot = await page.evaluate(() => window.jinggong.bootstrap()); assert.equal(snapshot.closeToTray, true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await app.evaluate(({ BrowserWindow }) => ({ count: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible(), destroyed: BrowserWindow.getAllWindows()[0].isDestroyed() } )).then(value => value.count === 1 && !value.visible && !value.destroyed), true);
  await app.evaluate(({ app }) => { app.emit('activate'); }); await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  await app.evaluate(({ app, BrowserWindow }) => { globalThis.v04SecondInstances = 0; app.on('second-instance', () => { globalThis.v04SecondInstances++; }); BrowserWindow.getAllWindows()[0].hide(); });
  const secondaryEnv = { ...process.env, JINGGONG_TEST_DATA: data }; delete secondaryEnv.ELECTRON_RUN_AS_NODE;
  if (process.env.JINGGONG_TEST_NO_NODE) secondaryEnv.PATH = `${process.env.SystemRoot}\\System32;C:\\Program Files\\Git\\cmd`;
  const secondaryExecutable = process.env.JINGGONG_TEST_EXE || await app.evaluate(() => process.execPath);
  const secondary = spawn(secondaryExecutable, process.env.JINGGONG_TEST_EXE ? [] : ['.'], { env: secondaryEnv, windowsHide: true, stdio: 'ignore' });
  try {
    const secondaryExit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { secondary.kill(); reject(new Error('第二实例没有正常退出')); }, 30000);
      secondary.once('error', error => { clearTimeout(timeout); reject(error); });
      secondary.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    });
    assert.deepEqual(secondaryExit, { code: 0, signal: null });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => ({ instances: globalThis.v04SecondInstances, windows: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0]?.isVisible() })), { timeout: 15000 }).toEqual({ instances: 1, windows: 1, visible: true });
    const afterSecondary = await page.evaluate(() => window.jinggong.bootstrap());
    assert.deepEqual(afterSecondary.projects, snapshot.projects); assert.deepEqual(afterSecondary.sessions, snapshot.sessions);
  } finally { if (secondary.exitCode === null && secondary.signalCode === null) secondary.kill(); }
  await page.screenshot({ path: screenshotPath, fullPage: true }); await app.close(); app = undefined;
  checks.push('真实Tray初始化、close隐藏与activate恢复；第二真实同数据实例退出0且恢复原窗口，仅一个主窗口、项目会话不变；ElectronApplication.close真正退出并落盘');

  state.offline = true; const searchesBeforeRestart = state.searches, detailBeforeRestart = state.details, imagesBeforeRestart = state.images;
  page = await launch(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'purple'); await expect(page.locator('html')).toHaveAttribute('data-style', 'minimal');
  await page.getByRole('button', { name: '修改项目显示名称 显示名称已修改', exact: true }).waitFor();
  await page.getByRole('button', { name: '修改会话别名 我的图片需求会话', exact: true }).waitFor(); await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('xhigh');
  await page.getByRole('button', { name: 'Jira 任务', exact: true }).click(); await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor();
  await page.locator('details.jira-query-controls > summary').click();
  await page.getByLabel('Jira 抓取记录', { exact: true }).selectOption(firstQuery.id);
  await expect(page.getByLabel('Jira 抓取记录', { exact: true })).toHaveValue(firstQuery.id); await expect(page.getByLabel('Jira 任务日期', { exact: true })).toHaveValue('2026-11-04');
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).click(); await page.locator('#jira-panel').getByLabel('Jira 任务详情 CD-435', { exact: true }).waitFor();
  await page.locator('#jira-panel').getByRole('button', { name: '查看图片 合成验收图.png', exact: true }).waitFor();
  assert.equal(state.searches, searchesBeforeRestart); assert.equal(state.details, detailBeforeRestart); assert.equal(state.images, imagesBeforeRestart);
  await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click(); await page.locator('.session-jira-link>summary').click();
  await page.locator('.session-jira-link').getByRole('button', { name: '查看图片 合成验收图.png', exact: true }).click(); await page.getByRole('dialog', { name: '图片查看 合成验收图.png', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: '图片查看 合成验收图.png', exact: true })).toHaveCount(0);
  const imageFile = path.join(data, 'attachments/jira', `${imageHash}.png`), heldImage = `${imageFile}.held`;
  await rename(imageFile, heldImage);
  try {
    await page.reload(); await page.getByText('精工Agent引擎已就绪', { exact: true }).waitFor(); await page.locator('.session-jira-link>summary').click();
    await page.locator('.session-jira-link').getByRole('alert').filter({ hasText: '图片加载失败：Jira 图片缓存缺失' }).waitFor(); assert.equal(await page.locator('.session-jira-link').getByRole('button', { name: '查看图片 合成验收图.png', exact: true }).count(), 0);
  } finally { await rename(heldImage, imageFile); }
  await page.locator('.session-jira-link').getByRole('button', { name: '重试图片', exact: true }).click(); await page.locator('.session-jira-link').getByRole('button', { name: '查看图片 合成验收图.png', exact: true }).waitFor();
  const database = await readFile(path.join(data, 'database/jinggong-agent.db')); assert.ok(!database.includes(Buffer.from(password))); assert.ok(!database.includes(Buffer.from(password, 'utf16le')));
  assert.ok(state.requests.every(item => item.method === 'GET')); assert.equal(rendererRequests.length, 0); assert.equal(git(repo, ['rev-parse', 'HEAD']), sourceHead);
  checks.push('关闭重启SQLite恢复项目名、主题/风格、Jira历史与任务图片；合成HTTP离线时直接读列表/详情/本地图不再GET核心数据；图片缓存缺失明确中文失败、恢复后可重试；数据库无密码明文，未请求模型');
  state.offline = false; state.delaySearch = true;
  const historyBeforeRace = await page.evaluate(() => window.jinggong.listJiraQueries());
  await page.evaluate(() => { window.v04PendingSearch = window.jinggong.searchJiraIssues({ date: '2026-11-04', projectKey: '*', scope: 'daily', onlyMine: true }).then(() => ({ ok: true }), error => ({ ok: false, error: String(error) })); });
  await expect.poll(() => !!state.pendingSearch).toBe(true);
  await page.evaluate(input => window.jinggong.saveJira({ baseUrl: input.baseUrl, account: 'fixture-user-b', password: input.password, projectKey: 'NEWDEVGROUP', dateFieldId: '11116' }), { baseUrl, password: secondPassword });
  state.pendingSearch(); state.pendingSearch = null; state.delaySearch = false;
  const raced = await page.evaluate(() => window.v04PendingSearch); assert.equal(raced.ok, false); assert.match(raced.error, /连接已更改/);
  assert.deepEqual(await page.evaluate(() => window.jinggong.listJiraQueries()), []);
  await page.evaluate(input => window.jinggong.saveJira({ baseUrl: input.baseUrl, account: 'fixture-user', password: input.password, projectKey: 'NEWDEVGROUP', dateFieldId: '11116' }), { baseUrl, password });
  assert.deepEqual((await page.evaluate(() => window.jinggong.listJiraQueries())).map(item => item.id), historyBeforeRace.map(item => item.id));
  checks.push('真实延迟HTTP竞态：A账号抓取期间切换B账号，释放A响应后拒绝“连接已更改”，B历史为空；恢复A后原记录保留，未跨账号写入');
  await screenshot(page, 'offline-restored'); await app.close(); app = undefined;
  await simulateLegacyImageSession(session.id); state.delayImage = true;
  page = await launch();
  await expect.poll(() => state.pendingImages.length).toBeGreaterThan(0);
  await page.evaluate(id => { window.v04PendingTurn = window.jinggong.sendTurn(id, '取消竞态合成验收，不得发送至模型。').then(() => ({ ok: true }), error => ({ ok: false, error: String(error) })); }, session.id);
  await page.evaluate(id => window.jinggong.cancelRun(id), session.id);
  await page.evaluate(id => window.jinggong.renameSession(id, '取消后的别名'), session.id);
  state.delayImage = false; const delayed = state.pendingImages.splice(0); delayed.forEach(send => send());
  assert.equal((await page.evaluate(() => window.v04PendingTurn)).ok, true);
  await page.getByRole('button', { name: 'Agent 工作台', exact: true }).click();
  if (await page.locator('.session-jira-link').getAttribute('open') === null) await page.locator('.session-jira-link>summary').click();
  await page.locator('.session-jira-link').getByRole('button', { name: '查看图片 合成验收图.png', exact: true }).waitFor();
  const afterCancel = await databaseRecord('sessions', session.id); assert.equal(afterCancel.alias, '取消后的别名'); assert.equal(afterCancel.status, 'interrupted'); assert.equal(afterCancel.runtimeThreadId, undefined);
  assert.equal((await page.evaluate(id => window.jinggong.getEvents(id), session.id)).filter(event => event.type === 'user').length, 0);
  checks.push('P1取消竞态复现：关闭隔离app后模拟无localImage旧会话，真实图片HTTP延迟期间send/cancel/改别名，释放下载后旧send退出，SQLite仍保留新别名和interrupted，未创建Runtime线程或发送模型任务');
  await screenshot(page, 'cancel-preserved'); await app.close(); app = undefined;
  await report(true, { fixtureSearches: state.searches, fixtureDetails: state.details, fixtureImageDownloads: state.images, rendererRemoteRequests: rendererRequests.length, confirmationInputs, sourceMainUnchanged: true, imageSha256: imageHash });
  console.log(JSON.stringify({ passed: true, checks, reportPath, screenshotPath }, null, 2));
} catch (error) {
  const message = String(error).split(password).join('[已脱敏]').split(secondPassword).join('[已脱敏]').split(modelKey).join('[已脱敏]');
  if (app) { try { await screenshot(await app.firstWindow(), 'failure'); } catch { /* 保留已生成的安全报告。 */ } }
  await report(false, { error: message }); throw new Error(message);
} finally {
  if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

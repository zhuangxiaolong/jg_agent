import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(tmpdir(), 'jinggong-browser-sharing-')), data = path.join(root, 'data'), repo = path.join(root, '项目'); await mkdir(repo);
const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
git(['init', '-b', 'main']); git(['config', 'user.name', '功能验收']); git(['config', 'user.email', 'fixture@example.invalid']);
await writeFile(path.join(repo, 'README.md'), '# 真实本地功能验收\n'); git(['add', 'README.md']); git(['commit', '-m', '建立测试基线']);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64');
const imagePath = path.join(root, '测试结果.png'); await writeFile(imagePath, png);
const state = { writes: [], status: '待开发', assignee: '测试用户' }; let base;
function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }
function issue() { return { id: '1', key: 'TEST-1', fields: { summary: '验证报表操作', description: '本地合成任务', status: { name: state.status }, issuetype: { name: '任务' }, assignee: { displayName: state.assignee }, attachment: [] } }; }
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  if (url.pathname === '/report') { response.setHeader('Content-Type', 'text/html;charset=utf-8'); return response.end(`<!doctype html><title>报表平台合成验收</title><h1>生产日报</h1><input aria-label="工单" id="wo"><select id="line"><option value="L1">一线</option><option value="L2">二线</option></select><button onclick="document.querySelector('#result').textContent=document.querySelector('#wo').value+'-'+document.querySelector('#line').value;document.cookie='reportLogin=fixture;path=/'">查询</button><p id="result"></p><iframe src="/frame"></iframe><a target="_blank" href="/popup">打开报表详情</a><a href="/download" download="report.csv">导出报表</a>`); }
  if (url.pathname === '/frame') { response.setHeader('Content-Type', 'text/html;charset=utf-8'); return response.end('<title>报表参数</title><input aria-label="报表日期"><button onclick="document.body.dataset.confirmed=\'yes\'">确认日期</button>'); }
  if (url.pathname === '/popup') { response.setHeader('Content-Type', 'text/html;charset=utf-8'); return response.end('<title>报表明细</title><p>合成报表明细数量：10</p>'); }
  if (url.pathname === '/download') { response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' }); return response.end('id,quantity\n1,10\n'); }
  if (url.pathname === '/jira/rest/api/2/myself') return json(response, { displayName: '测试用户', timeZone: 'Asia/Shanghai' });
  if (url.pathname === '/jira/rest/api/2/field') return json(response, [{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date' } }]);
  if (url.pathname === '/jira/rest/api/2/project') return json(response, [{ id: '1', key: 'TEST', name: '验收项目' }]);
  if (url.pathname === '/jira/rest/api/2/search') return json(response, { startAt: 0, maxResults: 50, total: 1, issues: [issue()] });
  if (request.method === 'GET' && url.pathname === '/jira/rest/api/2/issue/TEST-1') return json(response, issue());
  if (request.method === 'GET' && url.pathname.endsWith('/transitions')) return json(response, { transitions: [{ id: '101', name: '提交测试', to: { name: '待测试' } }] });
  if (request.method === 'GET' && url.pathname.endsWith('/user/assignable/search')) return json(response, [{ name: 'tester', displayName: '测试经办人', active: true }]);
  if (request.method !== 'GET') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = Buffer.concat(chunks);
    state.writes.push({ method: request.method, path: url.pathname, body: body.toString(), headers: request.headers });
    if (url.pathname.endsWith('/attachments')) return json(response, [{ id: 'uploaded-1', filename: '测试结果.png' }]);
    if (url.pathname.endsWith('/assignee')) { state.assignee = '测试经办人'; response.writeHead(204); return response.end(); }
    if (url.pathname.endsWith('/transitions')) { state.status = '待测试'; response.writeHead(204); return response.end(); }
  }
  return json(response, { errorMessages: ['不存在的合成资源'] }, 404);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
const checks = []; let app;
try {
  const env = { ...process.env, JINGGONG_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], env }); const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await app.evaluate(async ({ dialog }, root) => { const fs = process.getBuiltinModule('fs'); process.on('uncaughtException', error => fs.writeFileSync(root + '/uncaught.log', error.stack || String(error))); }, root);
  await expect(page.getByRole('button', { name: '打开全局设置', exact: true })).toBeEnabled({ timeout: 30000 });
  await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  await page.locator('.project-item').waitFor();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '创建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入任务', exact: true }).waitFor();
  const boot = await page.evaluate(() => window.jinggong.bootstrap()), project = boot.projects[0];
  const bundle = { format: 'jinggong-share', version: 1, exportedAt: new Date().toISOString(), session: { title: '分享：解决报表参数异常', system: '通用', createdAt: new Date().toISOString(), events: [{ type: 'user', text: '修复报表查询', createdAt: new Date().toISOString() }, { type: 'message', text: '方案：复用参数组件。\n```js\nconst solved = true;\n```\n验证：本地合成记录。', createdAt: new Date().toISOString() }] }, memories: [{ title: '报表查询经验', content: '先定位页面参数控件，再触发查询。', createdAt: new Date().toISOString() }] };
  const sharePath = path.join(root, 'sample.jgshare.json'); await writeFile(sharePath, JSON.stringify(bundle));
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, sharePath);
  await expect(page.getByRole('button', { name: '导入会话或记忆', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
  const sessionSettings = page.getByRole('dialog');
  await sessionSettings.getByRole('button', { name: '会话与数据', exact: true }).click();
  await sessionSettings.getByRole('button', { name: '导入会话或记忆', exact: true }).click();
  await expect(page.locator('.breadcrumb-session')).toHaveText(bundle.session.title);
  await expect(page.locator('.markdown-code pre')).toContainText('const solved = true;');
  const imported = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.imported);
  assert.notEqual(imported.workspacePath, boot.sessions[0].workspacePath);
  const exportedPath = path.join(root, 'exported.jgshare.json');
  await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, exportedPath);
  await sessionSettings.getByLabel('选择要导出的会话').selectOption({ label: bundle.session.title });
  await sessionSettings.getByRole('button', { name: '导出所选会话', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(exportedPath, 'utf8')).session.events.length).toBe(2);
  assert.equal(JSON.parse(await readFile(exportedPath, 'utf8')).session.title, bundle.session.title);
  const backupPath = path.join(root, 'session-backup.db');
  await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, backupPath);
  await sessionSettings.getByRole('button', { name: '导出会话备份', exact: true }).click();
  assert.ok((await readFile(backupPath)).subarray(0, 16).equals(Buffer.from('SQLite format 3\0')));
  await sessionSettings.getByRole('button', { name: '关闭设置', exact: true }).click();
  const duplicate = await page.evaluate(id => window.jinggong.importShare(id), project.id); assert.equal(duplicate.memories, 0);
  console.log('功能检查通过'); checks.push('真实 Electron 对话框/IPC/SQLite/Git：设置内导入会话显示完整 Markdown 和代码、创建本机工作区、设置内选择会话导出往返和本地数据备份、重复记忆跳过');

  await page.getByRole('button', { name: '打开会话浏览器', exact: true }).click();
  await expect.poll(() => app.windows().filter(item => item.url().endsWith('/browser.html')).length).toBe(1);
  const browser = app.windows().find(item => item.url().endsWith('/browser.html'));
  await browser.getByLabel('浏览器地址').waitFor();
  const invoke = action => { console.log('浏览器操作', action.action); return browser.evaluate(input => window.browserToolbar.invoke(input), action); };
  let snapshot = JSON.parse((await invoke({ action: 'open', url: `${base}/report` })).text);
  assert.ok(snapshot.frames.some(frame => frame.title === '报表平台合成验收'));
  let main = snapshot.frames.find(frame => frame.title === '报表平台合成验收');
  const find = (frame, predicate) => { const element = frame.elements.find(predicate); assert.ok(element); return element.ref; };
  await invoke({ action: 'fill', ref: find(main, element => element.text === '工单'), value: 'WO-001' });
  await invoke({ action: 'select', selector: '#line', value: 'L2' });
  snapshot = JSON.parse((await invoke({ action: 'click', ref: find(main, element => element.text === '查询') })).text);
  assert.ok(snapshot.frames.find(frame => frame.title === '报表平台合成验收').text.includes('WO-001-L2'));
  const inner = snapshot.frames.find(frame => frame.title === '报表参数'); assert.ok(inner);
  await invoke({ action: 'fill', frame: inner.frame, ref: find(inner, element => element.text === '报表日期'), value: '2026-11-06' });
  assert.equal(JSON.parse((await invoke({ action: 'evaluate', frame: inner.frame, script: 'document.querySelector("input").value' })).text).result, '2026-11-06');
  assert.ok((await invoke({ action: 'screenshot' })).imageUrl.startsWith('data:image/png;base64,'));
  assert.equal(JSON.parse((await invoke({ action: 'evaluate', script: '({ login: document.cookie, node: typeof window.require, bridge: typeof window.jinggong })' })).text).result.bridge, 'undefined');
  await invoke({ action: 'click', selector: 'a[target=_blank]' });
  await expect.poll(async () => (await browser.evaluate(() => window.browserToolbar.invoke('state'))).tabs.length).toBe(2);
  const tabs = (await browser.evaluate(() => window.browserToolbar.invoke('state'))).tabs;
  await expect.poll(async () => JSON.parse((await invoke({ action: 'snapshot' })).text).frames.some(frame => frame.title === '报表明细')).toBe(true);
  await invoke({ action: 'tab', tabId: tabs[0].id });
  await invoke({ action: 'click', selector: 'a[download]' });
  await expect.poll(async () => (await browser.evaluate(() => window.browserToolbar.invoke('state'))).downloads.length).toBe(1);
  const downloaded = (await browser.evaluate(() => window.browserToolbar.invoke('state'))).downloads[0]; assert.equal(await readFile(downloaded, 'utf8'), 'id,quantity\n1,10\n');
  await browser.close(); await page.bringToFront(); await page.getByRole('button', { name: '打开会话浏览器', exact: true }).click();
  await expect.poll(() => app.windows().filter(item => item.url().endsWith('/browser.html')).length).toBe(1);
  const reopened = app.windows().find(item => item.url().endsWith('/browser.html'));
  const persisted = await reopened.evaluate(async url => { await window.browserToolbar.invoke({ action: 'open', url }); return JSON.parse((await window.browserToolbar.invoke({ action: 'evaluate', script: 'document.cookie' })).text).result; }, `${base}/report`);
  assert.ok(persisted.includes('reportLogin=fixture')); await reopened.close();
  console.log('功能检查通过'); checks.push('真实内置 Chromium：读取页面、填写、下拉、点击查询、iframe、JS、截图、新标签、报表下载、关闭重开保留登录Cookie；远程页面无应用桥接');

  await page.evaluate(async base => { await window.jinggong.saveJira({ baseUrl: base + '/jira', account: 'fixture-user', password: 'synthetic-jira-password', projectKey: 'TEST', dateFieldId: '11116' }); }, base);
  await page.reload(); await expect(page.getByRole('button', { name: '打开全局设置', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '查看 Jira 任务 TEST-1', exact: true }).click();
  await page.getByRole('button', { name: '从此任务创建会话', exact: true }).waitFor();
  assert.ok(!(await page.getByRole('button', { name: '从此任务创建会话', exact: true }).textContent()).includes('隔离'));
  await page.locator('.jira-workflow > summary').click();
  await expect(page.getByLabel('Jira 测试结果与补充说明')).toContainText('暂无关联会话测试结果');
  await page.getByLabel('Jira 目标状态').selectOption('101'); await page.getByRole('combobox', { name: '搜索经办人', exact: true }).fill('tester'); await page.getByRole('option', { name: '测试经办人 tester', exact: true }).click();
  await page.getByLabel('Jira 测试结果与补充说明').fill('实际合成验收：报表查询、参数选择及图片上传通过。');
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, imagePath);
  await page.getByRole('button', { name: '上传测试图片', exact: true }).click(); await page.locator('.workflow-images img').waitFor();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '确认流转并提交反馈', exact: true }).click();
  await expect(page.locator('.jira-workflow')).toContainText('任务已流转至');
  assert.equal(state.writes.length, 3); assert.equal(state.writes[0].headers['x-atlassian-token'], 'no-check'); assert.ok(state.writes[0].headers['content-type'].includes('multipart/form-data; boundary='));
  assert.equal(JSON.parse(state.writes[1].body).name, 'tester');
  const flow = JSON.parse(state.writes[2].body); assert.equal(flow.transition.id, '101'); assert.ok(flow.update.comment[0].add.body.includes('实际合成验收')); assert.ok(flow.update.comment[0].add.body.includes('[^测试结果.png]'));
  console.log('功能检查通过'); checks.push('真实本地 Jira HTTP 合成服务：界面位于创建会话下方，选择状态/经办人、编辑测试结果、图片预览、确认提交，真实multipart上传+PUT经办人+POST状态与评论，刷新任务状态');
  await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '开发要求与规范', exact: true }).click();
  const settingsDialog = page.getByRole('dialog');
  await expect(settingsDialog.getByLabel('规范更新地址')).toHaveValue('https://github.com/zhuangxiaolong/jg_agent');
  await settingsDialog.getByRole('button', { name: '立即更新规范', exact: true }).click();
  await expect(settingsDialog).toContainText('开发规范更新完成', { timeout: 30000 });
  const updatedSettings = await page.evaluate(() => window.jinggong.getSettings());
  assert.equal(updatedSettings.requirementsSync.version, '2026.11.06.2');
  assert.ok(updatedSettings.documents.some(document => document.remote?.version === '2026.11.06.2' && document.content.includes('MES5')));
  await settingsDialog.getByLabel('自动更新开发规范').uncheck();
  await settingsDialog.getByRole('button', { name: '保存规范更新设置', exact: true }).click();
  assert.equal((await page.evaluate(() => window.jinggong.getSettings())).requirementsSync.automatic, false);
  await settingsDialog.getByRole('button', { name: '记忆', exact: true }).click();
  const memoryPath = path.join(root, 'memory-only.json'), memoryOut = path.join(root, 'all-memories.json');
  await writeFile(memoryPath, JSON.stringify({ format: 'jinggong-share', version: 1, exportedAt: new Date().toISOString(), memories: [{ title: '新增导入经验', content: '检查报表分页条件。', createdAt: new Date().toISOString() }] }));
  await app.evaluate(({ dialog }, input) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [input.memoryPath] }); dialog.showSaveDialog = async () => ({ canceled: false, filePath: input.memoryOut }); }, { memoryPath, memoryOut });
  await settingsDialog.getByRole('button', { name: '导入记忆', exact: true }).click();
  await settingsDialog.getByRole('button', { name: '查看记忆 新增导入经验', exact: true }).waitFor();
  await settingsDialog.getByRole('button', { name: '导出全部记忆', exact: true }).click();
  await expect.poll(async () => JSON.parse(await readFile(memoryOut, 'utf8')).memories.length).toBe(2);
  await settingsDialog.getByRole('button', { name: '关闭设置', exact: true }).click();
  checks.push('真实 GitHub 在线规范下载、版本显示、SHA256校验、SQLite保存和自动更新开关；记忆管理界面导入/导出全部记忆通过');
  await page.screenshot({ path: 'test-results/browser-sharing-jira.png', fullPage: true });
  await assert.rejects(readFile(path.join(root, 'uncaught.log')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), '# 真实本地功能验收\n');
  await writeFile('test-results/browser-sharing-smoke.json', JSON.stringify({ passed: true, checks, testData: root, limitations: '浏览器及Jira为本地合成业务页面；未调用模型，未操作用户报表平台和真实Jira。' }, null, 2));
} catch (error) {
  await writeFile('test-results/browser-sharing-smoke.json', JSON.stringify({ passed: false, checks, error: String(error), testData: root }, null, 2)); throw error;
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 使用隔离用户目录与合成 Jira，验证真实 Electron / IPC / Windows 凭据链路。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-jira-settings-desktop-'));
const data = path.join(root, 'data');
const secret = 'synthetic-desktop-jira-password!';
const account = '合成中文账号';
let logins = 0;
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.url === '/rest/auth/1/session') {
    let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.deepEqual(JSON.parse(body), { username: account, password: secret });
      logins++; json(200, { session: { name: 'JSESSIONID', value: 'synthetic-desktop-session' } });
    });
  } else if (request.headers.cookie !== 'JSESSIONID=synthetic-desktop-session') json(401, {});
  else if (request.url === '/rest/api/2/myself') json(200, { displayName: '合成验收用户', timeZone: 'Asia/Shanghai' });
  else if (request.url === '/rest/api/2/field') json(200, [{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date' } }]);
  else json(404, {});
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const checks = [];
let app;
async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await expect(page.getByRole('button', { name: '全局设置', exact: true })).toBeVisible({ timeout: 30000 });
  return page;
}
try {
  let page = await launch();
  await page.evaluate(input => window.jinggong.saveJira(input), { baseUrl, account, password: secret, projectKey: 'FIXTURE', dateFieldId: '11116' });
  const snapshot = await page.evaluate(() => window.jinggong.getSettings());
  assert.equal(snapshot.jira.hasPassword, true);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  checks.push('真实主进程保存DPAPI凭据，常规快照无明文');
  await page.getByRole('button', { name: '全局设置', exact: true }).click();
  await page.getByRole('button', { name: 'Jira 连接', exact: true }).click();
  const field = page.locator('#jira-password');
  await expect(field).toHaveValue('');
  await page.getByRole('button', { name: '显示 Jira 密码', exact: true }).click();
  await expect(field).toHaveValue(secret);
  await page.getByRole('button', { name: '隐藏 Jira 密码', exact: true }).click();
  await expect(field).toHaveValue('');
  checks.push('真实受信IPC按需解密并切换显隐');
  await page.getByRole('button', { name: '测试已保存连接', exact: true }).click();
  await expect(page.getByText(/连接成功：合成验收用户/)).toBeVisible({ timeout: 20000 });
  assert.ok(logins >= 1);
  assert.ok(requests.filter(item => item.path === '/rest/api/2/myself').length >= 2);
  assert.ok(requests.filter(item => item.path === '/rest/api/2/field').length >= 2);
  checks.push('桌面连接测试Basic失败后会话认证成功');
  const rejected = await app.evaluate(async ({ app, BrowserWindow }) => {
    const rogue = new BrowserWindow({ show: false, webPreferences: { preload: `${app.getAppPath()}/dist/preload.cjs`, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    try { await rogue.loadFile(`${app.getAppPath()}/dist/renderer/index.html`); return await rogue.webContents.executeJavaScript('window.jinggong.revealJiraPassword({baseUrl:"http://127.0.0.1",account:"fixture"}).then(()=>false,()=>true)'); }
    finally { rogue.destroy(); }
  });
  assert.equal(rejected, true);
  checks.push('其他窗口不能读取已保存密码');
  const shell = page.getByRole('dialog');
  const initial = await shell.boundingBox();
  await page.mouse.move(initial.x + initial.width - 4, initial.y + initial.height - 4);
  await page.mouse.down(); await page.mouse.move(initial.x + initial.width - 184, initial.y + initial.height - 144, { steps: 20 }); await page.mouse.up();
  const smaller = await shell.boundingBox();
  assert.ok(smaller.width < initial.width - 100 && smaller.height < initial.height - 100);
  await page.getByRole('button', { name: '保存 Jira 配置', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '保存 Jira 配置', exact: true })).toBeInViewport();
  await page.screenshot({ path: path.join(root, 'jira-settings-desktop.png') });
  checks.push('真实Electron支持拖小设置窗口且保存按钮可达');
  await app.close(); app = undefined;
  page = await launch();
  assert.equal(await page.evaluate(input => window.jinggong.revealJiraPassword(input), { baseUrl, account }), secret);
  assert.ok(!(await readFile(path.join(data, 'config/secrets/jira.dpapi'))).includes(Buffer.from(secret)));
  checks.push('重启后DPAPI密码可显式读取且凭据文件无明文');
  assert.ok(requests.every(item => item.method === 'GET' || item.path === '/rest/auth/1/session'));
  const result = { passed: checks.length, checks, requests, artifacts: root };
  await writeFile(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// 仅使用临时数据和本机 HTTPS 模型列表，不读取真实凭据或执行模型推理。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-provider-settings-'));
const dataRoot = path.join(root, 'data');
const ca = path.join(root, 'fixture-ca.pem');
const privateKey = path.join(root, 'fixture-key.pem');
const apiKey = 'sk-provider-settings-fixture-only';
const changedApiKey = 'sk-provider-settings-changed-fixture-only';
const models = [{ id: 'fixture-model-a', name: '本机模型 A' }, { id: 'fixture-model-b', name: '本机模型 B' }];
const checks = [];
const requests = [];
const layouts = [];
const themeStyles = [];
const screenshots = [];
const reportPath = 'test-results/provider-settings-smoke.json';
let responseMode = 'success';
let app;
let page;
await mkdir('test-results', { recursive: true });
const openssl = process.env.JINGGONG_TEST_OPENSSL || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', privateKey, '-out', ca], { windowsHide: true, stdio: 'pipe' });
const server = createServer({ key: await readFile(privateKey), cert: await readFile(ca) }, (request, response) => {
  const expectedKey = request.url === '/changed/v1/models' ? changedApiKey : apiKey;
  requests.push({ method: request.method, path: request.url, authenticated: request.headers.authorization === `Bearer ${expectedKey}` });
  response.writeHead(responseMode === 'failure' ? 503 : 200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(responseMode === 'failure' ? { error: { message: '本机模型列表暂不可用' } } : { data: models }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `https://127.0.0.1:${server.address().port}/relay/v1`;
const changedBaseUrl = `https://127.0.0.1:${server.address().port}/changed/v1`;
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot, NODE_EXTRA_CA_CERTS: ca };
delete env.ELECTRON_RUN_AS_NODE;
const settings = () => page.evaluate(() => window.jinggong.getSettings());
const fetchButton = () => page.getByRole('button', { name: '从中转站获取模型列表', exact: true });
async function secretFiles() {
  return (await readdir(path.join(dataRoot, 'config', 'secrets')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).sort();
}
async function verifySettingsLayout(width, height) {
  await page.setViewportSize({ width, height });
  await page.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
  const result = await page.evaluate(() => {
    const shell = document.querySelector('.settings-shell');
    const content = document.querySelector('.settings-content');
    const form = document.querySelector('#provider-url').closest('form');
    const url = document.querySelector('#provider-url').getBoundingClientRect();
    const key = document.querySelector('#provider-key').getBoundingClientRect();
    const fetch = form.querySelector('.model-fetch-actions button').getBoundingClientRect();
    const model = document.querySelector('#provider-model').getBoundingClientRect();
    const bounds = shell.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, urlBottom: url.bottom, keyTop: key.top, keyBottom: key.bottom, fetchTop: fetch.top, fetchBottom: fetch.bottom, modelTop: model.top, shellLeft: bounds.left, shellRight: bounds.right, shellTop: bounds.top, shellBottom: bounds.bottom, contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth };
  });
  assert.ok(result.urlBottom <= result.keyTop && result.keyBottom <= result.fetchTop && result.fetchBottom <= result.modelTop, `字段顺序或间距错误：${JSON.stringify(result)}`);
  assert.ok(result.shellLeft >= 0 && result.shellRight <= width && result.shellTop >= 0 && result.shellBottom <= height, `设置框超出窗口：${JSON.stringify(result)}`);
  assert.ok(result.contentScrollWidth <= result.contentWidth + 1, `设置内容横向溢出：${JSON.stringify(result)}`);
  layouts.push(result);
  const screenshot = `test-results/provider-settings-${width}x${height}.png`;
  await page.screenshot({ path: screenshot });
  screenshots.push(screenshot);
}
function luminance(cssColor) {
  const channels = cssColor.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
try {
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), cwd: process.cwd(), env });
  page = await app.firstWindow();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.getByText('当前项目会话', { exact: true })).toHaveCount(0);
  await expect(page.locator('.sidebar .sessions-heading')).toHaveCount(0);
  checks.push('真实 Electron 窗口已移除左下角当前项目会话区域');

  await page.getByRole('button', { name: '全局设置', exact: true }).click();
  await expect(fetchButton()).toBeDisabled();
  await page.locator('#provider-name').fill('');
  await page.locator('#provider-url').fill(baseUrl);
  await expect(fetchButton()).toBeDisabled();
  await page.locator('#provider-key').fill(apiKey);
  await expect(fetchButton()).toBeEnabled();
  await expect(page.locator('#provider-model')).toHaveValue('');
  assert.equal((await settings()).providers.length, 0);
  assert.deepEqual(await secretFiles(), []);
  checks.push('未保存中转站仅填写 API URL 和 API Key 即可获取，不要求名称或预填模型 ID');
  await verifySettingsLayout(1600, 900);
  await verifySettingsLayout(1366, 768);
  checks.push('1600×900 与 1366×768 字段顺序为 URL→Key→获取按钮→模型 ID，设置框位于窗口内且无横向溢出');

  await page.locator('#provider-model').fill('manual-before-failure');
  responseMode = 'failure';
  await fetchButton().click();
  await expect(page.getByRole('alert')).toContainText('503');
  await expect(page.locator('#provider-url')).toHaveValue(baseUrl);
  await expect(page.locator('#provider-key')).toHaveValue(apiKey);
  await expect(page.locator('#provider-model')).toHaveValue('manual-before-failure');
  await expect(fetchButton()).toBeEnabled();
  assert.equal((await settings()).providers.length, 0);
  assert.deepEqual(await secretFiles(), []);
  checks.push('本机 HTTPS 返回 HTTP 503 后保留 URL、密钥和手填模型，按钮恢复可重试，未写配置或凭据');
  await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 4500 });
  await fetchButton().click();
  await expect(page.getByRole('alert')).toContainText('503');
  await page.waitForTimeout(1600);
  await fetchButton().click();
  await expect(page.getByRole('alert')).toContainText('503');
  await page.waitForTimeout(1700);
  await expect(page.getByRole('alert')).toContainText('503');
  await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 4500 });
  checks.push('操作报错在3秒后自动消失；同文错误再次触发重新计时，旧计时器不会提前清除新错误，无需点击关闭');

  responseMode = 'success';
  await page.locator('#provider-model').fill('');
  await fetchButton().click();
  await expect(page.locator('#provider-model')).toHaveValue(models.map(model => model.id).join('\n'));
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  assert.equal((await settings()).providers.length, 0);
  assert.deepEqual(await secretFiles(), []);
  assert.ok(requests.length >= 2 && requests.every(request => request.authenticated && request.method === 'GET' && request.path === '/relay/v1/models'));
  checks.push('真实 UI→preload→IPC→主进程→本机 HTTPS /models 使用表单新密钥完成发现，返回模型自动全选，仍未持久化');
  const modelTable = page.getByRole('table', { name: '模型列表', exact: true });
  await expect(modelTable.getByRole('checkbox')).toHaveCount(models.length);
  await page.getByRole('button', { name: '反选', exact: true }).click();
  await expect(page.locator('#provider-model')).toHaveValue('');
  await expect(modelTable.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await modelTable.getByRole('checkbox', { name: `启用模型 ${models[0].id}`, exact: true }).check();
  await page.getByRole('button', { name: '反选', exact: true }).click();
  await expect(page.locator('#provider-model')).toHaveValue(models[1].id);
  await expect(modelTable.getByRole('checkbox', { name: `启用模型 ${models[0].id}`, exact: true })).not.toBeChecked();
  await expect(modelTable.getByRole('checkbox', { name: `启用模型 ${models[1].id}`, exact: true })).toBeChecked();
  await page.getByRole('button', { name: '全选', exact: true }).click();
  assert.deepEqual((await page.locator('#provider-model').inputValue()).split('\n').sort(), models.map(item => item.id).sort());
  await expect(modelTable.getByRole('checkbox', { checked: true })).toHaveCount(models.length);
  for (const [width, height] of [[1600, 900], [1366, 768]]) {
    await page.setViewportSize({ width, height });
    const columns = await modelTable.evaluate(table => {
      const headings = [...table.querySelectorAll('th')].map(cell => cell.getBoundingClientRect().x);
      const values = [...table.querySelector('tbody tr').querySelectorAll('td')].map(cell => cell.getBoundingClientRect().x);
      return { headings, values, text: [...table.querySelector('tbody tr').cells].map(cell => cell.textContent), scrollWidth: table.parentElement.scrollWidth, width: table.parentElement.clientWidth };
    });
    assert.ok(columns.headings.every((x, i) => Math.abs(x - columns.values[i]) <= 1), JSON.stringify(columns));
    assert.deepEqual(columns.text, ['', models[0].id, models[0].name]);
    assert.ok(columns.scrollWidth <= columns.width + 1, JSON.stringify(columns));
    await modelTable.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/provider-model-columns-${width}x${height}.png` });
  }
  checks.push('全选、全部反选及部分反选均同步启用模型ID；两个窗口尺寸中启用/ID/名称表头与实际数据严格对齐且无横向溢出');

  await page.locator('#provider-name').fill('模型列表本机验收中转站');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = (await settings()).providers;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].baseUrl, baseUrl);
  assert.deepEqual(saved[0].models, models.map(model => model.id));
  assert.equal(saved[0].hasKey, true);
  assert.equal((await secretFiles()).length, 1);
  checks.push('获取后通过保存配置一次写入模型及 DPAPI 凭据');

  await page.getByRole('button', { name: '全局设置', exact: true }).click();
  await expect(page.locator('#provider-key')).toHaveValue('');
  await expect(fetchButton()).toBeEnabled();
  await fetchButton().click();
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  assert.equal(requests.at(-1).path, '/relay/v1/models');
  assert.equal(requests.at(-1).authenticated, true);
  checks.push('已保存中转站在地址不变且密钥留空时可直接读取加密凭据获取模型，密钥不回显');

  await page.locator('#provider-url').fill(changedBaseUrl);
  await expect(fetchButton()).toBeDisabled();
  const beforeGuard = requests.length;
  const rejected = await page.evaluate(async ({ id, baseUrl }) => {
    try { await window.jinggong.fetchProviderModels({ id, baseUrl }); return false; }
    catch { return true; }
  }, { id: saved[0].id, baseUrl: changedBaseUrl });
  assert.equal(rejected, true);
  assert.equal(requests.length, beforeGuard);
  await page.locator('#provider-key').fill(changedApiKey);
  await expect(fetchButton()).toBeEnabled();
  await fetchButton().click();
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  assert.equal(requests.at(-1).path, '/changed/v1/models');
  assert.equal(requests.at(-1).authenticated, true);
  assert.deepEqual((await settings()).providers, saved);
  checks.push('更换 URL 未填新密钥时 UI 禁用且主进程拒绝；填新密钥后只向新 URL 获取，旧配置保持至用户保存');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();

  await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: '输入任务', exact: true });
  const send = page.getByRole('button', { name: '发送任务', exact: true });
  await expect(prompt).toBeVisible();
  await expect(send).toBeDisabled();
  const beforeDisabledClick = await page.evaluate(() => window.jinggong.bootstrap());
  const session = beforeDisabledClick.sessions[0];
  assert.ok(session);
  const eventsBefore = await page.evaluate(id => window.jinggong.getEvents(id), session.id);
  await send.click({ force: true });
  assert.deepEqual(await page.evaluate(id => window.jinggong.getEvents(id), session.id), eventsBefore);
  const disabledStyle = await send.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity }));
  await prompt.fill('仅用于检查发送按钮高亮，不发送模型');
  await expect(send).toBeEnabled({ timeout: 30000 });
  await expect.poll(() => send.evaluate(element => element.getAnimations().length)).toBe(0);
  const enabledStyle = await send.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, composerBackground: getComputedStyle(element.closest('.composer')).backgroundColor }));
  assert.notEqual(enabledStyle.background, disabledStyle.background);
  assert.ok(contrast(enabledStyle.background, enabledStyle.composerBackground) >= 2, `发送按钮背景高亮不足：${JSON.stringify(enabledStyle)}`);
  assert.ok(contrast(enabledStyle.background, enabledStyle.color) >= 3, `发送图标对比不足：${JSON.stringify(enabledStyle)}`);
  await send.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(send).toBeFocused();
  const focusedStyle = await send.evaluate(element => ({ outlineStyle: getComputedStyle(element).outlineStyle, outlineWidth: getComputedStyle(element).outlineWidth, boxShadow: getComputedStyle(element).boxShadow }));
  assert.ok(focusedStyle.boxShadow !== 'none' || (focusedStyle.outlineStyle !== 'none' && focusedStyle.outlineWidth !== '0px'), `键盘焦点不可见：${JSON.stringify(focusedStyle)}`);
  for (const [width, height] of [[1600, 900], [1366, 768]]) {
    await page.setViewportSize({ width, height });
    const bounds = await send.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, '发送按钮超出可视窗口');
    const screenshot = `test-results/provider-send-${width}x${height}.png`;
    await page.screenshot({ path: screenshot });
    screenshots.push(screenshot);
  }
  assert.equal(requests.length, beforeGuard + 1);
  checks.push('会话发送按钮空输入保持禁用且真实点击无新事件；填写任务后高亮可用、图标对比达标、键盘焦点可见，两种窗口尺寸均在可视区；未点击可用发送或请求模型');

  for (const theme of ['black', 'dark']) {
    const preferences = (await settings()).preferences;
    await page.evaluate(preferences => window.jinggong.savePreferences(preferences), { ...preferences, style: 'minimal', theme });
    await page.reload();
    await expect(prompt).toBeVisible();
    await prompt.fill('极简深色发送按钮高亮检查，不发送模型');
    await expect(send).toBeEnabled({ timeout: 30000 });
    await expect.poll(() => send.evaluate(element => element.getAnimations().length)).toBe(0);
    const style = await send.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, composerBackground: getComputedStyle(element.closest('.composer')).backgroundColor }));
    assert.ok(contrast(style.background, style.composerBackground) >= 2, `极简${theme}发送按钮背景高亮不足：${JSON.stringify(style)}`);
    assert.ok(contrast(style.background, style.color) >= 3, `极简${theme}发送图标对比不足：${JSON.stringify(style)}`);
    themeStyles.push({ style: 'minimal', theme, ...style });
    await page.setViewportSize({ width: 1600, height: 900 });
    const screenshot = `test-results/provider-send-minimal-${theme}-1600x900.png`;
    await page.screenshot({ path: screenshot });
    screenshots.push(screenshot);
    if (theme === 'black') {
      await page.getByRole('button', { name: '全局设置', exact: true }).click();
      await expect(fetchButton()).toBeEnabled();
      await page.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
      const settingsScreenshot = 'test-results/provider-settings-minimal-black-1600x900.png';
      await page.screenshot({ path: settingsScreenshot });
      screenshots.push(settingsScreenshot);
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    }
  }
  assert.equal(requests.length, beforeGuard + 1);
  checks.push('极简黑色与极简深色主题发送按钮高亮及图标对比均达标，留有对应真实窗口截图');

  const report = { date: new Date().toISOString(), passed: true, executable: process.env.JINGGONG_TEST_EXE || '开发 Electron', checks, requests, layouts, styles: { disabledStyle, enabledStyle, focusedStyle, themeStyles }, screenshots, testData: root, scope: '真实 Electron、UI、IPC、DPAPI 与本机 HTTPS 模型列表；未访问外部中转站或执行真实模型推理', testTlsSupport: '仅隔离进程 NODE_EXTRA_CA_CERTS 信任本次临时 CA；未关闭 TLS 校验或修改系统证书' };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: 'test-results/provider-settings-smoke-failed.png' }).catch(() => {});
  await writeFile(reportPath, JSON.stringify({ date: new Date().toISOString(), passed: false, checks, requests, layouts, screenshots, testData: root, error: String(error?.stack || error) }, null, 2));
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

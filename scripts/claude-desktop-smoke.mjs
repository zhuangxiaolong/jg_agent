import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:https';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 使用隔离数据、真实窗口和真实 Claude；本机 HTTPS 响应仅为协议验收资料。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-claude-desktop-'));
const data = path.join(root, 'data');
const home = path.join(root, 'home');
const ca = path.join(root, 'fixture-ca.pem');
const privateKey = path.join(root, 'fixture-key.pem');
const model = 'jinggong-relay-desktop-fixture';
const key = 'sk-jinggong-desktop-fixture-only';
const reply = 'Claude 桌面链路测试通过';
const checks = [];
const requests = [];
const nativeSpawns = [];
const reportPath = 'test-results/claude-desktop-smoke.json';
await mkdir(home);
await mkdir(path.join(root, 'appdata'));
await mkdir(path.join(root, 'localappdata'));
await mkdir('test-results', { recursive: true });
const openssl = process.env.JINGGONG_TEST_OPENSSL || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl');
execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', privateKey, '-out', ca], { windowsHide: true, stdio: 'pipe' });
const server = createServer({ key: await readFile(privateKey), cert: await readFile(ca) }, async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (request.url?.split('?')[0] !== '/relay/v1/messages') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(request.url?.includes('count_tokens') ? { input_tokens: 10 } : {}));
      return;
    }
    requests.push({ path: request.url, model: body.model, authenticated: request.headers['x-api-key'] === key || request.headers.authorization === `Bearer ${key}`, stream: body.stream === true });
    const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const message = { id: `msg_desktop_fixture_${requests.length}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage };
    if (!body.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...message, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const item of [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
    response.end();
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: '本机验收请求格式无效' } }));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseUrl = `https://127.0.0.1:${server.address().port}/relay/v1`;
let app;
let page;
const env = { ...process.env, JINGGONG_TEST_DATA: data, HOME: home, USERPROFILE: home, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata') };
delete env.ELECTRON_RUN_AS_NODE;
try {
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env });
  page = await app.firstWindow();
  await expect(page.locator('.runtime-summary')).toBeVisible({ timeout: 30000 });
  // 仅向本次隔离进程的真实 Claude 子进程加入测试 CA，不关闭 TLS 校验或改系统证书。
  await app.evaluate(async (_electron, fixture) => {
    const childProcess = process.mainModule.require('node:child_process');
    const { syncBuiltinESMExports } = process.mainModule.require('node:module');
    const original = childProcess.spawn;
    globalThis.__claudeDesktopFixtureSpawns = [];
    childProcess.spawn = function (command, args, options) {
      if (!/(?:^|[\\/])claude\.exe$/i.test(String(command))) return original.apply(this, arguments);
      const record = { executable: String(command), caInjected: true, relayBaseUrl: options?.env?.ANTHROPIC_BASE_URL };
      const child = original.call(this, command, args, { ...options, env: { ...options?.env, NODE_EXTRA_CA_CERTS: fixture.ca, CLAUDE_CONFIG_DIR: fixture.home, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', API_TIMEOUT_MS: '15000' } });
      record.pid = child.pid;
      globalThis.__claudeDesktopFixtureSpawns.push(record);
      return child;
    };
    syncBuiltinESMExports();
  }, { ca, home });

  async function createSession(alias, kind, expectedInitialKind = 'claude_agent_sdk') {
    const before = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.map(item => item.id);
    await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('新建会话工作区', { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel('新建会话项目', { exact: true })).toHaveValue('');
    await expect(dialog.getByLabel('新建会话 Runtime', { exact: true })).toHaveValue(expectedInitialKind);
    if (kind) await dialog.getByLabel('新建会话 Runtime', { exact: true }).selectOption(kind);
    await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toBeVisible();
    const created = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => !before.includes(item.id));
    assert.ok(created);
    assert.equal(created.projectId, undefined);
    assert.equal(created.workspaceId, undefined);
    assert.equal(created.mode, 'read');
    await page.locator('.session-item.selected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
    await page.getByRole('textbox', { name: '会话别名', exact: true }).fill(alias);
    await page.getByRole('button', { name: '保存会话别名', exact: true }).click();
    await expect(page.locator('.session-item.selected')).toContainText(alias);
    return created;
  }
  async function changeSessionRuntime(id, kind) {
    const selector = page.getByLabel('当前会话运行时', { exact: true });
    await selector.selectOption(kind);
    await page.waitForFunction(async ({ id, kind }) => (await window.jinggong.bootstrap()).sessions.find(item => item.id === id)?.runtimeKind === kind, { id, kind });
    await expect(selector).toHaveValue(kind);
    await expect(selector).toBeEnabled();
  }
  async function sendAndVerify(id, marker) {
    const previousRequests = requests.length;
    await page.getByRole('textbox', { name: '输入任务', exact: true }).fill(`${marker}：只回复“${reply}”，不要调用工具。`);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await page.waitForFunction(async id => {
      const events = await window.jinggong.getEvents(id);
      return events.some(item => item.type === 'status' && ['completed', 'failed'].includes(item.text)) || events.some(item => item.type === 'error');
    }, id, { timeout: 60000 });
    const snapshot = await page.evaluate(async id => ({ session: (await window.jinggong.bootstrap()).sessions.find(item => item.id === id), events: await window.jinggong.getEvents(id) }), id);
    assert.equal(snapshot.session.runtimeKind, 'claude_agent_sdk');
    assert.equal(snapshot.session.status, 'completed', JSON.stringify(snapshot.events));
    assert.ok(snapshot.session.runtimeNativeSessionId, '主进程未保存真实 Claude 原生会话 ID');
    assert.ok(snapshot.events.some(item => item.type === 'user' && item.text.includes(marker)));
    assert.ok(snapshot.events.some(item => ['message', 'delta'].includes(item.type) && item.text.includes(reply)), JSON.stringify(snapshot.events));
    assert.ok(!snapshot.events.some(item => item.type === 'error'), JSON.stringify(snapshot.events));
    assert.ok(requests.length > previousRequests, 'UI 发送后本机中转站没有收到真实模型请求');
    assert.ok(requests.every(item => item.path.split('?')[0] === '/relay/v1/messages' && item.model === model && item.authenticated && item.stream));
    await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('claude_agent_sdk');
    await expect(page.locator('.runtime-summary')).toContainText('Claude Agent SDK Runtime');
    return snapshot;
  }

  const unconfiguredSession = await createSession('未配置模型的运行时选择验收');
  assert.equal(unconfiguredSession.runtimeKind, 'claude_agent_sdk');
  assert.equal(unconfiguredSession.providerId, undefined);
  assert.equal(unconfiguredSession.model, '');
  await changeSessionRuntime(unconfiguredSession.id, 'jinggong');
  const unconfiguredChanged = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === unconfiguredSession.id);
  for (const field of ['model', 'providerId', 'workspacePath', 'mode', 'system', 'reasoningEffort']) assert.equal(unconfiguredChanged[field], unconfiguredSession[field], `仅选引擎不应修改 ${field}`);
  await changeSessionRuntime(unconfiguredSession.id, 'claude_agent_sdk');
  checks.push('未配置中转站或模型时可直接为独立会话选择运行时，其他会话字段保持');

  await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
  await page.locator('#provider-name').fill('Claude 本机协议验收中转站');
  await page.locator('#provider-url').fill(baseUrl);
  await page.locator('#provider-model').fill(model);
  await page.locator('#provider-key').fill(key);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const profiles = (await page.evaluate(() => window.jinggong.getSettings())).providers;
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].baseUrl, baseUrl);
  assert.deepEqual(profiles[0].models, [model]);
  assert.equal(profiles[0].hasKey, true);
  checks.push('真实 UI 保存共享 HTTPS 中转站、模型 ID 和加密 API Key，没有单独 Claude 凭据');

  await page.getByRole('button', { name: '打开全局设置', exact: true }).click();
  await page.getByRole('button', { name: '运行时', exact: true }).click();
  await expect(page.getByRole('dialog').locator('input[name="runtime-kind"]')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByLabel('当前会话运行时', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  checks.push('全局运行时设置仅显示组件状态，不再提供全局引擎选择');

  await page.evaluate(() => window.jinggong.saveRuntimeKind('codex'));
  const claudeSession = await createSession('Claude 默认独立会话验收');
  assert.equal(claudeSession.runtimeKind, 'claude_agent_sdk');
  assert.equal(claudeSession.providerId, profiles[0].id);
  assert.equal(claudeSession.model, model);
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  await page.getByLabel('推理强度', { exact: true }).selectOption('high');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await page.waitForFunction(async id => (await window.jinggong.bootstrap()).sessions.find(item => item.id === id)?.reasoningEffort === 'high', claudeSession.id);
  await page.getByRole('button', { name: '关闭会话设置', exact: true }).click();
  const sentClaudeSession = (await sendAndVerify(claudeSession.id, '默认 Claude 独立会话')).session;
  const runtimeBox = await page.getByLabel('当前会话运行时', { exact: true }).boundingBox();
  const modelBox = await page.getByRole('button', { name: '打开当前会话设置', exact: true }).boundingBox();
  assert.ok(runtimeBox && modelBox && Math.abs(runtimeBox.y - modelBox.y) <= Math.max(runtimeBox.height, modelBox.height), '会话运行时选择应显示在模型入口旁');
  checks.push('新建会话继承当前 Claude，运行时选择框位于模型旁，真实 UI→IPC→SDK→原生程序→本机 HTTPS 中转站发送成功');

  const unchangedClaude = await page.evaluate(id => window.jinggong.configureSession(id, { runtimeKind: 'claude_agent_sdk' }), claudeSession.id);
  for (const field of ['runtimeThreadId', 'runtimeNativeSessionId', 'runtimeVersion', 'runtimeCapabilitiesVersion', 'model', 'providerId', 'reasoningEffort', 'mode', 'system', 'workspacePath']) assert.equal(unchangedClaude[field], sentClaudeSession[field], `同引擎重复配置不应修改 ${field}`);
  assert.equal(unchangedClaude.reasoningEffort, 'high');
  checks.push('已有真实 Claude 原生会话时重复配置同一运行时不清空线程、原生会话、模型或推理强度');

  await page.evaluate(() => window.jinggong.saveRuntimeKind('jinggong'));
  const afterLegacyChange = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === claudeSession.id);
  assert.equal(afterLegacyChange.runtimeKind, 'claude_agent_sdk');
  assert.equal(afterLegacyChange.runtimeNativeSessionId, sentClaudeSession.runtimeNativeSessionId);
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('claude_agent_sdk');
  checks.push('兼容 API 的旧全局值变更不影响显式新建的会话，也不改写当前会话引擎或线程');

  const independentSession = await createSession('会话独立引擎切换验收', 'jinggong');
  assert.equal(independentSession.runtimeKind, 'jinggong');
  assert.equal((await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === claudeSession.id)?.runtimeKind, 'claude_agent_sdk');
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('jinggong');
  await expect(page.locator('.runtime-summary')).toContainText('Jinggong Runtime');
  await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('新建会话 Runtime', { exact: true })).toHaveValue('jinggong');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.evaluate(() => window.jinggong.bootstrap())).sessions.length, 3);
  checks.push('新建框可直接选择 Jinggong，两条会话分别使用不同引擎；再次新建默认继承当前会话，取消不落库');

  await changeSessionRuntime(independentSession.id, 'claude_agent_sdk');
  assert.equal((await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === claudeSession.id)?.runtimeKind, 'claude_agent_sdk');
  await sendAndVerify(independentSession.id, '模型旁即时切换到 Claude');
  checks.push('模型旁运行时框选择 Claude 后立即持久化，无需应用按钮，真实发送成功且不影响另一会话');

  await page.locator('.session-item').filter({ hasText: 'Claude 默认独立会话验收' }).click();
  await changeSessionRuntime(claudeSession.id, 'jinggong');
  const beforeReload = await page.evaluate(() => window.jinggong.bootstrap());
  assert.equal(beforeReload.sessions.find(item => item.id === independentSession.id)?.runtimeKind, 'claude_agent_sdk');
  assert.ok(beforeReload.sessions.find(item => item.id === independentSession.id)?.runtimeNativeSessionId);

  await page.reload();
  await expect(page.locator('.runtime-summary')).toBeVisible({ timeout: 30000 });
  const afterReload = await page.evaluate(() => window.jinggong.bootstrap());
  assert.equal(afterReload.sessions.find(item => item.id === independentSession.id)?.runtimeKind, 'claude_agent_sdk');
  assert.equal(afterReload.sessions.find(item => item.id === claudeSession.id)?.runtimeKind, 'jinggong');
  assert.ok(afterReload.sessions.find(item => item.id === independentSession.id)?.runtimeNativeSessionId);
  await page.locator('.session-item').filter({ hasText: 'Claude 默认独立会话验收' }).click();
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('jinggong');
  await page.locator('.session-item').filter({ hasText: '会话独立引擎切换验收' }).click();
  await expect(page.locator('.runtime-summary')).toContainText('Claude Agent SDK Runtime');
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('claude_agent_sdk');
  checks.push('修改其中一条会话为 Jinggong 后另一条仍为 Claude；重载后两种引擎独立持久化，真实 Claude 会话 ID 保持');
  nativeSpawns.push(...await app.evaluate(() => globalThis.__claudeDesktopFixtureSpawns));
  assert.ok(nativeSpawns.filter(item => item.pid && item.caInjected && item.relayBaseUrl === baseUrl.replace(/\/v1$/, '')).length >= 2, JSON.stringify(nativeSpawns));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.screenshot({ path: 'test-results/claude-desktop-smoke.png' });
  const report = { date: new Date().toISOString(), passed: true, executable: process.env.JINGGONG_TEST_EXE || '开发 Electron', checks, requests, nativeSpawns, testData: root, scope: '真实桌面、主进程、SDK 和 Claude 原生程序；模型响应来自本机 Anthropic-compatible HTTPS 协议 fixture，未验证外部中转站或真实模型能力', testTlsSupport: '仅隔离测试进程对子进程注入 NODE_EXTRA_CA_CERTS 信任临时 CA；未关闭 TLS 校验、未修改系统证书存储、未修改业务代码' };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: 'test-results/claude-desktop-smoke-failed.png' }).catch(() => {});
  await writeFile(reportPath, JSON.stringify({ date: new Date().toISOString(), passed: false, checks, requests, testData: root, error: String(error?.stack || error) }, null, 2));
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

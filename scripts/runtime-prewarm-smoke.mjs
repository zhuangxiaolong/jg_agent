import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// 使用隔离数据和真实随包组件，只做本地预检/握手，不配置凭据或发送模型任务。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-prewarm-desktop-'));
const outputRoot = process.env.JINGGONG_VALIDATION_OUTPUT ? path.resolve(process.env.JINGGONG_VALIDATION_OUTPUT) : root;
await mkdir(outputRoot, { recursive: true });
const checks = [];
const observedChildren = new Set();
const observedParents = new Set();
const exec = promisify(execFile);
let app;

async function launch(dataDirectory) {
  const env = { ...process.env, JINGGONG_TEST_DATA: dataDirectory };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), cwd: process.cwd(), env });
  observedParents.add(app.process().pid);
  await app.evaluate(() => {
    const require = process.mainModule.require;
    const { Worker } = require('node:worker_threads');
    const originalEmit = Worker.prototype.emit;
    const originalPostMessage = Worker.prototype.postMessage;
    const state = globalThis.__prewarmProcessMonitor = { children: new Set(), active: new Set(), requests: [], responses: [] };
    Worker.prototype.emit = function (event, ...args) {
      const message = args[0];
      if (event === 'message' && message?.type === 'child') {
        state.children.add(message.pid);
        if (message.active) state.active.add(message.pid); else state.active.delete(message.pid);
      } else if (event === 'message' && Number.isInteger(message?.id)) state.responses.push(message.id);
      return originalEmit.call(this, event, ...args);
    };
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.method === 'check' || message?.method === 'verify') state.requests.push({ id: message.id, method: message.method, kind: message.kind });
      return originalPostMessage.call(this, message, ...args);
    };
  });
  const page = await app.firstWindow();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
  return page;
}

async function rememberChildren() {
  if (!app) return;
  for (const pid of await app.evaluate(() => [...globalThis.__prewarmProcessMonitor.children])) observedChildren.add(pid);
}

async function remainingChildren() {
  const pids = [...observedChildren].filter(pid => Number.isSafeInteger(pid) && pid > 0);
  if (process.platform !== 'win32') return pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const parentFilter = [...observedParents].filter(pid => Number.isSafeInteger(pid) && pid > 0).map(pid => `ParentProcessId = ${pid}`).join(' OR ');
  // 只核对本次隔离 Worker 的 PID 和应用自己的原生子进程，不读取任何进程命令行。
  // 父 PID 查询也覆盖最后一次采样后、应用关闭前才启动的组件。
  const command = `$remaining = @(); @(${pids.join(',')}) | ForEach-Object { $entry = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($entry -and $entry.ProcessName -in @('codex','jinggong-runtime','claude','grok')) { $remaining += [int]$_ } }; `
    + (parentFilter ? `$remaining += @(Get-CimInstance -ClassName Win32_Process -Filter '${parentFilter}' -Property ProcessId,Name,ParentProcessId | Where-Object { $_.Name -in @('codex.exe','jinggong-runtime.exe','claude.exe','grok.exe') } | ForEach-Object { [int]$_.ProcessId }); ` : '')
    + `$remaining | Sort-Object -Unique | ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000, maxBuffer: 4096 });
  if (!stdout.trim()) return [];
  const result = JSON.parse(stdout);
  return Array.isArray(result) ? result : [result];
}

async function assertNoChildren(message) {
  // Windows 可能稍晚释放已退出进程；有界等待也避免将 PID 短暂可见误报为持续泄漏。
  await expect.poll(remainingChildren, { timeout: 2000, intervals: [50, 100, 250], message }).toEqual([]);
}

async function save(error) {
  const result = { root, passed: checks.length, checks, ...(error ? { error: String(error) } : {}) };
  await writeFile(path.join(outputRoot, 'runtime-prewarm-desktop-results.json'), JSON.stringify(result, null, 2));
  return result;
}

try {
  const page = await launch(path.join(root, 'data'));
  await app.evaluate(() => {
    const state = globalThis.__prewarmHeartbeat = { count: 0, maxGapMs: 0, last: performance.now() };
    state.timer = setInterval(() => { const now = performance.now(); state.maxGapMs = Math.max(state.maxGapMs, now - state.last); state.last = now; state.count++; }, 10);
  });
  await page.evaluate(() => {
    window.__prewarmHealth = [];
    window.jinggong.onRuntimeHealthChanged(value => window.__prewarmHealth.push(value));
  });
  const initial = await page.evaluate(async () => { const start = performance.now(); const boot = await window.jinggong.bootstrap(); return { elapsedMs: performance.now() - start, warming: Object.values(boot.runtimes).filter(value => value.warmingUp).length }; });
  assert.ok(initial.warming > 0, '界面先于后台预热完成可用');
  assert.ok(initial.elapsedMs < 1000, `启动快照不等全部预检：${initial.elapsedMs}ms`);
  checks.push({ name: '界面先于预热完成、bootstrap 不等待组件校验', ...initial });

  await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
  const composer = page.locator('.composer textarea');
  await expect(composer).toBeVisible();
  await composer.fill('后台预热期间测试输入，不发送真实模型请求');
  await expect(composer).toHaveValue('后台预热期间测试输入，不发送真实模型请求');
  checks.push({ name: '预热期间可以创建会话和输入任务' });
  const samples = [];
  for (let index = 0; index < 8; index++) {
    samples.push(await page.evaluate(async () => { const start = performance.now(); await window.jinggong.bootstrap(); return performance.now() - start; }));
    await composer.press('End');
    await page.waitForTimeout(100);
  }
  assert.ok(Math.max(...samples) < 1000, '预热期间 IPC 保持响应');
  checks.push({ name: '预热期间连续 IPC 和界面操作正常', ipcSamplesMs: samples });
  await expect.poll(async () => (await page.evaluate(() => window.__prewarmHealth)).filter(value => !value.warmingUp).length, { timeout: 45000 }).toBeGreaterThanOrEqual(4);
  const health = await page.evaluate(() => window.__prewarmHealth);
  for (const kind of ['codex', 'jinggong', 'claude_agent_sdk']) assert.ok(health.some(value => value.kind === kind && value.available && value.compatible), `${kind} 本地真实组件预热通过`);
  checks.push({ name: '三套随包真实组件预热状态自动推送，Grok 检测本机状态', health });
  const heartbeat = await app.evaluate(() => { const state = globalThis.__prewarmHeartbeat; clearInterval(state.timer); return { count: state.count, maxGapMs: state.maxGapMs }; });
  assert.ok(heartbeat.count > 30);
  assert.ok(heartbeat.maxGapMs < 500, `主线程心跳最大间隔 ${heartbeat.maxGapMs}ms`);
  checks.push({ name: '真实组件校验期间主线程心跳持续响应', ...heartbeat });
  await expect(composer).toHaveValue('后台预热期间测试输入，不发送真实模型请求');
  const before = await page.evaluate(() => window.jinggong.bootstrap());
  assert.equal(before.sessions.length, 1);
  assert.equal(before.settings.providers.length, 0, '隔离配置不得带入用户模型凭据');
  assert.ok(before.sessions.every(session => !session.runtimeThreadId && !session.runtimeNativeSessionId));
  const elapsedStart = performance.now();
  const cached = await page.evaluate(async () => { const a = await window.jinggong.bootstrap(); const b = await window.jinggong.bootstrap(); return { a: a.runtimes, b: b.runtimes }; });
  assert.deepEqual(cached.a, cached.b);
  checks.push({ name: '重复启动快照复用健康结果，预热未创建额外会话或原生任务', elapsedMs: performance.now() - elapsedStart });

  const codexPushes = health.filter(value => value.kind === 'codex').length;
  const refreshed = await page.evaluate(async () => { const start = performance.now(); const value = await window.jinggong.checkRuntime('codex'); return { elapsedMs: performance.now() - start, value }; });
  assert.ok(refreshed.value.available && refreshed.value.compatible, '手动复检须返回真实本地组件状态');
  await expect.poll(async () => (await page.evaluate(() => window.__prewarmHealth)).filter(value => value.kind === 'codex').length).toBe(codexPushes + 1);
  assert.deepEqual((await page.evaluate(() => window.jinggong.bootstrap())).runtimes.codex, refreshed.value);
  checks.push({ name: '手动 Codex 复检返回结果并推送最新健康状态', ...refreshed });
  await rememberChildren();
  await app.close(); app = undefined;
  await assertNoChildren('正常退出不能残留预检的原生进程');

  const earlyPage = await launch(path.join(root, 'early-exit-data'));
  await earlyPage.evaluate(() => {
    window.__prewarmEarlySettled = false;
    void window.jinggong.checkRuntime('codex').then(() => { window.__prewarmEarlySettled = true; }, () => { window.__prewarmEarlySettled = true; });
  });
  const pending = await app.evaluate(() => {
    const state = globalThis.__prewarmProcessMonitor;
    return state.requests.some(request => request.kind === 'codex' && !state.responses.includes(request.id));
  });
  assert.equal(pending, true, '退出前须有实际进行中的 Worker 预检');
  assert.equal(await earlyPage.evaluate(() => window.__prewarmEarlySettled), false);
  await rememberChildren();
  const exitStart = performance.now();
  await app.close(); app = undefined;
  const exitElapsedMs = performance.now() - exitStart;
  assert.ok(exitElapsedMs < 5000, `预热中退出须及时完成：${exitElapsedMs}ms`);
  await assertNoChildren('预热中退出不能残留本次报告的原生进程');
  checks.push({ name: '预检进行中 5 秒内退出且无已报告原生进程残留', exitElapsedMs, observedChildCount: observedChildren.size });
  console.log(JSON.stringify(await save(), null, 2));
} catch (error) {
  await save(error);
  throw error;
} finally { if (app) await app.close(); }

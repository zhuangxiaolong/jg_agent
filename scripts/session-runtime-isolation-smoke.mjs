import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 主进程真实 IPC/SQLite/RuntimeAdapter 集成回归。仅把本次隔离进程的原生 Runtime
// 子进程换成可控 JSONL 端点；不替换 session:send/cancel，不访问真实模型或凭据。
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-isolation-')));
const dataRoot = path.join(root, 'data');
const outputRoot = path.resolve(process.env.JINGGONG_TEST_OUTPUT || path.join(root, 'artifacts'));
await mkdir(outputRoot, { recursive: true });
const checks = [];
const logs = [];
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const boot = () => page.evaluate(() => window.jinggong.bootstrap());
async function events(id) { return page.evaluate(id => window.jinggong.getEvents(id), id); }
async function activeIds() { return [...(await boot()).activeSessionIds].sort(); }
async function fixtureProject(name) {
  const repo = path.join(root, name); await mkdir(repo);
  const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'ignore' });
  git(['init', '-b', 'main']);
  await writeFile(path.join(repo, 'README.md'), `# ${name}\n\n会话隔离集成测试临时项目。\n`);
  git(['add', '.']); git(['-c', 'user.name=会话隔离测试', '-c', 'user.email=isolation@example.invalid', 'commit', '-m', '创建会话隔离测试样本']);
  await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
  return page.evaluate(() => window.jinggong.selectProject());
}
async function send(id, marker) { return page.evaluate(({ id, marker }) => window.jinggong.sendTurn(id, marker), { id, marker }); }
async function record(marker) {
  return app.evaluate((_electron, marker) => globalThis.__sessionRuntimeFixture.records.filter(item => item.turns.some(turn => turn.prompt === marker)).map(item => ({ index: item.index, threadId: item.threadId, turns: item.turns, steers: item.steers, interruptions: item.interruptions, closed: item.closed })), marker);
}
async function notify(marker, type, text) {
  await app.evaluate((_electron, { marker, type, text }) => {
    const state = globalThis.__sessionRuntimeFixture;
    const item = state.records.find(item => item.turns.some(turn => turn.prompt === marker));
    if (!item) throw new Error('未找到测试 Runtime');
    const turn = item.turns.find(turn => turn.prompt === marker);
    if (type === 'message') item.notify('item/agentMessage/delta', { threadId: item.threadId, itemId: `${turn.id}-message`, delta: text });
    else item.notify('turn/completed', { threadId: item.threadId, turn: { id: turn.id, status: type } });
  }, { marker, type, text });
}

try {
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env, cwd: process.cwd() });
  app.process().stdout?.on('data', chunk => logs.push(String(chunk)));
  app.process().stderr?.on('data', chunk => logs.push(String(chunk)));
  page = await app.firstWindow();
  await expect(page.locator('.brand strong')).toHaveText('精工Agent', { timeout: 30000 });
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await app.evaluate(() => {
    const require = process.mainModule.require;
    const childProcess = require('node:child_process');
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const { randomUUID } = require('node:crypto');
    const { syncBuiltinESMExports } = require('node:module');
    const original = childProcess.spawn;
    const state = globalThis.__sessionRuntimeFixture = { records: [] };
    childProcess.spawn = function (command, args, options) {
      if (!/(?:^|[\\/])(?:codex|jinggong-runtime)\.exe$/i.test(String(command)) || args?.[0] !== 'app-server') return original.apply(this, arguments);
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null;
      const item = { index: state.records.length, threadId: undefined, turns: [], steers: [], interruptions: [], closed: false,
        notify(method, params) { child.stdout.write(`${JSON.stringify({ method, params })}\n`); } };
      state.records.push(item);
      let buffer = '';
      const reply = (id, result) => child.stdout.write(`${JSON.stringify({ id, result })}\n`);
      const threadResult = (id, cwd) => ({ thread: { id, environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] }, cwd,
        sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' });
      child.stdin.setEncoding('utf8');
      child.stdin.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const split = buffer.indexOf('\n'); if (split < 0) break;
          const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === undefined) continue;
          const params = message.params ?? {};
          if (message.method === 'initialize') reply(message.id, { userAgent: /jinggong-runtime/i.test(String(command)) ? 'jinggong_runtime/0.1.0' : 'codex_cli_rs/0.156.1' });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') {
            item.threadId = params.threadId ?? randomUUID();
            reply(message.id, threadResult(item.threadId, params.cwd));
          } else if (message.method === 'turn/start') {
            const turn = { id: randomUUID(), status: 'inProgress', prompt: params.input.filter(input => input.type === 'text').map(input => input.text).join('') };
            item.turns.push(turn);
            const acknowledge = () => reply(message.id, { turn: { id: turn.id, status: 'inProgress' } });
            if (turn.prompt === 'MAIN-TERMINAL-BEFORE-ACK') item.acknowledge = acknowledge;
            else acknowledge();
            item.notify('turn/started', { threadId: item.threadId, turn: { id: turn.id, status: 'inProgress' } });
            if (turn.prompt === 'MAIN-TERMINAL-BEFORE-ACK') item.notify('turn/completed', { threadId: item.threadId, turn: { id: turn.id, status: 'completed' } });
          } else if (message.method === 'turn/steer') {
            item.steers.push({ threadId: params.threadId, turnId: params.expectedTurnId, prompt: params.input.filter(input => input.type === 'text').map(input => input.text).join('') });
            reply(message.id, { turnId: params.expectedTurnId });
          } else if (message.method === 'turn/interrupt') {
            item.interruptions.push({ threadId: params.threadId, turnId: params.turnId });
            reply(message.id, {});
            item.notify('turn/completed', { threadId: item.threadId, turn: { id: params.turnId, status: 'interrupted' } });
          } else child.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: `测试端点未实现 ${message.method}` } })}\n`);
        }
      });
      child.stdin.on('finish', () => { item.closed = true; child.exitCode = 0; child.emit('exit', 0, null); });
      return child;
    };
    syncBuiltinESMExports();
  });

  const provider = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '会话隔离临时测试', baseUrl: 'https://isolation.example.invalid/v1', models: ['isolation-fixture'], apiKey: 'fixture-session-isolation-only' }));
  const projectA = await fixtureProject('主进程项目A');
  const projectB = await fixtureProject('主进程项目B');
  const a = await page.evaluate(projectId => window.jinggong.createSession({ projectId, runtimeKind: 'codex', alias: '主进程会话A' }), projectA.id);
  await send(a.id, 'MAIN-A-ROUND-1');
  await expect.poll(activeIds).toEqual([a.id]);
  const b = await page.evaluate(projectId => window.jinggong.createSession({ projectId, runtimeKind: 'codex', alias: '主进程会话B' }), projectB.id);
  const c = await page.evaluate(() => window.jinggong.createSession({ runtimeKind: 'codex', alias: '主进程独立会话C' }));
  assert.notEqual(a.workspacePath, b.workspacePath);
  assert.equal(c.projectId, undefined);
  await page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'isolation-fixture' }), { id: b.id, providerId: provider.id });
  await send(b.id, 'MAIN-B-ROUND-1');
  await expect.poll(activeIds).toEqual([a.id, b.id].sort());
  const [firstA] = await record('MAIN-A-ROUND-1'), [firstB] = await record('MAIN-B-ROUND-1');
  assert.ok(firstA && firstB);
  assert.notEqual(firstA.index, firstB.index);
  assert.notEqual(firstA.threadId, firstB.threadId);
  checks.push('真实 session:send/getRuntime/RuntimeAdapter/JSONL 链路：项目 A 运行中可创建项目 B 和独立 C，会话配置成功，A/B 同时持有独立票据与 Runtime 实例');

  assert.deepEqual(await send(a.id, 'MAIN-A-DUPLICATE'), { queued: false, steered: true });
  assert.equal((await record('MAIN-A-DUPLICATE')).length, 0);
  assert.deepEqual((await record('MAIN-A-ROUND-1'))[0].steers, [{ threadId: firstA.threadId, turnId: firstA.turns[0].id, prompt: 'MAIN-A-DUPLICATE' }]);
  assert.equal((await record('MAIN-B-ROUND-1'))[0].steers.length, 0);
  await expect.poll(activeIds).toEqual([a.id, b.id].sort());
  checks.push('同会话运行中补充通过真实 turn/steer 发往 A 当前轮次，未启动多余 Runtime/turn，也不影响 B 或 A/B 活动状态');

  await page.evaluate(id => window.jinggong.cancelRun(id), a.id);
  await expect.poll(activeIds).toEqual([b.id]);
  assert.equal((await record('MAIN-A-ROUND-1'))[0].closed, true);
  assert.equal((await record('MAIN-A-ROUND-1'))[0].interruptions.length, 1);
  assert.equal((await record('MAIN-B-ROUND-1'))[0].closed, false);
  assert.equal((await record('MAIN-B-ROUND-1'))[0].interruptions.length, 0);
  await notify('MAIN-B-ROUND-1', 'message', 'B在A取消后继续输出');
  await expect.poll(async () => (await events(b.id)).some(event => event.type === 'delta' && event.text === 'B在A取消后继续输出')).toBe(true);
  assert.equal((await events(a.id)).some(event => event.text === 'B在A取消后继续输出'), false);
  checks.push('真实 session:cancel 仅向 A 的实例发 turn/interrupt 并关闭 A，B 持续活动且输出仅保存至 B');

  await send(a.id, 'MAIN-A-ROUND-2');
  const [nextA] = await record('MAIN-A-ROUND-2');
  assert.notEqual(nextA.index, firstA.index);
  assert.equal(nextA.threadId, firstA.threadId, '下一轮通过真实 thread/resume 恢复同一线程');
  await expect.poll(activeIds).toEqual([a.id, b.id].sort());
  const aEventsBeforeLate = await events(a.id);
  await notify('MAIN-A-ROUND-1', 'message', 'OLD-A-LATE');
  await notify('MAIN-A-ROUND-1', 'completed');
  await expect.poll(activeIds).toEqual([a.id, b.id].sort());
  assert.deepEqual(await events(a.id), aEventsBeforeLate);
  assert.deepEqual(await send(a.id, 'MAIN-A-DUPLICATE-2'), { queued: false, steered: true });
  assert.deepEqual((await record('MAIN-A-ROUND-2'))[0].steers, [{ threadId: nextA.threadId, turnId: nextA.turns[0].id, prompt: 'MAIN-A-DUPLICATE-2' }]);
  assert.equal((await record('MAIN-A-ROUND-1'))[0].steers.length, 1);
  checks.push('同线程新轮次恢复后，旧实例的延迟输出和完成事件被丢弃，补充仅送入新实例当前轮次，不能释放新票据或串入新对话');

  await notify('MAIN-B-ROUND-1', 'completed');
  await expect.poll(activeIds).toEqual([a.id]);
  await expect.poll(async () => (await record('MAIN-B-ROUND-1'))[0].closed).toBe(true);
  assert.equal((await boot()).sessions.find(session => session.id === b.id).status, 'completed');
  await notify('MAIN-A-ROUND-2', 'message', 'A第二轮独立完成');
  await notify('MAIN-A-ROUND-2', 'completed');
  await expect.poll(activeIds).toEqual([]);
  await expect.poll(async () => (await record('MAIN-A-ROUND-2'))[0].closed).toBe(true);
  const final = await boot();
  assert.equal(final.sessions.find(session => session.id === a.id).status, 'completed');
  assert.equal(final.sessions.find(session => session.id === c.id).status, 'idle');
  assert.equal((await events(a.id)).some(event => event.text === 'OLD-A-LATE'), false);
  checks.push('B 完成仅释放并关闭 B；A 第二轮独立完成释放并关闭 A，未执行的 C 保持 idle，bootstrap 活动集合回归空');

  await page.evaluate(id => {
    globalThis.__terminalBeforeAckResult = undefined;
    void window.jinggong.sendTurn(id, 'MAIN-TERMINAL-BEFORE-ACK').then(() => { globalThis.__terminalBeforeAckResult = 'resolved'; }, error => { globalThis.__terminalBeforeAckResult = String(error); });
  }, c.id);
  await expect.poll(async () => (await events(c.id)).some(event => event.type === 'status' && event.text === 'completed')).toBe(true);
  assert.equal((await record('MAIN-TERMINAL-BEFORE-ACK'))[0].closed, false, '终态早于 RPC ACK 时不能提前关闭仍待发送结算的实例');
  assert.equal(await page.evaluate(() => globalThis.__terminalBeforeAckResult), undefined);
  await app.evaluate(() => globalThis.__sessionRuntimeFixture.records.find(item => item.turns.some(turn => turn.prompt === 'MAIN-TERMINAL-BEFORE-ACK')).acknowledge());
  await expect.poll(() => page.evaluate(() => globalThis.__terminalBeforeAckResult)).toBe('resolved');
  await expect.poll(async () => (await record('MAIN-TERMINAL-BEFORE-ACK'))[0].closed).toBe(true);
  await expect.poll(activeIds).toEqual([]);
  checks.push('真实 JSONL 交错：turn/completed 早于 turn/start ACK 时保留 pending RPC，补发 ACK 后 send 正常结算并关闭实例');
  const scope = '真实 Electron IPC/SQLite/RuntimeAdapter，原生 Runtime 进程为合成 JSONL 端点；未调用真实模型/Jira';
  await writeFile(path.join(outputRoot, 'session-runtime-isolation-smoke.json'), JSON.stringify({ passed: true, checks, scope, testData: root, outputRoot }, null, 2));
  await writeFile(path.join(outputRoot, 'session-runtime-isolation-smoke.md'), `# 会话 Runtime 隔离回归\n\n结果：通过\n\n${checks.map(check => `- 通过：${check}`).join('\n')}\n\n范围：${scope}\n\n隔离数据：${root}\n`);
  await page.screenshot({ path: path.join(outputRoot, 'session-runtime-isolation-smoke.png'), fullPage: true });
  await writeFile(path.join(outputRoot, 'session-runtime-isolation-smoke.log'), logs.join(''));
  console.log(JSON.stringify({ passed: true, checks, outputRoot }, null, 2));
} catch (error) {
  await writeFile(path.join(outputRoot, 'session-runtime-isolation-smoke.json'), JSON.stringify({ passed: false, checks, error: error instanceof Error ? error.stack : String(error), testData: root, outputRoot }, null, 2));
  await writeFile(path.join(outputRoot, 'session-runtime-isolation-smoke.log'), logs.join(''));
  await page?.screenshot({ path: path.join(outputRoot, 'session-runtime-isolation-smoke-failed.png'), fullPage: true }).catch(() => {});
  console.error(`回归产物：${outputRoot}`);
  throw error;
} finally {
  await app?.close();
}

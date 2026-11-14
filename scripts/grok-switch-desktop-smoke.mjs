import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 Electron 主进程、IPC、SQLite、适配器与 ACP；子进程为合成协议服务，不请求真实模型。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-grok-switch-'));
const home = path.join(root, 'home'), data = path.join(root, 'data');
const executable = path.join(home, '.grok/bin/grok.exe'), server = path.join(root, 'synthetic-acp.mjs');
const main = path.join(root, 'main.cjs'), bootstrap = path.join(root, 'bootstrap.cjs'), diagnostic = path.join(root, 'failure.txt'), checks = [];
await mkdir(path.dirname(executable), { recursive: true });
await mkdir(path.join(root, 'appdata')); await mkdir(path.join(root, 'localappdata'));
await writeFile(executable, '仅供合成 Grok ACP 测试使用');
await writeFile(server, [
  "import readline from 'node:readline';import {randomUUID} from 'node:crypto';",
  "const write=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');let sessionId;let active;",
  "readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);",
  "if(m.method==='initialize')write({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});",
  "else if(m.method==='session/new'){sessionId=randomUUID();write({id:m.id,result:{sessionId,models:{currentModelId:'jinggong-relay'}}});}",
  "else if(m.method==='session/load'){sessionId=m.params.sessionId;write({id:m.id,result:{sessionId}});}",
  "else if(m.method==='session/set_config_option')write({id:m.id,result:{configOptions:[{id:'reasoning_effort',currentValue:m.params.value}]}});",
  "else if(m.method==='session/prompt'){active=m.id;if(m.params.prompt[0].text==='HOLD')return;write({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'合成切换流程回复'}}}});write({id:m.id,result:{stopReason:'end_turn'}});}",
  "else if(m.method==='session/cancel')write({id:active,result:{stopReason:'cancelled'}});});",
].join('\n'));
await build({ entryPoints: ['apps/desktop/src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: main, external: ['electron'], plugins: [{ name: 'fixture-sqljs', setup(build) { build.onResolve({ filter: /^sql\.js$/ }, () => ({ path: path.resolve('node_modules/sql.js/dist/sql-wasm.js'), external: true })); } }], define: { __dirname: JSON.stringify(path.resolve('dist')) }, logLevel: 'silent' });
await writeFile(bootstrap, 'const fs=require("node:fs");const fail=e=>fs.appendFileSync(' + JSON.stringify(diagnostic) + ',String(e?.stack||e)+"\\n");process.on("uncaughtException",fail);process.on("unhandledRejection",fail);require("electron").dialog.showErrorBox=(title,text)=>fail(title+": "+text);require("electron").app.setPath("appData",' + JSON.stringify(path.join(root, 'appdata')) + ');try{require(' + JSON.stringify(main) + ')}catch(e){fail(e);process.exit(1)}');
const env = { ...process.env, JINGGONG_TEST_DATA: data, USERPROFILE: home, HOME: home, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), NODE_PATH: path.resolve('node_modules') };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  try { app = await electron.launch({ args: [bootstrap], env }); }
  catch (error) { throw new Error(String(error.stack || error) + '\n' + await readFile(diagnostic, 'utf8').catch(() => '未记录主进程异常')); }
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.jinggong);
  await app.evaluate((_electron, fixture) => {
    const cp = process.mainModule.require('node:child_process');
    const originalSpawn = cp.spawn, originalExecFile = cp.execFile;
    globalThis.__grokSwitchFixture = { launches: [], calls: [] };
    cp.execFile = function(command, args, options, callback) {
      if (!/(?:^|[\\/])grok\.exe$/i.test(String(command))) return originalExecFile.apply(this, arguments);
      queueMicrotask(() => callback(null, 'grok 1.0.67 (synthetic)\n', ''));
      return { kill() {} };
    };
    cp.spawn = function(command, args, options) {
      if (!/(?:^|[\\/])grok\.exe$/i.test(String(command))) return originalSpawn.apply(this, arguments);
      const child = originalSpawn.call(this, fixture.node, [fixture.server], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
      const launch = { home: options.env.GROK_HOME, pid: child.pid, closed: false };
      globalThis.__grokSwitchFixture.launches.push(launch);
      child.once('exit', () => { launch.closed = true; });
      const originalWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = function(chunk, ...rest) {
        const message = JSON.parse(String(chunk));
        globalThis.__grokSwitchFixture.calls.push({ method: message.method, params: message.params, home: launch.home });
        return originalWrite(chunk, ...rest);
      };
      return child;
    };
    process.mainModule.require('node:module').syncBuiltinESMExports();
  }, { node: process.execPath, server });
  const a = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '合成中转站A', baseUrl: 'https://a.invalid/v1', models: ['model-a', 'model-a2'], apiKey: 'synthetic-switch-key-a' }));
  const b = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '合成中转站B', baseUrl: 'https://b.invalid/v1', models: ['model-b'], apiKey: 'synthetic-switch-key-b' }));
  await page.evaluate(executable => window.jinggong.grok.saveRuntime({ enabled: true, executablePath: executable }), executable);
  const session = await page.evaluate(() => window.jinggong.createSession({ runtimeKind: 'grok_build_acp', alias: '合成切换回归' }));
  async function snapshot() { return page.evaluate(async id => ({ session: (await window.jinggong.bootstrap()).sessions.find(item => item.id === id), events: await window.jinggong.getEvents(id) }), session.id); }
  async function fixture() { return app.evaluate(() => globalThis.__grokSwitchFixture); }
  async function send(prompt) {
    await page.evaluate(({ id, prompt }) => window.jinggong.sendTurn(id, prompt), { id: session.id, prompt });
    await page.waitForFunction(async ({ id, prompt }) => {
      const events = await window.jinggong.getEvents(id);
      const start = events.findIndex(item => item.type === 'user' && item.text === prompt);
      return start >= 0 && events.slice(start + 1).some(item => item.type === 'status' && ['completed', 'failed'].includes(item.text))
        && !(await window.jinggong.bootstrap()).activeSessionIds.includes(id);
    }, { id: session.id, prompt });
    const state = await snapshot(); assert.equal(state.session.status, 'completed', JSON.stringify(state.events));
    assert.ok(state.session.runtimeThreadId); assert.ok(!state.events.some(item => item.type === 'error'), JSON.stringify(state.events));
    return state;
  }
  async function switchTo(providerId, model) {
    const previous = await snapshot();
    const updated = await page.evaluate(({ id, providerId, model }) => window.jinggong.configureSession(id, { providerId, model }), { id: session.id, providerId, model });
    assert.equal(updated.id, session.id); assert.equal(updated.runtimeThreadId, undefined); assert.equal(updated.grokBinding, undefined);
    assert.deepEqual((await snapshot()).events, previous.events);
  }
  const first = await send('第一轮合成历史标记');
  await switchTo(a.id, 'model-a2'); await send('切换同站点模型');
  await switchTo(b.id, 'model-b'); await send('切到中转站B');
  await switchTo(a.id, 'model-a'); const back = await send('切回中转站A原模型');
  assert.notEqual(first.session.runtimeThreadId, back.session.runtimeThreadId);
  let records = await fixture();
  assert.equal(new Set(records.launches.map(item => item.home)).size, 4);
  assert.ok(records.calls.filter(item => item.method === 'session/new').slice(1).every(item => item.params._meta?.rules.includes('第一轮合成历史标记')));
  assert.ok(records.launches.slice(0, -1).every(item => item.closed), JSON.stringify(records.launches));
  checks.push('真实主进程同站点模型切换、A→B→A、旧实例关闭、历史与新会话上下文保留');
  const beforeReasoning = await snapshot();
  await page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'model-a', reasoningEffort: 'high' }), { id: session.id, providerId: a.id });
  assert.equal((await snapshot()).session.runtimeThreadId, beforeReasoning.session.runtimeThreadId);
  await page.evaluate(a => window.jinggong.saveModelProvider({ ...a, baseUrl: 'https://a-changed.invalid/v1', apiKey: 'synthetic-switch-key-a-new' }), { id: a.id, name: a.name, models: a.models });
  await send('同id地址变更后发送');
  records = await fixture();
  assert.equal(new Set(records.launches.map(item => item.home)).size, 5);
  checks.push('只改推理强度保留线程；同providerId地址变更后自动隔离旧home并可发送');
  await page.evaluate(id => { window.__holdingTurn = window.jinggong.sendTurn(id, 'HOLD').catch(error => String(error)); }, session.id);
  await page.waitForFunction(async id => (await window.jinggong.getEvents(id)).at(-1)?.text === 'running', session.id);
  await assert.rejects(page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'model-b' }), { id: session.id, providerId: b.id }), /请等待当前会话/);
  await page.evaluate(id => window.jinggong.cancelRun(id), session.id);
  await page.evaluate(() => window.__holdingTurn);
  checks.push('活动运行期间主进程拒绝改模型，取消后正常结束');
  console.log(JSON.stringify({ passed: true, checks, scope: '真实Electron/IPC/持久化/适配器；合成ACP进程，未调用外部中转站和模型' }, null, 2));
} catch (error) {
  throw new Error(String(error.stack || error) + '\n' + await readFile(diagnostic, 'utf8').catch(() => '未记录主进程异常'));
} finally {
  if (app) { await app.evaluate(() => process.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); }
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

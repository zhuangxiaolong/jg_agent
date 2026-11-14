import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实主进程、IPC、持久化及适配器；仅替换隔离进程的原生 JSONL 端点和 Claude SDK。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-switch-'));
const home = path.join(root, 'home'), data = path.join(root, 'data');
const output = path.resolve(process.env.JINGGONG_TEST_OUTPUT || path.join(root, 'artifacts'));
const main = path.join(root, 'main.cjs'), bootstrap = path.join(root, 'bootstrap.cjs'), diagnostic = path.join(root, 'failure.txt');
const sdk = path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk');
const checks = [], logs = [];
await Promise.all([mkdir(home), mkdir(path.join(root, 'appdata')), mkdir(path.join(root, 'localappdata')), mkdir(sdk, { recursive: true }), mkdir(output, { recursive: true })]);
await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.319', type: 'module', exports: './index.mjs' }));
await writeFile(path.join(sdk, 'index.mjs'), [
  "import {randomUUID} from 'node:crypto';",
  "export const tool=(name,description,inputSchema,handler)=>({name,description,inputSchema,handler});",
  "export const createSdkMcpServer=({name})=>({type:'sdk',name,instance:{close:async()=>{}}});",
  "export function query({prompt,options}){const nativeId=options.resume||randomUUID();const item={kind:'claude_agent_sdk',prompt,model:options.model,baseUrl:options.env.ANTHROPIC_BASE_URL,resume:options.resume,nativeId,instructions:options.appendSystemPrompt||options.systemPrompt?.append,credentialTag:options.env.ANTHROPIC_API_KEY==='synthetic-switch-key-a'?'a':'b'};globalThis.__runtimeSwitchFixture.sdkRecords.push(item);",
  "return {async *[Symbol.asyncIterator](){yield {type:'system',subtype:'init',session_id:nativeId};if(prompt.endsWith('-HOLD'))await new Promise((resolve,reject)=>{if(options.abortController.signal.aborted)reject(new Error('合成取消'));else options.abortController.signal.addEventListener('abort',()=>reject(new Error('合成取消')),{once:true});});yield {type:'assistant',session_id:nativeId,message:{content:[{type:'text',text:'合成 SDK 回复'}]}};yield {type:'result',subtype:'success',session_id:nativeId,is_error:false};},close(){}};}",
].join('\n'));
await build({ entryPoints: ['apps/desktop/src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: main, external: ['electron'], plugins: [{ name: 'fixture-sqljs', setup(build) { build.onResolve({ filter: /^sql\.js$/ }, () => ({ path: path.resolve('node_modules/sql.js/dist/sql-wasm.js'), external: true })); } }], define: { __dirname: JSON.stringify(path.resolve('dist')) }, logLevel: 'silent' });
await writeFile(bootstrap, 'const fs=require("node:fs");const fail=e=>fs.appendFileSync(' + JSON.stringify(diagnostic) + ',String(e?.stack||e)+"\\n");process.on("uncaughtException",fail);process.on("unhandledRejection",fail);require("electron").dialog.showErrorBox=(title,text)=>fail(title+": "+text);require("electron").app.setPath("appData",' + JSON.stringify(path.join(root, 'appdata')) + ');try{require(' + JSON.stringify(main) + ')}catch(e){fail(e);process.exit(1)}');
const env = { ...process.env, JINGGONG_TEST_DATA: data, USERPROFILE: home, HOME: home, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), NODE_PATH: path.resolve('node_modules') };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
try {
  app = await electron.launch({ args: [bootstrap], env });
  app.process().stdout?.on('data', chunk => logs.push(String(chunk)));
  app.process().stderr?.on('data', chunk => logs.push(String(chunk)));
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.jinggong);
  await app.evaluate(() => {
    const require = process.mainModule.require;
    const cp = require('node:child_process'), { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream'), { randomUUID } = require('node:crypto');
    const original = cp.spawn;
    const state = globalThis.__runtimeSwitchFixture = { nativeRecords: [], sdkRecords: [] };
    cp.spawn = function(command, args, options) {
      if (!/(?:^|[\\/])(?:codex|jinggong-runtime)\.exe$/i.test(String(command)) || args?.[0] !== 'app-server') return original.apply(this, arguments);
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
      const config = args.filter((_value, index) => args[index - 1] === '-c');
      const item = { kind: /jinggong-runtime/i.test(String(command)) ? 'jinggong' : 'codex', index: state.nativeRecords.length, config, credentialTag: options.env.JINGGONG_MODEL_API_KEY === 'synthetic-switch-key-a' ? 'a' : 'b', threadId: undefined, calls: [], turns: [], closed: false };
      state.nativeRecords.push(item);
      const write = value => child.stdout.write(JSON.stringify(value) + '\n');
      const reply = (id, result) => write({ id, result });
      const notify = (method, params) => write({ method, params });
      let buffer = '';
      child.stdin.setEncoding('utf8');
      child.stdin.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const split = buffer.indexOf('\n'); if (split < 0) break;
          const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line) continue;
          const message = JSON.parse(line), params = message.params ?? {};
          if (message.id === undefined) continue;
          item.calls.push({ method: message.method, params });
          if (message.method === 'initialize') reply(message.id, { userAgent: item.kind === 'jinggong' ? 'jinggong_runtime/0.1.0' : 'codex_cli_rs/0.156.1' });
          else if (message.method === 'thread/start' || message.method === 'thread/resume') {
            item.threadId = params.threadId ?? randomUUID();
            reply(message.id, { thread: { id: item.threadId, environments: [{ environmentId: 'local', cwd: params.cwd, runtimeWorkspaceRoots: [params.cwd] }] }, cwd: params.cwd, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' });
          } else if (message.method === 'thread/inject_items') reply(message.id, {});
          else if (message.method === 'turn/start') {
            const turn = { id: randomUUID(), prompt: params.input.filter(input => input.type === 'text').map(input => input.text).join('') };
            item.turns.push(turn);
            reply(message.id, { turn: { id: turn.id, status: 'inProgress' } });
            notify('turn/started', { threadId: item.threadId, turn: { id: turn.id, status: 'inProgress' } });
            if (!turn.prompt.endsWith('-HOLD')) setImmediate(() => {
              notify('item/agentMessage/delta', { threadId: item.threadId, itemId: turn.id + '-message', delta: '合成 JSONL 回复' });
              notify('turn/completed', { threadId: item.threadId, turn: { id: turn.id, status: 'completed' } });
            });
          } else if (message.method === 'turn/interrupt') {
            reply(message.id, {}); notify('turn/completed', { threadId: item.threadId, turn: { id: params.turnId, status: 'interrupted' } });
          } else write({ id: message.id, error: { code: -32601, message: '合成端点未实现 ' + message.method } });
        }
      });
      child.stdin.on('finish', () => { item.closed = true; child.exitCode = 0; child.emit('exit', 0, null); });
      return child;
    };
    require('node:module').syncBuiltinESMExports();
  });
  const a = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '合成切换中转站A', baseUrl: 'https://a.invalid/v1', models: ['model-a', 'model-a2'], apiKey: 'synthetic-switch-key-a' }));
  const b = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '合成切换中转站B', baseUrl: 'https://b.invalid/v1', models: ['model-b'], apiKey: 'synthetic-switch-key-b' }));
  for (const kind of ['codex', 'jinggong', 'claude_agent_sdk']) {
    const session = await page.evaluate(kind => window.jinggong.createSession({ runtimeKind: kind, alias: kind + '切换回归' }), kind);
    const snapshot = () => page.evaluate(async id => ({ session: (await window.jinggong.bootstrap()).sessions.find(item => item.id === id), events: await window.jinggong.getEvents(id) }), session.id);
    const records = () => app.evaluate(() => globalThis.__runtimeSwitchFixture);
    async function send(marker) {
      await page.evaluate(({ id, marker }) => window.jinggong.sendTurn(id, marker), { id: session.id, marker });
      await page.waitForFunction(async ({ id, marker }) => {
        const events = await window.jinggong.getEvents(id), start = events.findIndex(item => item.type === 'user' && item.text === marker);
        return start >= 0 && events.slice(start + 1).some(item => item.type === 'status' && ['completed', 'failed'].includes(item.text)) && !(await window.jinggong.bootstrap()).activeSessionIds.includes(id);
      }, { id: session.id, marker });
      const result = await snapshot();
      assert.equal(result.session.status, 'completed', JSON.stringify(result.events));
      assert.ok(result.session.runtimeThreadId); assert.ok(!result.events.some(item => item.type === 'error'), JSON.stringify(result.events));
      return result;
    }
    async function switchTo(providerId, model) {
      const before = await snapshot();
      const updated = await page.evaluate(({ id, providerId, model }) => window.jinggong.configureSession(id, { providerId, model }), { id: session.id, providerId, model });
      assert.equal(updated.runtimeThreadId, undefined); assert.equal(updated.runtimeNativeSessionId, undefined);
      assert.deepEqual((await snapshot()).events, before.events);
    }
    // 明确起始配置，避免默认中转站变化影响验收。
    await page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'model-a' }), { id: session.id, providerId: a.id });
    const marker = kind + '-初始历史标记';
    const states = [await send(marker)];
    await switchTo(a.id, 'model-a2'); states.push(await send(kind + '-同站换模型'));
    await switchTo(b.id, 'model-b'); states.push(await send(kind + '-切到B'));
    await switchTo(a.id, 'model-a'); states.push(await send(kind + '-切回A'));
    assert.equal(new Set(states.map(item => item.session.runtimeThreadId)).size, 4);
    if (kind === 'claude_agent_sdk') assert.equal(new Set(states.map(item => item.session.runtimeNativeSessionId)).size, 4);
    const state = await records();
    if (kind === 'claude_agent_sdk') {
      const selected = state.sdkRecords.filter(item => typeof item.prompt === 'string' && item.prompt.startsWith(kind + '-'));
      assert.deepEqual(selected.map(item => [item.model, item.credentialTag]), [['model-a', 'a'], ['model-a2', 'a'], ['model-b', 'b'], ['model-a', 'a']]);
      assert.ok(selected.every(item => item.resume === undefined));
      assert.ok(selected.slice(1).every(item => item.instructions.includes(marker)));
      assert.deepEqual(selected.map(item => item.baseUrl), ['https://a.invalid', 'https://a.invalid', 'https://b.invalid', 'https://a.invalid']);
    } else {
      const selected = state.nativeRecords.filter(item => item.kind === kind && item.turns.length);
      assert.deepEqual(selected.map(item => [item.turns[0].prompt, item.credentialTag]), [[marker, 'a'], [kind + '-同站换模型', 'a'], [kind + '-切到B', 'b'], [kind + '-切回A', 'a']]);
      for (const [index, item] of selected.entries()) {
        const start = item.calls.find(call => call.method === 'thread/start'); assert.ok(start);
        assert.equal(start.params.model, ['model-a', 'model-a2', 'model-b', 'model-a'][index]);
        assert.ok(item.config.includes('model_providers.jinggong.base_url="https://' + (index === 2 ? 'b' : 'a') + '.invalid/v1"'));
        if (index > 0) assert.ok(start.params.developerInstructions.includes(marker));
      }
    }
    checks.push(kind + '：同站换模型和 A→B→A 均新建原生会话，配置与凭据正确，聊天记录及新会话历史上下文保留');
    const beforeReasoning = await snapshot();
    const configured = await page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'model-a', reasoningEffort: 'high' }), { id: session.id, providerId: a.id });
    assert.equal(configured.runtimeThreadId, beforeReasoning.session.runtimeThreadId);
    assert.equal(configured.runtimeNativeSessionId, beforeReasoning.session.runtimeNativeSessionId);
    assert.deepEqual((await snapshot()).events, beforeReasoning.events);
    const resumed = await send(kind + '-推理强度后续轮');
    assert.equal(resumed.session.runtimeThreadId, configured.runtimeThreadId);
    assert.equal(resumed.session.runtimeNativeSessionId, configured.runtimeNativeSessionId);
    const after = await records();
    if (kind === 'claude_agent_sdk') assert.equal(after.sdkRecords.at(-1).resume, configured.runtimeNativeSessionId);
    else assert.ok(after.nativeRecords.filter(item => item.kind === kind).at(-1).calls.some(call => call.method === 'thread/resume' && call.params.threadId === configured.runtimeThreadId));
    checks.push(kind + '：仅改推理强度保留线程与原生 ID，下一轮恢复原会话');
    const beforeSystem = await snapshot();
    const changedSystem = await page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'model-a', system: 'MES5' }), { id: session.id, providerId: a.id });
    assert.equal(changedSystem.system, 'MES5');
    assert.equal(changedSystem.runtimeThreadId, undefined); assert.equal(changedSystem.runtimeNativeSessionId, undefined);
    assert.deepEqual((await snapshot()).events, beforeSystem.events);
    const withSystem = await send(kind + '-系统切换后续轮');
    assert.notEqual(withSystem.session.runtimeThreadId, beforeSystem.session.runtimeThreadId);
    if (kind === 'claude_agent_sdk') assert.notEqual(withSystem.session.runtimeNativeSessionId, beforeSystem.session.runtimeNativeSessionId);
    const systemRecords = await records();
    if (kind === 'claude_agent_sdk') {
      assert.equal(systemRecords.sdkRecords.at(-1).resume, undefined);
      assert.ok(systemRecords.sdkRecords.at(-1).instructions.includes(marker));
    } else {
      const latest = systemRecords.nativeRecords.filter(item => item.kind === kind).at(-1);
      assert.ok(latest.calls.some(call => call.method === 'thread/start' && call.params.developerInstructions.includes(marker)));
      assert.ok(systemRecords.nativeRecords.filter(item => item.kind === kind && item.threadId === beforeSystem.session.runtimeThreadId).every(item => item.closed));
    }
    const beforeSameSystem = await snapshot();
    const sameSystem = await page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'model-a', system: 'MES5' }), { id: session.id, providerId: a.id });
    assert.equal(sameSystem.runtimeThreadId, beforeSameSystem.session.runtimeThreadId);
    assert.equal(sameSystem.runtimeNativeSessionId, beforeSameSystem.session.runtimeNativeSessionId);
    assert.deepEqual((await snapshot()).events, beforeSameSystem.events);
    const sameSystemRound = await send(kind + '-同系统后续轮');
    assert.equal(sameSystemRound.session.runtimeThreadId, beforeSameSystem.session.runtimeThreadId);
    assert.equal(sameSystemRound.session.runtimeNativeSessionId, beforeSameSystem.session.runtimeNativeSessionId);
    checks.push(kind + '：系统实际改变重建原生会话并保留历史；重复应用同系统保留原生会话');
    await page.evaluate(id => { window.__runtimeSwitchHold = window.jinggong.sendTurn(id, id + '-HOLD').catch(error => String(error)); }, session.id);
    await page.waitForFunction(async id => (await window.jinggong.bootstrap()).activeSessionIds.includes(id), session.id);
    await assert.rejects(page.evaluate(({ id, providerId }) => window.jinggong.configureSession(id, { providerId, model: 'model-b' }), { id: session.id, providerId: b.id }), /请等待当前会话/);
    await page.evaluate(id => window.jinggong.cancelRun(id), session.id);
    await page.evaluate(() => window.__runtimeSwitchHold);
    await page.waitForFunction(async id => !(await window.jinggong.bootstrap()).activeSessionIds.includes(id), session.id);
    checks.push(kind + '：运行期间拒绝改配置，取消后结束');
  }
  const result = { passed: true, checks, scope: '真实 Electron 主进程/IPC/持久化/适配器；合成 JSONL 与 Claude SDK，未调用真实中转站/模型' };
  await writeFile(path.join(output, 'runtime-switch-desktop-smoke.json'), JSON.stringify(result, null, 2));
  await page.screenshot({ path: path.join(output, 'runtime-switch-desktop-smoke.png'), fullPage: true });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const detail = String(error.stack || error) + '\n' + await readFile(diagnostic, 'utf8').catch(() => '未记录主进程异常');
  await writeFile(path.join(output, 'runtime-switch-desktop-smoke.json'), JSON.stringify({ passed: false, checks, error: detail }, null, 2));
  await page?.screenshot({ path: path.join(output, 'runtime-switch-desktop-smoke-failed.png'), fullPage: true }).catch(() => undefined);
  throw new Error(detail);
} finally {
  if (app) { await app.evaluate(() => process.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); }
  await writeFile(path.join(output, 'runtime-switch-desktop-process.log'), logs.join(''));
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

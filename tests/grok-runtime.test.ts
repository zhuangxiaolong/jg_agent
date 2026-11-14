import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GrokBuildRuntimeAdapter, GROK_BUILD_RUNTIME_VERSION, buildGrokEnvironment, grokConfigToml, grokRuntimeReuseKey, type GrokProcessFactory, type GrokRuntimeOptions } from '../packages/agent-runtime/src/grok-adapter';
import type { RuntimeEvent } from '../packages/agent-runtime/src';
import { SessionRuntimes } from '../apps/desktop/src/main/session-runtimes';
import { RunLifecycle } from '../apps/desktop/src/main/lifecycle';
import { SessionFollowups } from '../apps/desktop/src/main/session-followups';
import type { AgentEvent } from '../packages/domain/src';
import { grokExecutionInstructions } from '../packages/agent-runtime/src/grok-config';

const syntheticKey = 'synthetic-grok-test-credential-1';
const serverSource = String.raw`
import readline from 'node:readline';
import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('grok 1.0.67 (synthetic)'); process.exit(0); }
const mode=process.argv[2]; const write=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
let active;let permission=1;const permissions=new Map();let cwd='';
const update=(value)=>write({method:'session/update',params:{sessionId:'synthetic-session',update:value}});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') { if(mode==='hang-init')return; write({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}}); }
 else if(m.method==='session/new'||m.method==='session/load'){cwd=m.params.cwd;write({id:m.id,result:{sessionId:'synthetic-session',models:{currentModelId:'jinggong-relay'}}});}
 else if(m.method==='session/set_config_option'){
  if(mode==='reject-effort')write({id:m.id,error:{code:-32602,message:'不支持所选推理强度'}});
  else write({id:m.id,result:{configOptions:mode==='missing-effort'?[]:[{id:'reasoning_effort',currentValue:mode==='mismatched-effort'?'minimal':m.params.value}]}});
 }
 else if(m.method==='session/prompt') {
  active=m.id; const prompt=m.params.prompt[0].text;
  if(prompt==='exit')process.exit(3);
  else if(prompt==='oversize')process.stdout.write('x'.repeat(4*1024*1024+1));
  else if(prompt==='rpc-error')write({id:m.id,error:{code:-32000,message:'API failed '+process.env.JINGGONG_GROK_API_KEY}});
  else if(prompt==='cancel'||prompt==='cancel-ignore'){}
  else if(['approve','unknown','outside','secret','context','new-tool','allow-always','wrong-session'].includes(prompt)){
   const id='permission-'+(mode==='reuse-permission-id'?1:permission++);permissions.set(id,m.id);
   const file=prompt==='outside'?pathOutside():prompt==='secret'?process.env.GROK_HOME+'/config.toml':prompt==='context'?process.env.GROK_HOME+'/context/dictionary.md':cwd+'/sample.txt';
   const read=prompt==='secret'||prompt==='context';
   const rawInput=read?{variant:'ReadFile',target_file:file}:{variant:'Write',file_path:file,content:'test'};
   write({id,method:'session/request_permission',params:{sessionId:prompt==='wrong-session'?'other-session':'synthetic-session',toolCall:prompt==='new-tool'?{toolCallId:'generic-tool',title:'新的原生工具',kind:'other',rawInput:{arbitrary:true}}:{toolCallId:'tool-1',title:read?'读取文件':'写文件',kind:read?'read':'edit',rawInput,_meta:{'x.ai/tool':{version:1,name:read?'read_file':'write_file',kind:read?'read':'write',namespace:'grok_build',read_only:read,input:read?{path:file}:{path:file}}}},options:prompt==='unknown'?[]:prompt==='allow-always'?[{optionId:'allow-forever',kind:'allow_always',name:'始终允许'}]:[{optionId:'allow-only-once',kind:'allow_once',name:'允许一次'},{optionId:'reject-only-once',kind:'reject_once',name:'拒绝一次'}]}});
  } else {
   if(prompt==='environment')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({xai:process.env.XAI_API_KEY??null,auth:process.env.GROK_AUTH??null,modelBase:process.env.GROK_MODELS_BASE_URL??null,key:!!process.env.JINGGONG_GROK_API_KEY,user:process.env.USERPROFILE,home:process.env.GROK_HOME})}});
   else {update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'隐藏推理'}});update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'中文回答'}});update({sessionUpdate:'tool_call',toolCallId:'tool-1',title:'读取文件',kind:'read',status:'in_progress'});update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed'});}
   write({id:m.id,result:{stopReason:'end_turn'}});
  }
 } else if(m.method==='session/cancel'){if(mode!=='ignore-cancel'&&active)write({id:active,result:{stopReason:'cancelled'}});}
 else if(m.id&&permissions.has(m.id)) { const id=permissions.get(m.id);permissions.delete(m.id); const allowed=['allow-only-once','allow-forever'].includes(m.result?.outcome?.optionId);if(allowed)update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'工具已直接执行'}});write({id,result:{stopReason:allowed?'end_turn':'cancelled'}}); }
});
function pathOutside(){return cwd+'/../outside.txt'}
`;

async function fixture(overrides: Partial<GrokRuntimeOptions> = {}, mode = 'normal') {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-grok-runtime-'));
  const script = path.join(root, 'synthetic.mjs'); await writeFile(script, serverSource);
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const options: GrokRuntimeOptions = { executable: script, home: path.join(root, 'grok-home'), baseUrl: 'https://relay.invalid', model: 'grok-test', apiBackend: 'chat_completions', apiKey: syntheticKey, ...overrides };
  const launches: string[][] = [];
  const processes: GrokProcessFactory = {
    version: (_executable, env) => new Promise((resolve, reject) => execFile(process.execPath, [script, '--version'], { env }, (error, stdout) => error ? reject(error) : resolve(stdout))),
    launch: (_executable, args, opts) => { launches.push(args); return spawn(process.execPath, [script, mode, ...args], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] }); },
    rpcTimeoutMs: 1000, promptTimeoutMs: 5000, cancelTimeoutMs: 100,
  };
  const runtime = new GrokBuildRuntimeAdapter(options, processes);
  const events: RuntimeEvent[] = []; runtime.onEvent(event => events.push(event));
  return { root, script, workspace, options, processes, runtime, events, launches, async close() { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

test('Grok 推理强度逐档通过 ACP 应用并读回，模型默认不声明菜单或强制档位', async () => {
  for (const effort of [undefined, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
    const f = await fixture({ reasoningEffort: effort });
    try {
      const calls = captureRequests(f.runtime);
      await f.runtime.startSession(f.workspace);
      assert.deepEqual(calls.filter(call => call.method === 'session/set_config_option'), effort === undefined ? [] : [{ method: 'session/set_config_option', params: { sessionId: 'synthetic-session', configId: 'reasoning_effort', value: effort } }]);
      const config = await readFile(path.join(f.options.home, 'config.toml'), 'utf8');
      assert.equal(config.includes('reasoning_efforts = ['), effort !== undefined);
      if (effort !== undefined) for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) assert.ok(config.includes(`{ value = "${value}", label = "${value}" }`));
      await f.runtime.sendTurn('synthetic-session', 'plain', f.workspace);
      assert.equal(calls.at(-1)?.method, 'session/prompt');
    } finally { await f.close(); }
  }
});

function captureRequests(runtime: GrokBuildRuntimeAdapter) {
  const calls: Array<{ method: string; params: any }> = [];
  const state = runtime as any, request = state.request.bind(state);
  state.request = async (method: string, params: any, timeout?: number) => { calls.push({ method, params }); return request(method, params, timeout); };
  return calls;
}

test('Grok 新建与冷恢复均携带查询效率要求，保留业务上下文、原始问题和用户推理强度', async () => {
  const original = '保留项目业务要求和权限边界';
  const f = await fixture({ developerInstructions: original, reasoningEffort: 'xhigh' });
  try {
    const calls = captureRequests(f.runtime);
    const id = await f.runtime.startSession(f.workspace);
    const created = calls.find(call => call.method === 'session/new')!;
    assert.equal(created.params._meta.rules, grokExecutionInstructions(original));
    assert.ok(created.params._meta.rules.startsWith(original + '\n'));
    await f.runtime.sendTurn(id, '今天南京的天气怎么样', f.workspace);
    assert.deepEqual(calls.find(call => call.method === 'session/prompt')!.params.prompt, [{ type: 'text', text: '今天南京的天气怎么样' }]);
    assert.equal(calls.find(call => call.method === 'session/set_config_option')!.params.value, 'xhigh');
    await f.runtime.close();
    const recovered = new GrokBuildRuntimeAdapter(f.options, f.processes);
    try {
      const restoredCalls = captureRequests(recovered);
      await recovered.resumeSession(id, f.workspace);
      assert.equal(restoredCalls.find(call => call.method === 'session/load')!.params._meta.rules, created.params._meta.rules);
      assert.equal(restoredCalls.filter(call => call.method === 'session/load').length, 1);
      assert.equal(restoredCalls.find(call => call.method === 'session/set_config_option')!.params.value, 'xhigh');
    } finally { await recovered.close(); }
  } finally { await f.close(); }
});

test('Grok 平台提示仅在 Windows 给出 PowerShell 5.1 约束，简单查询仍要求实时来源', () => {
  const windows = grokExecutionInstructions(undefined, 'win32');
  assert.match(windows, /一次成功取数后复用结构化结果/);
  assert.match(windows, /数据来源和观测\/更新时间/);
  assert.match(windows, /Windows PowerShell 5\.1/);
  assert.match(windows, /不能用 \$\{obj\.property\}/);
  assert.doesNotMatch(grokExecutionInstructions('保留原要求', 'linux'), /Windows PowerShell/);
  assert.ok(grokExecutionInstructions('保留原要求', 'linux').startsWith('保留原要求\n'));
});

test('Grok 冷恢复切换档位与模型默认保留原会话绑定，默认配置不留菜单', async () => {
  const f = await fixture({ reasoningEffort: 'high' });
  try {
    const id = await f.runtime.startSession(f.workspace);
    const binding = await readFile(path.join(f.options.home, 'jinggong-session.json'), 'utf8');
    await f.runtime.close();
    for (const effort of ['low', undefined, 'xhigh'] as const) {
      const recovered = new GrokBuildRuntimeAdapter({ ...f.options, reasoningEffort: effort }, f.processes);
      try {
        const calls = captureRequests(recovered);
        assert.equal(await recovered.resumeSession(id, f.workspace), id);
        assert.deepEqual(calls.map(call => call.method), ['initialize', 'session/load', ...(effort === undefined ? [] : ['session/set_config_option'])]);
        assert.equal(calls.find(call => call.method === 'session/set_config_option')?.params.value, effort);
        assert.equal((await readFile(path.join(f.options.home, 'config.toml'), 'utf8')).includes('reasoning_efforts = ['), effort !== undefined);
        assert.equal(await readFile(path.join(f.options.home, 'jinggong-session.json'), 'utf8'), binding);
        await recovered.sendTurn(id, 'plain', f.workspace);
      } finally { await recovered.close(); }
    }
  } finally { await f.close(); }
});

test('Grok 拒绝、缺失或回显不同推理档位时不发送任务也不降档重试', async () => {
  for (const mode of ['reject-effort', 'missing-effort', 'mismatched-effort']) {
    const f = await fixture({ reasoningEffort: 'high' }, mode);
    try {
      const calls = captureRequests(f.runtime);
      await assert.rejects(f.runtime.startSession(f.workspace), /不支持所选推理强度|未应用所选推理强度/);
      assert.equal(calls.filter(call => call.method === 'session/set_config_option').length, 1);
      assert.equal(calls.some(call => call.method === 'session/prompt'), false);
      assert.equal(f.launches.length, 1);
    } finally { await f.close(); }
  }
});

test('Grok 未知推理档位在启动进程或写配置前拒绝', () => {
  const options: GrokRuntimeOptions = { executable: path.resolve('grok.exe'), home: path.resolve('managed-grok'), baseUrl: 'https://relay.invalid', model: 'grok-test', apiBackend: 'chat_completions' };
  for (const value of ['max', 'HIGH', '', null, 7]) {
    assert.throws(() => new GrokBuildRuntimeAdapter({ ...options, reasoningEffort: value as GrokRuntimeOptions['reasoningEffort'] }), /推理强度无效/);
  }
});

test('Grok ACP 子进程创建异常和 stdout/stderr 管道异常均转为会话错误', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const f = await fixture();
    try {
      const launch = f.processes.launch;
      f.processes.launch = (executable, args, options) => {
        const child = launch(executable, args, options);
        queueMicrotask(() => child[stream].emit('error', Object.assign(new Error('read ECONN'), { code: 'ECONN' })));
        return child;
      };
      await assert.rejects(f.runtime.start(), new RegExp(`Grok ACP ${stream === 'stdout' ? '输出' : '错误输出'}管道已断开（ECONN）`));
    } finally { await f.close(); }
  }

  const f = await fixture();
  try {
    f.processes.launch = () => { throw Object.assign(new Error('spawn failed'), { code: 'ECONN' }); };
    await assert.rejects(f.runtime.start(), /无法启动 Grok ACP 子进程（ECONN）/);
  } finally { await f.close(); }
});

test('Grok ACP 启动 ENOENT 提示 Runtime 路径或目录，其他启动错误保持错误类别', async () => {
  for (const [code, expected] of [
    ['ENOENT', /Grok 可执行文件或工作目录不存在，检查 Runtime 路径\/目录/],
    ['EACCES', /Grok ACP 子进程启动或管道失败（EACCES）/],
  ] as const) {
    const f = await fixture();
    try {
      const launch = f.processes.launch;
      f.processes.launch = (executable, args, options) => {
        const child = launch(executable, args, options);
        queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code })));
        return child;
      };
      await assert.rejects(f.runtime.start(), expected);
    } finally { await f.close(); }
  }

  for (const [code, expected] of [
    ['ENOENT', /Grok 可执行文件或工作目录不存在，检查 Runtime 路径\/目录/],
    ['EACCES', /无法启动 Grok ACP 子进程（EACCES）/],
  ] as const) {
    const f = await fixture();
    try {
      f.processes.launch = () => { throw Object.assign(new Error('spawn failed'), { code }); };
      await assert.rejects(f.runtime.start(), expected);
    } finally { await f.close(); }
  }
});

test('Grok ACP 启动 ENOENT 能区分消失的可执行文件与受管工作目录', async () => {
  for (const missing of ['executable', 'home'] as const) {
    const f = await fixture();
    try {
      const launch = f.processes.launch;
      if (missing === 'executable') {
        f.processes.launch = () => { rmSync(f.script, { force: true }); throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); };
        await assert.rejects(f.runtime.start(), /Grok 可执行文件不存在，检查 Runtime 路径/);
      } else {
        f.processes.launch = () => { rmSync(f.options.home, { recursive: true, force: true }); throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); };
        await assert.rejects(f.runtime.start(), /Grok 工作目录不存在，检查 Runtime 目录/);
      }
    } finally { await f.close(); }
  }
});

async function waitFor(condition: () => boolean): Promise<void> { const deadline = Date.now() + 3000; while (!condition()) { if (Date.now() > deadline) throw new Error('等待合成协议事件超时'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('Grok 静态配置与环境隔离，不含凭据、不允许 xAI 和隐式代理回退', () => {
  const options: GrokRuntimeOptions = { executable: path.resolve('grok.exe'), home: path.resolve('managed-grok'), baseUrl: 'https://relay.invalid', model: 'grok-test', apiBackend: 'chat_completions', apiKey: syntheticKey };
  const config = grokConfigToml(options);
  assert.equal(GROK_BUILD_RUNTIME_VERSION, '1.0.67'); assert.ok(!config.includes(syntheticKey));
  assert.match(config, /base_url = "https:\/\/relay.invalid\/v1"/); assert.match(config, /permission_mode = "always-approve"/); assert.doesNotMatch(config, /ask = \["\*"\]/); assert.match(config, /login_shell_capture = false/);
  assert.match(config, /\[sandbox\]\nprofile = "off"/);
  const env = buildGrokEnvironment(options);
  assert.equal(env.JINGGONG_GROK_API_KEY, syntheticKey); assert.equal(env.XAI_API_KEY, undefined); assert.equal(env.GROK_CODE_XAI_API_KEY, undefined); assert.equal(env.GROK_AUTH, undefined); assert.equal(env.GROK_MODELS_BASE_URL, undefined); assert.equal(env.HTTPS_PROXY, undefined); assert.equal(env.OPENAI_API_KEY, undefined);
  assert.notEqual(env.USERPROFILE, process.env.USERPROFILE);
  assert.equal(buildGrokEnvironment({ ...options, proxyUrl: 'http://127.0.0.1:7890' }).HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.throws(() => grokConfigToml({ ...options, baseUrl: 'http://relay.invalid' }), /HTTPS/);
  assert.throws(() => grokConfigToml({ ...options, baseUrl: 'https://u:p@relay.invalid' }), /凭据/);
  assert.throws(() => grokConfigToml({ ...options, developerInstructions: syntheticKey }), /模型凭据/);
});

test('合成 Grok 子进程完成 ACP 流式/工具生命周期和冷恢复，配置不落密钥', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.runtime.checkRuntime()).compatible, true);
    const id = await f.runtime.startSession(f.workspace); await f.runtime.sendTurn(id, 'plain', f.workspace);
    assert.ok(f.events.some(e => e.type === 'delta' && e.text === '中文回答'));
    assert.ok(!f.events.some(e => e.text.includes('隐藏推理')));
    assert.deepEqual(f.events.filter(e => e.performance).map(e => e.performance?.phase), ['started', 'completed']);
    assert.equal(f.events.at(-1)?.text, 'completed');
    await f.runtime.sendTurn(id, 'environment', f.workspace);
    const environment = JSON.parse(f.events.find(e => e.type === 'delta' && e.text.includes('modelBase'))!.text);
    assert.equal(environment.xai, null); assert.equal(environment.auth, null); assert.equal(environment.modelBase, null); assert.equal(environment.key, true);
    for (const name of ['config.toml', 'managed_config.toml', 'jinggong-profile.json', 'jinggong-session.json']) assert.ok(!(await readFile(path.join(f.options.home, name), 'utf8')).includes(syntheticKey));
    await f.runtime.close();
    const recovered = new GrokBuildRuntimeAdapter(f.options, f.processes);
    try { assert.equal(await recovered.resumeSession(id, f.workspace), id); await recovered.sendTurn(id, 'plain', f.workspace); } finally { await recovered.close(); }
    const wrong = new GrokBuildRuntimeAdapter({ ...f.options, model: 'other-model' }, f.processes);
    try { await assert.rejects(wrong.resumeSession(id, f.workspace), /拒绝复用/); } finally { await wrong.close(); }
  } finally { await f.close(); }
});

for (const prompt of ['approve', 'outside', 'secret', 'context', 'new-tool', 'allow-always']) test(`Grok 全权限自动执行 ${prompt}，不等待 UI 审批`, async () => {
  const f = await fixture();
  try {
    const id = await f.runtime.startSession(f.workspace);
    assert.ok(f.launches[0].includes('--always-approve'));
    await f.runtime.sendTurn(id, prompt, f.workspace);
    assert.equal(f.events.at(-1)?.text, 'completed');
    assert.ok(f.events.some(e => e.type === 'delta' && e.text === '工具已直接执行'));
    assert.ok(!f.events.some(e => e.type === 'approval'));
    await assert.rejects(f.runtime.respondApproval('old-request', 'allow_once'), /已失效/);
  } finally { await f.close(); }
});

for (const prompt of ['unknown', 'wrong-session']) test(`Grok 全权限仍拒绝 ${prompt} 无效协议或跨会话请求`, async () => {
  const f = await fixture();
  try { const id = await f.runtime.startSession(f.workspace); await f.runtime.sendTurn(id, prompt, f.workspace); assert.equal(f.events.at(-1)?.text, 'interrupted'); assert.ok(!f.events.some(e => e.type === 'approval')); } finally { await f.close(); }
});

test('Grok cancel 通知与不响应取消进程均能收敛为 interrupted', async () => {
  for (const mode of ['normal', 'ignore-cancel']) {
    const f = await fixture({}, mode);
    try { const id = await f.runtime.startSession(f.workspace); const turn = f.runtime.sendTurn(id, 'cancel', f.workspace); await waitFor(() => f.events.some(e => e.text === 'running')); await f.runtime.cancelRun(id); await turn; assert.equal(f.events.at(-1)?.text, 'interrupted'); } finally { await f.close(); }
  }
});

test('Grok 协议错误、超长行和进程退出真实拒绝且不泄漏凭据', async () => {
  for (const prompt of ['rpc-error', 'oversize', 'exit']) {
    const f = await fixture();
    try { const id = await f.runtime.startSession(f.workspace); await assert.rejects(f.runtime.sendTurn(id, prompt, f.workspace), error => { assert.ok(!(error as Error).message.includes(syntheticKey)); return true; }); assert.ok(f.events.some(e => e.type === 'error')); assert.ok(!JSON.stringify(f.events).includes(syntheticKey)); } finally { await f.close(); }
  }
});

test('Grok 初始化超时回收真实子进程，版本不匹配拒绝启动', async () => {
  const f = await fixture({}, 'hang-init'); f.processes.rpcTimeoutMs = 30;
  try { await assert.rejects(f.runtime.start(), /超时/); } finally { await f.close(); }
  const mismatch = await fixture(); mismatch.processes.version = async () => 'grok 1.0.68';
  try { assert.equal((await mismatch.runtime.checkRuntime()).compatible, false); await assert.rejects(mismatch.runtime.start(), /版本不兼容/); assert.deepEqual(await readdir(mismatch.root), ['synthetic.mjs', 'workspace']); } finally { await mismatch.close(); }
});

test('Grok 缺失凭据、未绑定工作区和图片明确失败，不会切换 Runtime', async () => {
  const f = await fixture({ apiKey: undefined });
  try { const id = await f.runtime.startSession(f.workspace); await assert.rejects(f.runtime.sendTurn(id, 'plain', f.workspace), /API Key/); assert.equal(f.runtime.kind, 'grok_build_acp'); } finally { await f.close(); }
});

test('Grok 同配置连续三轮复用进程和原生会话，票据与监听逐轮更新', async () => {
  const f = await fixture({ reasoningEffort: 'high' });
  const registry = new SessionRuntimes();
  const runs = new RunLifecycle();
  try {
    const calls = captureRequests(f.runtime);
    let versions = 0;
    const version = f.processes.version;
    f.processes.version = async (...args) => { versions++; return version(...args); };
    const key = await grokRuntimeReuseKey(f.options, f.workspace);
    let id = '';
    const turnEvents: RuntimeEvent[][] = [];
    for (let i = 0; i < 3; i++) {
      const ticket = runs.begin('platform-session');
      const runtime = registry.takeReusable(ticket, key) ?? f.runtime;
      registry.bind(ticket, runtime, key);
      const events: RuntimeEvent[] = []; turnEvents.push(events);
      registry.setEventSubscription(ticket, runtime, runtime.onEvent(event => events.push(event)));
      await runtime.start();
      id = id ? await runtime.resumeSession(id, f.workspace) : await runtime.startSession(f.workspace);
      await runtime.sendTurn(id, 'plain', f.workspace);
      await registry.markTerminal(ticket, runtime, true);
      await registry.markSendSettled(ticket, runtime);
      runs.finish(ticket);
    }
    assert.equal(versions, 1);
    assert.equal(f.launches.length, 1);
    assert.deepEqual(calls.map(call => call.method), ['initialize', 'session/new', 'session/set_config_option', 'session/prompt', 'session/prompt', 'session/prompt']);
    for (const events of turnEvents) {
      assert.equal(events.filter(event => event.type === 'delta').length, 1);
      assert.equal(events.at(-1)?.text, 'completed');
    }
  } finally { await registry.closeAll(); await f.close(); }
});

test('Grok 复用摘要覆盖凭据、模型、协议、推理强度、规则、目录与组件变化', async () => {
  const f = await fixture();
  try {
    const key = await grokRuntimeReuseKey(f.options, f.workspace);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.ok(!key.includes(syntheticKey));
    assert.equal(await grokRuntimeReuseKey({ ...f.options }, f.workspace), key);
    const changes: Partial<GrokRuntimeOptions>[] = [
      { apiKey: 'different-synthetic-key' }, { model: 'other-model' }, { apiBackend: 'responses' },
      { baseUrl: 'https://other.invalid/v1' }, { reasoningEffort: 'low' },
      { proxyUrl: 'http://127.0.0.1:7890' }, { developerInstructions: '新的开发要求' },
      { home: path.join(f.root, 'other-home') },
    ];
    for (const change of changes) assert.notEqual(await grokRuntimeReuseKey({ ...f.options, ...change }, f.workspace), key);
    assert.notEqual(await grokRuntimeReuseKey(f.options, path.join(f.root, 'other-workspace')), key);
    await writeFile(f.script, serverSource + '\n// 组件已更新\n');
    assert.notEqual(await grokRuntimeReuseKey(f.options, f.workspace), key);
  } finally { await f.close(); }
});

test('Grok 热会话跨轮复用权限请求ID仍能完成工具闭环', async () => {
  const f = await fixture({}, 'reuse-permission-id');
  try {
    const id = await f.runtime.startSession(f.workspace);
    for (let turn = 0; turn < 3; turn++) {
      await f.runtime.resumeSession(id, f.workspace);
      await f.runtime.sendTurn(id, 'approve', f.workspace);
    }
    assert.equal(f.launches.length, 1);
    assert.equal(f.events.filter(event => event.type === 'delta' && event.text === '工具已直接执行').length, 3);
    assert.equal(f.events.filter(event => event.type === 'status' && event.text === 'completed').length, 3);
  } finally { await f.close(); }
});

test('Grok 空闲保活不会阻断运行中排队的补充任务', async () => {
  const f = await fixture();
  const registry = new SessionRuntimes(), runs = new RunLifecycle();
  const history: AgentEvent[] = [];
  try {
    const key = await grokRuntimeReuseKey(f.options, f.workspace);
    const ticket = runs.begin('platform-session');
    registry.bind(ticket, f.runtime, key);
    const id = await f.runtime.startSession(f.workspace);
    let dispatched = 0;
    const followups = new SessionFollowups({
      events: () => history,
      publish: (sessionId, type, text, requestId) => history.push({ id: String(history.length), sessionId, type, text, requestId, createdAt: new Date().toISOString() }),
      ready: sessionId => !runs.get(sessionId) && !registry.hasActive(sessionId),
      execute: async (sessionId, turn) => {
        const next = runs.begin(sessionId);
        const runtime = registry.takeReusable(next, key);
        assert.equal(runtime, f.runtime);
        registry.bind(next, runtime!, key);
        followups.begin(sessionId, turn.id);
        await runtime!.resumeSession(id, f.workspace);
        await runtime!.sendTurn(id, turn.prompt, f.workspace);
        followups.markDispatched(sessionId, turn.id);
        await registry.markTerminal(next, runtime!, true);
        await registry.markSendSettled(next, runtime!);
        runs.finish(next); dispatched++;
      },
    });
    followups.enqueue(ticket.sessionId, 'plain');
    await followups.drain(ticket.sessionId);
    assert.equal(dispatched, 0);
    await f.runtime.sendTurn(id, 'plain', f.workspace);
    await registry.markTerminal(ticket, f.runtime, true);
    await registry.markSendSettled(ticket, f.runtime);
    runs.finish(ticket);
    await followups.drain(ticket.sessionId);
    assert.equal(dispatched, 1);
    assert.equal(followups.pending(ticket.sessionId).length, 0);
    assert.equal(f.launches.length, 1);
    assert.equal(f.events.filter(event => event.type === 'status' && event.text === 'completed').length, 2);
  } finally { await registry.closeAll(); await f.close(); }
});

test('Grok 热恢复仍核对持久化绑定，进程失败后必须重新加载会话', async () => {
  const f = await fixture({ reasoningEffort: 'medium' });
  try {
    const calls = captureRequests(f.runtime);
    const id = await f.runtime.startSession(f.workspace);
    const file = path.join(f.options.home, 'jinggong-session.json');
    const original = await readFile(file, 'utf8');
    await writeFile(file, JSON.stringify({ ...JSON.parse(original), sessionId: 'other-session' }));
    await assert.rejects(f.runtime.resumeSession(id, f.workspace), /拒绝恢复/);
    await writeFile(file, original);
    await (f.runtime as any).fail(new Error('合成空闲进程退出'));
    await f.runtime.resumeSession(id, f.workspace);
    assert.equal(f.launches.length, 2);
    assert.deepEqual(calls.map(call => call.method), ['initialize', 'session/new', 'session/set_config_option', 'initialize', 'session/load', 'session/set_config_option']);
    await f.runtime.sendTurn(id, 'plain', f.workspace);
    assert.equal(f.events.at(-1)?.text, 'completed');
  } finally { await f.close(); }
});

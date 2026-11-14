import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { CodexRuntime, CodexRuntimeAdapter, JinggongRuntimeAdapter, runtimeConfigOverrides, runtimeEnvironment, type RuntimeOptions } from '../packages/agent-runtime/src';
import { COMPUTER_TOOL, normalizeComputerToolInput, parseComputerAction } from '../packages/agent-runtime/src/computer-tool';
import { buildRuntimeExecutionInstructions, RUNTIME_EXECUTION_RULES_VERSION } from '../packages/agent-runtime/src/execution-instructions';

const waitFor = (predicate: () => boolean, timeout = 500): Promise<void> => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => predicate() ? resolve() : Date.now() - started >= timeout ? reject(new Error('等待 Runtime 测试状态超时')) : setTimeout(tick, 1);
  tick();
});

test('共享查询指引按实际 Shell 提供兼容建议并保留原任务', () => {
  const windows = buildRuntimeExecutionInstructions('原始业务要求', 'win32');
  assert.ok(windows.startsWith('原始业务要求\n'));
  assert.match(windows, /一次成功取数后复用结构化结果/);
  assert.match(windows, /先确认当前工具的实际 Shell，Bash 工具保持 Bash 语法/);
  assert.match(windows, /Invoke-WebRequest 和 ConvertFrom-Json 均没有 -Encoding 参数/);
  assert.match(windows, /localObsDateTime/);
  assert.doesNotMatch(buildRuntimeExecutionInstructions('原始业务要求', 'linux'), /Windows Shell|wttr.in\/Nanjing/);
});

test('Codex 与精工旧会话补入一次持久化执行指引，保留线程、用户任务及推理档位', async () => {
  const cwd = process.cwd();
  for (const Adapter of [CodexRuntimeAdapter, JinggongRuntimeAdapter]) {
    const options: RuntimeOptions = { executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: '原模型', apiKey: 'synthetic-upgrade-key', reasoningEffort: 'high', executionRulesVersion: RUNTIME_EXECUTION_RULES_VERSION - 1 };
    const runtime = new CodexRuntime(options), state = runtime as any, adapter = new Adapter(runtime);
    const calls: Array<{ method: string; params: any }> = [];
    state.start = async () => { state.initialized = true; };
    state.createBroker = async () => ({});
    state.request = async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === 'thread/resume') return { thread: { id: 'legacy-thread', environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] }, cwd, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
      if (method === 'thread/inject_items') return {};
      if (method === 'turn/start') return { turn: { id: 'query-turn', status: 'completed' } };
      throw new Error(`不应调用 ${method}`);
    };
    try {
      assert.equal(await adapter.resumeSession('legacy-thread', cwd), 'legacy-thread');
      const inject = calls.find(call => call.method === 'thread/inject_items')!.params;
      assert.deepEqual(inject, { threadId: 'legacy-thread', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: buildRuntimeExecutionInstructions() }] }] });
      await adapter.resumeSession('legacy-thread', cwd);
      assert.equal(calls.filter(call => call.method === 'thread/inject_items').length, 1);
      await adapter.sendTurn('legacy-thread', '用户明确指定的原始问题', cwd);
      const turn = calls.find(call => call.method === 'turn/start')!.params;
      assert.equal(turn.threadId, 'legacy-thread');
      assert.equal(turn.model, '原模型');
      assert.equal(turn.effort, 'high');
      assert.equal(turn.input[0].text, '用户明确指定的原始问题');
    } finally { await runtime.close(); }
  }
});

test('执行指引注入失败不能标记完成，下次恢复重试；新建及已升级会话不重复注入', async () => {
  const cwd = process.cwd();
  const options: RuntimeOptions = { executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', executionRulesVersion: 0 };
  const runtime = new CodexRuntime(options), state = runtime as any;
  let attempts = 0;
  const calls: string[] = [];
  state.start = async () => { state.initialized = true; };
  state.createBroker = async () => ({});
  state.request = async (method: string, params: any) => {
    calls.push(method);
    if (method === 'thread/inject_items') { if (++attempts === 1) throw new Error('合成注入失败'); return {}; }
    assert.ok(method === 'thread/resume' || method === 'thread/start');
    if (method === 'thread/start') assert.match(params.developerInstructions, /【查询执行效率】/);
    return { thread: { id: method === 'thread/start' ? 'new-thread' : params.threadId, environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] }, cwd, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
  };
  try {
    await assert.rejects(runtime.resumeSession('old-thread', cwd), /合成注入失败/);
    assert.equal(state.executionRulesApplied.has('old-thread'), false);
    assert.equal(await runtime.resumeSession('old-thread', cwd), 'old-thread');
    await runtime.resumeSession('old-thread', cwd);
    assert.equal(attempts, 2);
    const fresh = await runtime.startSession(cwd);
    await runtime.resumeSession(fresh, cwd);
    assert.equal(attempts, 2);
    runtime.rebindTurnContext({ ...options, executionRulesVersion: RUNTIME_EXECUTION_RULES_VERSION });
    await runtime.resumeSession('upgraded-thread', cwd);
    assert.equal(attempts, 2);
    assert.equal(calls.filter(method => method === 'thread/start').length, 1);
  } finally { await runtime.close(); }
});

test('Runtime 环境只继承系统工具链变量，不把数据库和宿主凭据传入子进程', () => {
  const previous = {
    JINGGONG_EXECUTION_FIXTURE: process.env.JINGGONG_EXECUTION_FIXTURE,
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DOTNET_ROOT: process.env.DOTNET_ROOT,
  };
  process.env.JINGGONG_EXECUTION_FIXTURE = 'fixture';
  process.env.DATABASE_URL = 'postgres://user:password@host/db';
  process.env.DB_PASSWORD = 'database-password';
  process.env.DOTNET_ROOT = 'toolchain-path';
  try {
    const environment = runtimeEnvironment('fixture-home', 'model-key');
    assert.equal(environment.CODEX_HOME, 'fixture-home');
    assert.equal(environment.JINGGONG_MODEL_API_KEY, 'model-key');
    assert.equal(environment.JINGGONG_EXECUTION_FIXTURE, undefined);
    assert.equal(environment.DATABASE_URL, undefined);
    assert.equal(environment.DB_PASSWORD, undefined);
    assert.equal(environment.DOTNET_ROOT, 'toolchain-path');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Runtime 默认完全访问并自动执行工具', () => {
  const config = runtimeConfigOverrides({ shellToolEnabled: false });
  assert.equal(config.sandbox_mode, 'danger-full-access');
  assert.equal(config.approval_policy, 'never');
  assert.equal(config.approvals_reviewer, undefined);
  assert.equal(config['features.shell_tool'], false);
  assert.equal(config['web_search'], 'live');
  assert.equal(config['sandbox_workspace_write.network_access'], undefined);
  assert.equal(config['windows.sandbox'], undefined);
  assert.equal(runtimeConfigOverrides({})['features.shell_tool'], true);
});

test('Runtime 自动继续当前 thread/turn 的普通命令和文件变更请求', async () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' });
  const state = runtime as any;
  const replies: any[] = [];
  const events: any[] = [];
  const cwd = process.cwd();
  state.write = (message: any) => replies.push(message);
  state.sessions.add('current-thread');
  state.sessionRoots.set('current-thread', cwd);
  state.setActive('current-thread', 'current-turn');
  runtime.onEvent(event => events.push(event));
  try {
    state.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-1', kind: 'command', command: 'npm test', cwd, reason: '需要执行测试' } });
    await waitFor(() => replies.some(reply => reply.id === 1));
    assert.deepEqual(replies.find(reply => reply.id === 1).result, { decision: 'accept' });
    assert.equal(events.some(event => event.type === 'approval'), false);

    state.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-1', kind: 'command', command: 'npm test' } });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replies.filter(reply => reply.id === 1).length, 1, '同一协议请求 ID 不得重复响应');

    state.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-2' } });
    await waitFor(() => replies.some(reply => reply.id === 2));
    assert.deepEqual(replies.find(reply => reply.id === 2).result, { decision: 'accept' });

    state.receive({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'other-thread', turnId: 'current-turn', itemId: 'item-3', command: 'npm test' } });
    await waitFor(() => replies.some(reply => reply.id === 3));
    assert.deepEqual(replies.find(reply => reply.id === 3).result, { decision: 'decline' });

    state.receive({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-4', command: 'npm test', proposedExecpolicyAmendment: { root: 'D:\\' } } });
    await waitFor(() => replies.some(reply => reply.id === 4));
    assert.deepEqual(replies.find(reply => reply.id === 4).result, { decision: 'decline' });
    state.receive({ id: 5, method: 'item/fileChange/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-5', cwd: path.resolve(`${cwd}-outside`) } });
    await waitFor(() => replies.some(reply => reply.id === 5));
    assert.deepEqual(replies.find(reply => reply.id === 5).result, { decision: 'accept' });
  } finally {
    await runtime.close();
  }
});

test('Runtime 自动继续工作区外协议 writeStdin 输入，未知类型和跨会话任务仍拒绝', async () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' });
  const state = runtime as any;
  const replies: any[] = [], events: any[] = [];
  const cwd = process.cwd();
  state.write = (message: any) => replies.push(message);
  state.sessions.add('stdin-thread'); state.sessionRoots.set('stdin-thread', cwd); state.setActive('stdin-thread', 'stdin-turn');
  runtime.onEvent(event => events.push(event));
  const base = { kind: 'writeStdin', threadId: 'stdin-thread', turnId: 'stdin-turn', itemId: 'terminal-item', startedAtMs: Date.now(), approvalId: 'stdin-callback', environmentId: 'local', cwd };
  let id = 0;
  const decision = async (params: Record<string, unknown>) => {
    const requestId = ++id;
    state.receive({ id: requestId, method: 'item/commandExecution/requestApproval', params });
    await waitFor(() => replies.some(reply => reply.id === requestId));
    return replies.find(reply => reply.id === requestId).result.decision;
  };
  try {
    assert.equal(await decision(base), 'accept', 'writeStdin 可以省略 command');
    assert.equal(await decision({ ...base, command: null, cwd: null, environmentId: null }), 'accept', '原生协议可省略命令和目录，由当前会话绑定');
    assert.equal(await decision({ ...base, command: 'Y\n', cwd: path.join(cwd, 'packages') }), 'accept');
    assert.equal(await decision({ ...base, cwd: path.resolve(`${cwd}-outside`) }), 'accept');
    for (const change of [
      { kind: 'unknown', command: 'npm test' },
      { kind: 'write_stdin', command: 'Y' },
      { command: { input: 'Y' } },
      { environmentId: 'remote' },
      { threadId: 'other-thread' },
      { turnId: 'other-turn' },
      { cwd: 'relative-path' },
      { cwd: `${cwd}\u0000invalid` },
      { additionalPermissions: { fileSystem: { write: [path.dirname(cwd)] } } },
      { proposedExecpolicyAmendment: { root: path.dirname(cwd) } },
    ]) assert.equal(await decision({ ...base, ...change }), 'decline');
    state.clearActive('stdin-thread');
    assert.equal(await decision(base), 'decline', '任务结束后不向旧终端继续输入');
    assert.equal(events.some(event => event.type === 'approval'), false);
  } finally { await runtime.close(); }
});

test('Runtime 额外权限请求只返回当前 turn 的空权限，不增加目录或逐次审查', async () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' });
  const state = runtime as any;
  const replies: any[] = [], events: any[] = [];
  state.write = (message: any) => replies.push(message);
  runtime.onEvent(event => events.push(event));
  const request = { id: 'extra-permissions', method: 'item/permissions/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', environmentId: 'local', startedAtMs: Date.now(), cwd: process.cwd(), permissions: { network: { enabled: true }, fileSystem: { write: [path.dirname(process.cwd())] } } } };
  try {
    state.receive(request); state.receive(request);
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0], { id: request.id, result: { permissions: {}, scope: 'turn', strictAutoReview: false } });
    assert.equal(events.some(event => event.type === 'approval'), false);
  } finally { await runtime.close(); }
});

test('Runtime 会话始终使用完全访问并注册开发工具', async () => {
  const cwd = process.cwd();
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'unit-runtime-key', beforeWrite: async () => undefined, browser: async () => ({ text: 'ok' }), computer: async () => ({ text: 'ok' }) });
  const state = runtime as any;
  state.start = async () => undefined;
  state.createBroker = async () => ({ });
  const calls: Array<{ method: string; params: any }> = [];
  state.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'runtime-thread', environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] }, cwd, sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
    if (method === 'turn/start') return { turn: { id: 'runtime-turn', status: 'completed' } };
    throw new Error(`unexpected ${method}`);
  };
  try {
    const threadId = await runtime.startSession(cwd);
    assert.equal(threadId, 'runtime-thread');
    const start = calls.find(call => call.method === 'thread/start')!.params;
    assert.equal(start.sandbox, 'danger-full-access');
    assert.deepEqual(start.dynamicTools.map((tool: { name: string }) => tool.name), ['list_project_files', 'read_project_file', 'write_project_file', 'delete_project_file', 'publish_change_plan', 'search_dictionary', 'read_dictionary', 'browser_action', 'computer_action']);
    assert.doesNotMatch(start.developerInstructions, /只读|逐次审批|限制/);
    await assert.rejects(runtime.sendTurn(threadId, '开发任务', path.resolve(`${cwd}-outside`)), /与当前会话不一致/);
    await runtime.sendTurn(threadId, '开发任务', cwd);
    const turn = calls.find(call => call.method === 'turn/start')!.params;
    assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' });
  } finally { await runtime.close(); }
});

test('Runtime 浏览器工具按会话和 turn 绑定校验', async () => {
  let browserCalls = 0;
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', browser: async () => { browserCalls += 1; return { text: 'ok' }; } });
  const state = runtime as any;
  const replies: any[] = [];
  state.write = (message: any) => replies.push(message);
  state.sessions.add('browser-thread');
  state.setActive('browser-thread', 'browser-turn');
  try {
    state.receive({ id: 1, method: 'item/tool/call', params: { tool: 'browser_action', threadId: 'browser-thread', turnId: 'browser-turn', namespace: 'functions', arguments: { action: 'click', ref: 'button-1' } } });
    await waitFor(() => replies.some(reply => reply.id === 1));
    assert.deepEqual(replies[0].result, { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] });
    assert.equal(browserCalls, 1);
  } finally { await runtime.close(); }
});

test('computer-use 工具启用固定 Runtime 能力并绑定当前会话与 turn', async () => {
  let release: ((value: { text: string; imageUrl?: string }) => void) | undefined;
  let actionSignal: AbortSignal | undefined;
  const actions: unknown[] = [];
  const runtime = new CodexRuntime({
    executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model',
    computer: async (input, signal) => { actions.push(input); actionSignal = signal; assert.equal(signal.aborted, false); return new Promise(resolve => { release = resolve; }); },
  });
  const state = runtime as any;
  state.start = async () => undefined;
  state.createBroker = async () => ({});
  const calls: Array<{ method: string; params: any }> = [];
  state.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'computer-thread', environments: [{ environmentId: 'local', cwd: process.cwd(), runtimeWorkspaceRoots: [process.cwd()] }] }, cwd: process.cwd(), sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
    throw new Error(`unexpected ${method}`);
  };
  const replies: any[] = [];
  state.write = (message: any) => replies.push(message);
  try {
    await runtime.startSession(process.cwd());
    const start = calls[0].params;
    assert.ok(start.dynamicTools.some((tool: { name: string }) => tool.name === COMPUTER_TOOL.name));
    assert.equal(runtimeConfigOverrides({ computer: async () => ({ text: 'ok' }) })['features.computer_use'], true);
    assert.equal(runtimeConfigOverrides({})['features.computer_use'], false);
    state.setActive('computer-thread', 'computer-turn');
    state.receive({ id: 'screen-1', method: 'item/tool/call', params: { tool: 'computer_action', threadId: 'computer-thread', turnId: 'computer-turn', namespace: 'functions', arguments: { action: 'screenshot' } } });
    await waitFor(() => !!release);
    assert.deepEqual(actions, [{ action: 'screenshot' }]);
    state.setActive('computer-thread', 'next-turn');
    assert.equal(actionSignal?.aborted, true, '旧 turn 结束时必须取消在途桌面动作');
    release!({ text: 'captured', imageUrl: 'data:image/png;base64,dGVzdA==' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(replies.some(reply => reply.id === 'screen-1'), false, '切换 turn 后不回写旧任务的桌面结果');
    state.setActive('computer-thread', 'computer-turn-2');
    state.receive({ id: 'screen-2', method: 'item/tool/call', params: { tool: 'computer_action', threadId: 'computer-thread', turnId: 'computer-turn-2', namespace: 'functions', arguments: { action: 'click', x: 20, y: 30 } } });
    await waitFor(() => !!release);
    release!({ text: 'clicked', imageUrl: 'data:image/png;base64,dGVzdA==' });
    await waitFor(() => replies.some(reply => reply.id === 'screen-2'));
    assert.deepEqual(replies.find(reply => reply.id === 'screen-2').result.contentItems.map((item: any) => item.type), ['inputText', 'inputImage']);
  } finally { await runtime.close(); }
});

test('computer-use 只接受有限动作、坐标和按键白名单', () => {
  assert.deepEqual(parseComputerAction({ action: 'click', x: 10, y: 20 }), { action: 'click', x: 10, y: 20, button: 'left' });
  assert.deepEqual(normalizeComputerToolInput('computer', { action: 'left_click', coordinate: [10, 20] }), { action: 'click', x: 10, y: 20, button: 'left' });
  assert.throws(() => parseComputerAction({ action: 'click', x: 10, y: 20, script: 'bad' }), /桌面操作参数无效/);
  assert.throws(() => parseComputerAction({ action: 'click', x: 40000, y: 20 }), /桌面操作参数无效/);
  assert.throws(() => parseComputerAction({ action: 'press', key: 'CTRL+DELETE+L' }), /桌面操作参数无效/);
  assert.throws(() => parseComputerAction({ action: 'type', text: 'x'.repeat(4001) }), /桌面操作参数无效/);
});

test('Runtime 环境回显必须绑定本地会话并启用完全访问，拒绝静默降权', () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' });
  const state = runtime as any;
  const cwd = process.cwd();
  const environment = { environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] };
  const base = { approvalPolicy: 'never', cwd };
  const writable = {
    ...base,
    sandbox: { type: 'dangerFullAccess' },
    thread: { environments: [environment] },
  };
  const writableRuntime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' }) as any;
  assert.doesNotThrow(() => writableRuntime.assertExecutionEnvironment(writable, cwd));
  for (const invalid of [
    { ...writable, sandbox: { type: 'readOnly' } },
    { ...writable, sandbox: { type: 'workspaceWrite', networkAccess: true, writableRoots: [cwd] } },
    { ...writable, sandbox: undefined },
    { ...writable, thread: { environments: [] } },
    { ...writable, thread: { environments: [{ ...environment, environmentId: 'remote' }] } },
    { ...writable, thread: { environments: [{ ...environment, cwd: `${cwd}-outside` }] } },
    { ...writable, thread: { environments: [{ ...environment, runtimeWorkspaceRoots: [`${cwd}-outside`] }] } },
    { ...writable, approvalPolicy: 'on-request' },
  ]) assert.throws(() => writableRuntime.assertExecutionEnvironment(invalid, cwd), /未启用预期/);
});

test('Codex 连续两轮复用已就绪会话，工具与写入授权使用新轮回调', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-codex-warm-'));
  let current = 1, starts = 0;
  const callbacks: string[] = [], calls: string[] = [], replies: any[] = [];
  const options = (turn: number): RuntimeOptions => ({
    executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-warm-key',
    beforeWrite: async () => { assert.equal(current, turn); callbacks.push(`write-${turn}`); },
    browser: async () => { assert.equal(current, turn); callbacks.push(`browser-${turn}`); return { text: `browser-${turn}` }; },
    toolGateway: async (_request, execute) => { assert.equal(current, turn); callbacks.push(`gateway-${turn}`); return execute(); },
    authorizedDirectories: () => ({ mode: 'full', directories: [] }),
    requestDirectoryAccess: async () => { assert.equal(current, turn); callbacks.push(`authorize-${turn}`); return { granted: true }; },
  });
  const runtime = new CodexRuntime(options(1));
  const adapter = new CodexRuntimeAdapter(runtime), state = runtime as any;
  state.start = async () => { if (!state.initialized) { starts++; state.initialized = true; } };
  state.write = (message: any) => replies.push(message);
  state.request = async (method: string, params: any) => {
    calls.push(method);
    if (method === 'thread/start' || method === 'thread/resume') return {
      thread: { id: 'warm-thread', environments: [{ environmentId: 'local', cwd: root, runtimeWorkspaceRoots: [root] }] }, cwd: root,
      sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
    };
    assert.equal(method, 'turn/start');
    const turnId = `turn-${current}`;
    state.receive({ method: 'turn/started', params: { threadId: 'warm-thread', turn: { id: turnId } } });
    const tool = (tool: string, args: unknown) => ({ tool, arguments: args, turnId, namespace: 'functions' });
    await state.handleReadTool(10 + current, tool('write_project_file', { path: `turn-${current}.ts`, content: `// 第 ${current} 轮\n` }), 'warm-thread');
    await state.handleReadTool(20 + current, tool('request_authorized_directory', {}), 'warm-thread');
    await state.handleBrowserTool(30 + current, tool('browser_action', { action: 'state' }), 'warm-thread');
    state.receive({ method: 'turn/completed', params: { threadId: 'warm-thread', turn: { id: turnId, status: 'completed' } } });
    // 保留真实协议允许的交错：终态早于 turn/start Promise 的微任务。
    return { turn: { id: turnId, status: 'inProgress' } };
  };
  try {
    const id = await adapter.startSession(root);
    const firstBroker = state.readBrokers.get(id);
    await adapter.sendTurn(id, '第一轮合成工具闭环', root);
    assert.equal(state.active.size, 0);
    current = 2;
    adapter.rebindTurnContext(options(2));
    assert.equal(state.readBrokers.size, 0);
    assert.equal(state.authorizedDirectoryBrokers.size, 0);
    assert.equal(await adapter.resumeSession(id, root), id);
    assert.notEqual(state.readBrokers.get(id), firstBroker);
    await adapter.sendTurn(id, '第二轮合成工具闭环', root);
    assert.equal(starts, 1);
    assert.deepEqual(calls, ['thread/start', 'turn/start', 'turn/start']);
    assert.deepEqual(callbacks, ['gateway-1', 'write-1', 'gateway-1', 'authorize-1', 'browser-1', 'gateway-2', 'write-2', 'gateway-2', 'authorize-2', 'browser-2']);
    assert.equal(replies.length, 6);
    assert.ok(replies.every(reply => reply.result.success));
    assert.equal(await readFile(path.join(root, 'turn-2.ts'), 'utf8'), '// 第 2 轮\n');
    assert.equal(state.active.size, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex 热恢复拒绝跨工作区并重新检查项目目录，关闭后走正常冷恢复', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-codex-recover-'));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const options: RuntimeOptions = { executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' };
  const runtime = new CodexRuntime(options), state = runtime as any;
  let starts = 0;
  const calls: string[] = [];
  state.start = async () => { if (!state.initialized) { starts++; state.initialized = true; } };
  state.request = async (method: string) => {
    calls.push(method);
    return { thread: { id: 'recover-thread', environments: [{ environmentId: 'local', cwd: workspace, runtimeWorkspaceRoots: [workspace] }] }, cwd: workspace,
      sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
  };
  try {
    const id = await runtime.startSession(workspace);
    await assert.rejects(runtime.resumeSession(id, root), /不能跨工作区热恢复/);
    await rm(workspace, { recursive: true });
    await assert.rejects(runtime.resumeSession(id, workspace), /ENOENT/);
    await mkdir(workspace);
    assert.equal(await runtime.resumeSession(id, workspace), id);
    assert.deepEqual(calls, ['thread/start']);
    await runtime.close();
    runtime.rebindTurnContext(options);
    assert.equal(await runtime.resumeSession(id, workspace), id);
    assert.equal(starts, 2);
    assert.deepEqual(calls, ['thread/start', 'thread/resume']);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('Codex 与精工 Adapter 仅在空闲时重绑平台回调，不修改静态模型与规则', async () => {
  for (const Adapter of [CodexRuntimeAdapter, JinggongRuntimeAdapter]) {
    const original: RuntimeOptions = { executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'original-model', developerInstructions: '原始规则' };
    const runtime = new CodexRuntime(original), state = runtime as any, adapter = new Adapter(runtime);
    const replacement = { ...original, model: 'different-model', developerInstructions: '不同规则', browser: async () => ({ text: '新轮回调' }) };
    try {
      for (const busy of ['active', 'pending', 'starting', 'closing', 'inflightTools']) {
        if (busy === 'active') state.active.set('thread', 'turn');
        else if (busy === 'pending') state.pending.set(1, {});
        else state[busy] = busy === 'starting' ? Promise.resolve() : busy === 'inflightTools' ? 1 : true;
        assert.throws(() => adapter.rebindTurnContext(replacement), /尚未空闲/);
        if (busy === 'active' || busy === 'pending') state[busy].clear();
        else state[busy] = busy === 'starting' ? undefined : busy === 'inflightTools' ? 0 : false;
      }
      adapter.rebindTurnContext(replacement);
      assert.equal(state.options.model, 'original-model');
      assert.equal(state.options.developerInstructions, '原始规则');
      assert.equal(await state.options.browser().then((result: any) => result.text), '新轮回调');
    } finally { await runtime.close(); }
  }
});

test('Codex 长会话可在新轮复用已结算权限请求ID，单轮重复仍只回复一次', async () => {
  const cwd = process.cwd();
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'fixture-key' }), state = runtime as any;
  const replies: any[] = [];
  state.sessions.add('thread'); state.sessionRoots.set('thread', cwd);
  state.write = (reply: any) => replies.push(reply);
  let turn = 0;
  state.request = async () => {
    const turnId = `turn-${++turn}`;
    state.receive({ method: 'turn/started', params: { threadId: 'thread', turn: { id: turnId } } });
    const request = { id: 'repeat-permission-id', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId, itemId: 'command', command: 'npm test', cwd } };
    state.receive(request); state.receive(request);
    state.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status: 'completed' } } });
    return { turn: { id: turnId, status: 'inProgress' } };
  };
  try {
    for (let index = 0; index < 3; index++) await runtime.sendTurn('thread', '合成协议，不请求模型', cwd);
    assert.equal(replies.length, 3);
    assert.ok(replies.every(reply => reply.result.decision === 'accept'));
    assert.equal(state.active.size, 0);
  } finally { await runtime.close(); }
});

test('Codex 原生终态先于平台工具返回时仍禁止重绑，旧工具结算后才允许复用', async () => {
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const options: RuntimeOptions = { executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', browser: async () => { await gate; return { text: '旧轮工具完成' }; } };
  const runtime = new CodexRuntime(options), state = runtime as any;
  state.sessions.add('thread'); state.sessionRoots.set('thread', process.cwd()); state.setActive('thread', 'turn');
  state.write = () => undefined;
  try {
    state.receive({ id: 'slow-tool', method: 'item/tool/call', params: { tool: 'browser_action', threadId: 'thread', turnId: 'turn', arguments: { action: 'state' } } });
    assert.equal(state.inflightTools, 1);
    state.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    assert.equal(state.active.size, 0);
    assert.throws(() => runtime.rebindTurnContext(options), /尚未空闲/);
    complete();
    await waitFor(() => state.inflightTools === 0);
    assert.doesNotThrow(() => runtime.rebindTurnContext(options));
  } finally { complete(); await runtime.close(); }
});

test('Codex 空闲输入断管立即失效并冷恢复，旧进程迟到事件不能关闭新连接', { timeout: 30000 }, async t => {
  if (process.platform !== 'win32') return t.skip('仅验证 Windows 原生 Codex 管道与恢复');
  const executable = path.resolve('apps/desktop/resources/runtime/codex/bin/codex.exe');
  try { await access(executable); } catch { return t.skip('请先部署固定版本 Codex Runtime'); }
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-codex-idle-pipe-')));
  const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const runtime = new CodexRuntime({ executable, home: path.join(root, 'home'), baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' }), state = runtime as any;
  const request = state.request.bind(state), calls: string[] = [];
  state.request = (method: string, params: unknown) => { calls.push(method); return request(method, params); };
  try {
    const id = await runtime.startSession(workspace);
    await state.request('thread/inject_items', { threadId: id, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '断管恢复协议验证，不请求外部模型。' }] }] });
    const oldChild = state.child;
    oldChild.stdin.emit('error', new Error('合成空闲 EPIPE'));
    assert.equal(state.initialized, false);
    assert.equal(state.sessions.size, 0);
    assert.equal(state.readBrokers.size, 0);
    await assert.rejects(runtime.start(), /正在关闭/);
    await runtime.close();
    assert.equal(await runtime.resumeSession(id, workspace), id);
    const child = state.child;
    assert.notEqual(child, oldChild);
    oldChild.stdin.emit('error', new Error('旧输入管道迟到错误'));
    oldChild.emit('error', new Error('旧进程迟到错误'));
    oldChild.emit('exit', 1, null);
    oldChild.stdout.emit('data', '旧进程损坏数据\n');
    assert.equal(state.child, child);
    assert.equal(state.initialized, true);
    assert.equal(await runtime.resumeSession(id, workspace), id);
    assert.equal(calls.filter(method => method === 'initialize').length, 2);
    assert.equal(calls.filter(method => method === 'thread/resume').length, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

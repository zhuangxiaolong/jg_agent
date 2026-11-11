import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexRuntime, runtimeConfigOverrides, runtimeEnvironment } from '../packages/agent-runtime/src';

const waitFor = (predicate: () => boolean, timeout = 500): Promise<void> => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => predicate() ? resolve() : Date.now() - started >= timeout ? reject(new Error('等待 Runtime 测试状态超时')) : setTimeout(tick, 1);
  tick();
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

test('Runtime 固定 workspace-write 并自动执行工具', () => {
  const config = runtimeConfigOverrides({ shellToolEnabled: false });
  assert.equal(config.sandbox_mode, 'workspace-write');
  assert.equal(config.approval_policy, 'never');
  assert.equal(config.approvals_reviewer, undefined);
  assert.equal(config['features.shell_tool'], false);
  assert.equal(config['web_search'], 'live');
  assert.equal(config['sandbox_workspace_write.network_access'], true);
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
    assert.deepEqual(replies.find(reply => reply.id === 5).result, { decision: 'decline' });
  } finally {
    await runtime.close();
  }
});

test('Runtime 自动继续协议 writeStdin 输入，未知类型和跨会话任务目录仍拒绝', async () => {
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
    for (const change of [
      { kind: 'unknown', command: 'npm test' },
      { kind: 'write_stdin', command: 'Y' },
      { command: { input: 'Y' } },
      { environmentId: 'remote' },
      { threadId: 'other-thread' },
      { turnId: 'other-turn' },
      { cwd: path.resolve(`${cwd}-outside`) },
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

test('Runtime 会话始终使用 workspace-write 并注册开发工具', async () => {
  const cwd = process.cwd();
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'unit-runtime-key', beforeWrite: async () => undefined, browser: async () => ({ text: 'ok' }) });
  const state = runtime as any;
  state.start = async () => undefined;
  state.createBroker = async () => ({ });
  const calls: Array<{ method: string; params: any }> = [];
  state.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'runtime-thread', environments: [{ environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] }] }, cwd, sandbox: { type: 'workspaceWrite', networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true, writableRoots: [cwd] }, approvalPolicy: 'never' };
    if (method === 'turn/start') return { turn: { id: 'runtime-turn', status: 'completed' } };
    throw new Error(`unexpected ${method}`);
  };
  try {
    const threadId = await runtime.startSession(cwd);
    assert.equal(threadId, 'runtime-thread');
    const start = calls.find(call => call.method === 'thread/start')!.params;
    assert.equal(start.sandbox, 'workspace-write');
    assert.deepEqual(start.dynamicTools.map((tool: { name: string }) => tool.name), ['list_project_files', 'read_project_file', 'write_project_file', 'delete_project_file', 'publish_change_plan', 'search_dictionary', 'read_dictionary', 'browser_action']);
    assert.doesNotMatch(start.developerInstructions, /只读|逐次审批|限制/);
    await assert.rejects(runtime.sendTurn(threadId, '开发任务', path.resolve(`${cwd}-outside`)), /与当前会话不一致/);
    await runtime.sendTurn(threadId, '开发任务', cwd);
    const turn = calls.find(call => call.method === 'turn/start')!.params;
    assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
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

test('Runtime 环境回显必须绑定本地会话路径并使用 workspace-write', () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' });
  const state = runtime as any;
  const cwd = process.cwd();
  const environment = { environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] };
  const base = { approvalPolicy: 'never', cwd };
  const writable = {
    ...base,
    sandbox: { type: 'workspaceWrite', networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true, writableRoots: [cwd] },
    thread: { environments: [environment] },
  };
  const writableRuntime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' }) as any;
  assert.doesNotThrow(() => writableRuntime.assertExecutionEnvironment(writable, cwd));
  assert.doesNotThrow(() => writableRuntime.assertExecutionEnvironment({ ...writable, sandbox: { ...writable.sandbox, writableRoots: [] } }, cwd));
  for (const invalid of [
    { ...writable, sandbox: { ...writable.sandbox, networkAccess: false } },
    { ...writable, sandbox: { ...writable.sandbox, excludeTmpdirEnvVar: false } },
    { ...writable, sandbox: { ...writable.sandbox, excludeSlashTmp: false } },
    { ...writable, sandbox: { ...writable.sandbox, writableRoots: [`${cwd}-outside`] } },
    { ...writable, thread: { environments: [] } },
    { ...writable, thread: { environments: [{ ...environment, environmentId: 'remote' }] } },
    { ...writable, thread: { environments: [{ ...environment, cwd: `${cwd}-outside` }] } },
    { ...writable, thread: { environments: [{ ...environment, runtimeWorkspaceRoots: [`${cwd}-outside`] }] } },
    { ...writable, approvalPolicy: 'on-request' },
  ]) assert.throws(() => writableRuntime.assertExecutionEnvironment(invalid, cwd), /未启用预期/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
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

test('隔离只读子任务可以关闭通用 shell 工具，默认会话兼容原配置', () => {
  assert.equal(runtimeConfigOverrides({ readOnly: true, shellToolEnabled: false })['features.shell_tool'], false);
  assert.equal(runtimeConfigOverrides({ readOnly: true })['features.shell_tool'], true);
  assert.equal(runtimeConfigOverrides({ readOnly: true, shellToolEnabled: false }).sandbox_mode, 'read-only');
  assert.equal(runtimeConfigOverrides({ readOnly: true })['web_search'], 'live');
  assert.equal(runtimeConfigOverrides({ readOnly: false })['web_search'], 'live');
  assert.equal(runtimeConfigOverrides({ readOnly: false })['sandbox_workspace_write.network_access'], false);
});

test('审批请求只接受一次并绑定当前 thread、turn，结果仅发送 accept 或 decline', async () => {
  const requests: any[] = [];
  const decisions: ((decision: 'accept' | 'decline') => void)[] = [];
  const runtime = new CodexRuntime({
    executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model',
    onApprovalRequest: request => new Promise(resolve => { requests.push(request); decisions.push(resolve); }),
  });
  const state = runtime as any;
  const replies: any[] = [];
  const events: any[] = [];
  state.write = (message: any) => replies.push(message);
  state.sessions.add('current-thread');
  state.setActive('current-thread', 'current-turn');
  runtime.onEvent(event => events.push(event));
  try {
    state.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-1', kind: 'command', command: 'npm test', cwd: 'D:\\workspace', reason: '需要执行测试' } });
    await waitFor(() => requests.length === 1);
    assert.equal(requests[0].kind, 'command');
    assert.equal(requests[0].summary, 'npm test');
    assert.equal(requests[0].signal.aborted, false);
    decisions[0]('accept');
    await waitFor(() => replies.some(reply => reply.id === 1));
    assert.deepEqual(replies.find(reply => reply.id === 1).result, { decision: 'accept' });
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(events.some(event => event.type === 'approval'), false, '审批不应落入 AgentEvent/SQLite');

    state.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-1', kind: 'command', command: 'npm test' } });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replies.filter(reply => reply.id === 1).length, 1, '同一协议请求 ID 不得重复响应');

    state.receive({ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-2' } });
    await waitFor(() => requests.length === 2);
    assert.equal(requests[1].kind, 'fileChange');
    decisions[1]('decline');
    await waitFor(() => replies.some(reply => reply.id === 2));
    assert.deepEqual(replies.find(reply => reply.id === 2).result, { decision: 'decline' });

    state.receive({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 'other-thread', turnId: 'current-turn', itemId: 'item-3', command: 'npm test' } });
    await waitFor(() => replies.some(reply => reply.id === 3));
    assert.deepEqual(replies.find(reply => reply.id === 3).result, { decision: 'decline' });

    state.receive({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: 'current-thread', turnId: 'current-turn', itemId: 'item-4', command: 'npm test', proposedExecpolicyAmendment: { root: 'D:\\' } } });
    await waitFor(() => replies.some(reply => reply.id === 4));
    assert.deepEqual(replies.find(reply => reply.id === 4).result, { decision: 'decline' });
  } finally {
    await runtime.close();
  }
});

test('任务清理和审批超时取消 AbortSignal，并拒绝晚到决定', async () => {
  const requests: any[] = [];
  const decisions: ((decision: 'accept' | 'decline') => void)[] = [];
  const runtime = new CodexRuntime({
    executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', approvalTimeoutMs: 15,
    onApprovalRequest: request => new Promise(resolve => { requests.push(request); decisions.push(resolve); }),
  });
  const state = runtime as any;
  const replies: any[] = [];
  state.write = (message: any) => replies.push(message);
  state.sessions.add('thread-cancel');
  state.setActive('thread-cancel', 'turn-cancel');
  try {
    state.receive({ id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-cancel', turnId: 'turn-cancel', itemId: 'item-cancel', command: 'npm test' } });
    await waitFor(() => requests.length === 1);
    state.clearActive('thread-cancel');
    await waitFor(() => replies.some(reply => reply.id === 10));
    assert.deepEqual(replies.find(reply => reply.id === 10).result, { decision: 'decline' });
    assert.equal(requests[0].signal.aborted, true);
    decisions[0]('accept');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replies.filter(reply => reply.id === 10).length, 1);

    state.sessions.add('thread-timeout');
    state.setActive('thread-timeout', 'turn-timeout');
    state.receive({ id: 11, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-timeout', turnId: 'turn-timeout', itemId: 'item-timeout', command: 'npm test' } });
    await waitFor(() => requests.length === 2);
    await waitFor(() => replies.some(reply => reply.id === 11), 300);
    assert.deepEqual(replies.find(reply => reply.id === 11).result, { decision: 'decline' });
    assert.equal(requests[1].signal.aborted, true);

    state.sessions.add('thread-complete');
    state.setActive('thread-complete', 'turn-complete');
    state.receive({ id: 12, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-complete', turnId: 'turn-complete', itemId: 'item-complete' } });
    await waitFor(() => requests.length === 3);
    state.receive({ method: 'turn/completed', params: { threadId: 'thread-complete', turn: { id: 'turn-complete', status: 'completed' } } });
    await waitFor(() => replies.some(reply => reply.id === 12));
    assert.deepEqual(replies.find(reply => reply.id === 12).result, { decision: 'decline' });
    assert.equal(requests[2].signal.aborted, true);

    state.sessions.add('thread-close');
    state.setActive('thread-close', 'turn-close');
    state.receive({ id: 13, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-close', turnId: 'turn-close', itemId: 'item-close', command: 'npm test' } });
    await waitFor(() => requests.length === 4);
    await runtime.close();
    assert.deepEqual(replies.find(reply => reply.id === 13).result, { decision: 'decline' });
    assert.equal(requests[3].signal.aborted, true);
  } finally {
    await runtime.close();
  }
});

test('需求准入只读模式不注册写工具，并在 thread 与 turn 协议中使用 readOnly sandbox', async () => {
  const cwd = process.cwd();
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', apiKey: 'unit-read-only-key', readOnly: true, beforeWrite: async () => { throw new Error('只读模式不应调用写入回调'); } });
  const state = runtime as any;
  state.start = async () => undefined;
  state.createBroker = async () => ({ });
  const calls: Array<{ method: string; params: any }> = [];
  state.request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'read-only-thread', environments: [] }, cwd, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
    if (method === 'turn/start') return { turn: { id: 'read-only-turn', status: 'completed' } };
    throw new Error(`unexpected ${method}`);
  };
  try {
    const threadId = await runtime.startSession(cwd);
    assert.equal(threadId, 'read-only-thread');
    const start = calls.find(call => call.method === 'thread/start')!.params;
    assert.equal(start.sandbox, 'read-only');
    assert.deepEqual(start.dynamicTools.map((tool: { name: string }) => tool.name), ['list_project_files', 'read_project_file', 'publish_change_plan', 'search_dictionary', 'read_dictionary']);
    assert.ok(!start.dynamicTools.some((tool: { name: string }) => tool.name === 'browser_action'));
    assert.match(start.developerInstructions, /只读沙箱/);
    await runtime.sendTurn(threadId, '只读分析', cwd);
    const turn = calls.find(call => call.method === 'turn/start')!.params;
    assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  } finally { await runtime.close(); }
});

test('需求准入只读模式拒绝 Runtime 文件变更审批，即使用户审批回调返回 accept', async () => {
  let approvalCalls = 0;
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', readOnly: true, onApprovalRequest: async () => { approvalCalls += 1; return 'accept'; } });
  const state = runtime as any;
  const replies: any[] = [];
  state.write = (message: any) => replies.push(message);
  state.sessions.add('read-only-thread');
  state.setActive('read-only-thread', 'read-only-turn');
  try {
    state.receive({ id: 1, method: 'item/fileChange/requestApproval', params: { threadId: 'read-only-thread', turnId: 'read-only-turn', itemId: 'item-write' } });
    await waitFor(() => replies.some(reply => reply.id === 1));
    assert.deepEqual(replies.find(reply => reply.id === 1).result, { decision: 'decline' });
    assert.equal(approvalCalls, 0);
  } finally { await runtime.close(); }
});

test('需求准入只读模式拒绝浏览器操作，不调用会话浏览器回调', async () => {
  let browserCalls = 0;
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', readOnly: true, browser: async () => { browserCalls += 1; return { text: 'must not happen' }; } });
  const state = runtime as any;
  const replies: any[] = [];
  state.write = (message: any) => replies.push(message);
  state.sessions.add('read-only-thread');
  state.setActive('read-only-thread', 'read-only-turn');
  try {
    state.receive({ id: 1, method: 'item/tool/call', params: { tool: 'browser_action', threadId: 'read-only-thread', turnId: 'read-only-turn', namespace: 'functions', arguments: { action: 'click', ref: 'button-1' } } });
    await waitFor(() => replies.some(reply => reply.id === 1));
    assert.deepEqual(replies[0].result, { success: false, contentItems: [{ type: 'inputText', text: '浏览器工具未绑定当前会话和任务，或当前会话处于只读模式' }] });
    assert.equal(browserCalls, 0);
  } finally { await runtime.close(); }
});

test('Runtime 环境回显必须绑定本地会话路径并保留只读沙箱与逐项审批', () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model', readOnly: true });
  const state = runtime as any;
  const cwd = process.cwd();
  const environment = { environmentId: 'local', cwd, runtimeWorkspaceRoots: [cwd] };
  const base = { approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd };
  const readOnly = { ...base, sandbox: { type: 'readOnly', networkAccess: false }, thread: { environments: [environment] } };
  const readOnlyWithoutEnvironment = { ...readOnly, thread: { environments: [] } };
  assert.doesNotThrow(() => state.assertExecutionEnvironment(readOnly, cwd));
  assert.doesNotThrow(() => state.assertExecutionEnvironment(readOnlyWithoutEnvironment, cwd));
  for (const invalid of [
    { ...readOnly, sandbox: { type: 'workspaceWrite', networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true, writableRoots: [cwd] } },
    { ...readOnly, sandbox: { ...readOnly.sandbox, networkAccess: true } },
    { ...readOnly, sandbox: { ...readOnly.sandbox, writableRoots: [cwd] } },
    { ...readOnly, thread: { environments: undefined } },
    { ...readOnly, thread: { environments: [null] } },
    { ...readOnly, thread: { environments: [environment, environment] } },
    { ...readOnly, thread: { environments: [{ ...environment, environmentId: 'remote' }] } },
    { ...readOnly, thread: { environments: [{ ...environment, cwd: `${cwd}-outside` }] } },
    { ...readOnly, thread: { environments: [{ ...environment, runtimeWorkspaceRoots: [] }] } },
    { ...readOnly, thread: { environments: [{ ...environment, runtimeWorkspaceRoots: [cwd, `${cwd}-outside`] }] } },
    { ...readOnly, approvalPolicy: 'never' },
    { ...readOnly, approvalsReviewer: 'auto' },
    { ...readOnly, cwd: `${cwd}-outside` },
  ]) assert.throws(() => state.assertExecutionEnvironment(invalid, cwd), /未启用预期/);

  const writable = {
    ...base,
    sandbox: { type: 'workspaceWrite', networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true, writableRoots: [cwd] },
    thread: { environments: [environment] },
  };
  const writableRuntime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture-model' }) as any;
  assert.doesNotThrow(() => writableRuntime.assertExecutionEnvironment(writable, cwd));
  // workspace-write 将 cwd 隐含为可写根，额外 writableRoots 可以为空。
  assert.doesNotThrow(() => writableRuntime.assertExecutionEnvironment({ ...writable, sandbox: { ...writable.sandbox, writableRoots: [] } }, cwd));
  for (const invalid of [
    readOnly,
    { ...writable, sandbox: { ...writable.sandbox, networkAccess: true } },
    { ...writable, sandbox: { ...writable.sandbox, excludeTmpdirEnvVar: false } },
    { ...writable, sandbox: { ...writable.sandbox, excludeSlashTmp: false } },
    { ...writable, sandbox: { ...writable.sandbox, writableRoots: [`${cwd}-outside`] } },
    { ...writable, thread: { environments: [] } },
    { ...writable, thread: { environments: [{ ...environment, environmentId: 'remote' }] } },
    { ...writable, thread: { environments: [{ ...environment, cwd: `${cwd}-outside` }] } },
    { ...writable, thread: { environments: [{ ...environment, runtimeWorkspaceRoots: [`${cwd}-outside`] }] } },
    { ...writable, approvalPolicy: 'never' },
    { ...writable, approvalsReviewer: 'auto' },
  ]) assert.throws(() => writableRuntime.assertExecutionEnvironment(invalid, cwd), /未启用预期/);
});

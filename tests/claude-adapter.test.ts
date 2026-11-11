import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentSdkRuntimeAdapter, CLAUDE_AGENT_SDK_RUNTIME_VERSION, claudeReadOnlyNetworkInstruction, claudeRelayBaseUrl, isClaudeReadOnlyTool, normalizeClaudeSdkMessage, type ClaudeSdkModule, type ClaudeSdkQueryOptions } from '../packages/agent-runtime/src/claude-adapter';

test('Claude 复用通用中转站时避免重复追加 /v1，保留自定义前缀', () => {
  assert.equal(claudeRelayBaseUrl('https://relay.example.invalid/v1'), 'https://relay.example.invalid');
  assert.equal(claudeRelayBaseUrl('https://relay.example.invalid/anthropic/v1/'), 'https://relay.example.invalid/anthropic');
  assert.equal(claudeRelayBaseUrl('https://relay.example.invalid/anthropic'), 'https://relay.example.invalid/anthropic');
});
test('Claude 只读提示允许公开网页查询且只限制交互式浏览器', () => {
  const instruction = claudeReadOnlyNetworkInstruction();
  assert.match(instruction, /WebSearch/);
  assert.match(instruction, /WebFetch/);
  assert.match(instruction, /browser_action/);
  assert.match(instruction, /登录态/);
  assert.doesNotMatch(instruction, /不可调用浏览器工具/);
});

test('Claude SDK 消息归一化只输出可展示文本并脱敏', () => {
  assert.deepEqual(normalizeClaudeSdkMessage({ type: 'system', subtype: 'init', session_id: 'native-1' }), { type: 'status', text: 'Claude Runtime 会话已启动', nativeSessionId: 'native-1' });
  assert.deepEqual(normalizeClaudeSdkMessage({ type: 'stream_event', session_id: 'native-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'token sk-secret12345' } } }, 'sk-secret12345'), { type: 'delta', text: 'token [已脱敏]', nativeSessionId: 'native-1' });
  assert.deepEqual(normalizeClaudeSdkMessage({ type: 'tool_progress', tool_name: 'Read', session_id: 'native-1' }), { type: 'tool', text: 'Claude 工具执行中：Read', nativeSessionId: 'native-1' });
  assert.deepEqual(normalizeClaudeSdkMessage({ type: 'result', subtype: 'success', session_id: 'native-1' }), { type: 'status', text: 'completed', nativeSessionId: 'native-1', terminal: true });
});

test('Claude 实际调用与连接测试都使用通用中转站地址和凭据', async () => {
  const cwd = join(tmpdir(), `claude-adapter-endpoints-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const optionsSeen: ClaudeSdkQueryOptions[] = [];
  const sdk: ClaudeSdkModule = {
    query({ options }: { prompt: string; options: ClaudeSdkQueryOptions }) {
      optionsSeen.push(options);
      return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; } };
    },
  };
  const adapter = new ClaudeAgentSdkRuntimeAdapter({
    model: 'claude-test', apiKey: 'sk-test-secret', relayBaseUrl: 'https://relay.example.invalid/anthropic',
    executablePath, sdkLoader: async () => sdk,
  });
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, '执行实际调用', cwd);
    assert.equal(optionsSeen[0].env?.ANTHROPIC_BASE_URL, 'https://relay.example.invalid/anthropic');
    assert.equal(optionsSeen[0].env?.ANTHROPIC_API_KEY, 'sk-test-secret');
    await adapter.testConnection(cwd);
    assert.equal(optionsSeen[1].env?.ANTHROPIC_BASE_URL, 'https://relay.example.invalid/anthropic');
    assert.equal(optionsSeen[1].env?.ANTHROPIC_API_KEY, 'sk-test-secret');
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude Adapter 使用 query、固定 settingSources/default permission，并支持流式事件和 native session', async () => {
  const cwd = join(tmpdir(), `claude-adapter-${Date.now()}`);
  const extra = join(cwd, 'other-repo');
  await mkdir(extra, { recursive: true });
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const optionsSeen: ClaudeSdkQueryOptions[] = [];
  let approvalCalled = false;
  let persistedNativeSessionId = '';
  const sdk: ClaudeSdkModule = {
    query({ options }: { prompt: string; options: ClaudeSdkQueryOptions }) {
      optionsSeen.push(options);
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'native-1' },
        { type: 'stream_event', session_id: 'native-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } },
        { type: 'tool_progress', session_id: 'native-1', tool_name: 'Read' },
        { type: 'result', subtype: 'success', session_id: 'native-1' },
      ];
      return {
        async *[Symbol.asyncIterator]() { yield* messages; },
        close() {},
      };
    },
  };
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'sk-test-secret', executablePath, additionalDirectories: [extra], sdkLoader: async () => sdk, onNativeSessionId: (_platformId, nativeId) => { persistedNativeSessionId = nativeId; }, onApprovalRequest: async () => { approvalCalled = true; return 'accept'; } });
  const events: string[] = [];
  adapter.onEvent(event => events.push(`${event.type}:${event.text}`));
  try {
    assert.equal((await adapter.checkRuntime()).version, CLAUDE_AGENT_SDK_RUNTIME_VERSION);
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, '分析代码', cwd);
    assert.deepEqual(events, ['status:running', 'status:Claude Runtime 会话已启动', 'delta:你好', 'tool:Claude 工具执行中：Read', 'status:completed']);
    assert.equal(adapter.getNativeSessionId(thread), 'native-1');
    assert.equal(persistedNativeSessionId, 'native-1');
    assert.equal(optionsSeen.length, 1);
    assert.deepEqual(optionsSeen[0].settingSources, []);
    assert.equal(optionsSeen[0].permissionMode, 'default');
    assert.deepEqual(optionsSeen[0].additionalDirectories, [await realpath(extra)]);
    assert.equal(optionsSeen[0].env?.ANTHROPIC_API_KEY, 'sk-test-secret');
    assert.equal(approvalCalled, false, '没有权限请求时不应伪造审批');
    await adapter.close();
    const resumedAdapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'sk-test-secret', executablePath, sdkLoader: async () => sdk });
    await resumedAdapter.resumeSession(thread, cwd, persistedNativeSessionId);
    await resumedAdapter.sendTurn(thread, '继续分析', cwd);
    assert.equal(optionsSeen[1].resume, 'native-1', '恢复时必须使用持久化的 Claude 原生 session ID');
    await resumedAdapter.close();
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude 只读准入允许网页检索，并拒绝命令执行和文件写入', async () => {
  const cwd = join(tmpdir(), `claude-adapter-read-only-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  let seen: ClaudeSdkQueryOptions | undefined;
  let canUseTool: ClaudeSdkQueryOptions['canUseTool'];
  const sdk: ClaudeSdkModule = {
    query({ options }: { prompt: string; options: ClaudeSdkQueryOptions }) {
      seen = options;
      canUseTool = options.canUseTool;
      return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; } };
    },
  };
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'sk-test-secret', executablePath, readOnly: true, additionalSystemPrompt: claudeReadOnlyNetworkInstruction(), sdkLoader: async () => sdk, onApprovalRequest: async request => isClaudeReadOnlyTool(request.toolName) ? 'accept' : 'decline' });
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, '只读分析', cwd);
    assert.deepEqual(seen?.tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
    assert.match(seen?.appendSystemPrompt ?? '', /WebSearch/);
    assert.match(seen?.appendSystemPrompt ?? '', /公开网页/);
    assert.equal(isClaudeReadOnlyTool('Read'), true);
    assert.equal(isClaudeReadOnlyTool('Glob'), true);
    assert.equal(isClaudeReadOnlyTool('Grep'), true);
    assert.equal(isClaudeReadOnlyTool('WebSearch'), true);
    assert.equal(isClaudeReadOnlyTool('WebFetch'), true);
    assert.equal(isClaudeReadOnlyTool('Write'), false);
    assert.equal(isClaudeReadOnlyTool('Bash'), false);
    assert.ok(canUseTool);
    const denied = await canUseTool!('Write', {}, { toolName: 'Write', input: {}, signal: new AbortController().signal });
    assert.deepEqual(denied, { behavior: 'deny', message: '当前会话受只读准入门禁保护，已拒绝写入或执行工具' });
    const allowed = await canUseTool!('Read', {}, { toolName: 'Read', input: {}, signal: new AbortController().signal });
    assert.deepEqual(allowed, { behavior: 'allow' });
    const webSearch = await canUseTool!('WebSearch', { query: '佛山天气' }, { toolName: 'WebSearch', input: { query: '佛山天气' }, signal: new AbortController().signal });
    assert.deepEqual(webSearch, { behavior: 'allow' });
    const webFetch = await canUseTool!('WebFetch', { url: 'https://weather.example.invalid' }, { toolName: 'WebFetch', input: { url: 'https://weather.example.invalid' }, signal: new AbortController().signal });
    assert.deepEqual(webFetch, { behavior: 'allow' });
    const deniedBash = await canUseTool!('Bash', {}, { toolName: 'Bash', input: {}, signal: new AbortController().signal });
    assert.deepEqual(deniedBash, { behavior: 'deny', message: '当前会话受只读准入门禁保护，已拒绝写入或执行工具' });
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude Adapter 未配置 API Key 时拒绝真实模型调用且不静默回退', async () => {
  const cwd = join(tmpdir(), `claude-adapter-no-key-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', executablePath, sdkLoader: async () => ({ query() { throw new Error('query should not be called'); } }) });
  try {
    const thread = await adapter.startSession(cwd);
    await assert.rejects(adapter.sendTurn(thread, 'test', cwd), /模型中转站尚未配置 API Key/);
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude SDK 初始化失败会清理任务状态并允许同一会话重试', async () => {
  const cwd = join(tmpdir(), `claude-adapter-retry-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  let queryCount = 0;
  const adapter = new ClaudeAgentSdkRuntimeAdapter({
    model: 'claude-test',
    apiKey: 'sk-test-secret',
    executablePath,
    sdkLoader: async () => ({ query() {
      queryCount += 1;
      if (queryCount === 1) throw new Error('fixture query initialization failure');
      return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; } };
    } }),
  });
  try {
    const thread = await adapter.startSession(cwd);
    await assert.rejects(adapter.sendTurn(thread, 'first', cwd), /fixture query initialization failure/);
    await adapter.sendTurn(thread, 'retry', cwd);
    assert.equal(queryCount, 2);
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});


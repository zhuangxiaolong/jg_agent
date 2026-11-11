import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentSdkRuntimeAdapter, CLAUDE_AGENT_SDK_RUNTIME_VERSION, claudeRelayBaseUrl, normalizeClaudeSdkMessage, type ClaudeSdkModule, type ClaudeSdkQueryOptions } from '../packages/agent-runtime/src/claude-adapter';

test('Claude 复用通用中转站时避免重复追加 /v1，保留自定义前缀', () => {
  assert.equal(claudeRelayBaseUrl('https://relay.example.invalid/v1'), 'https://relay.example.invalid');
  assert.equal(claudeRelayBaseUrl('https://relay.example.invalid/anthropic/v1/'), 'https://relay.example.invalid/anthropic');
  assert.equal(claudeRelayBaseUrl('https://relay.example.invalid/anthropic'), 'https://relay.example.invalid/anthropic');
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
    assert.deepEqual(optionsSeen[1].tools, [], '连接测试不启用工具');
    assert.deepEqual(await optionsSeen[1].canUseTool!('Bash', {}, { toolName: 'Bash', input: {}, signal: new AbortController().signal }), { behavior: 'deny', message: '连接测试期间已禁用工具调用' });
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('Claude Adapter 使用 query、固定 settingSources/bypass permission，并支持流式事件和 native session', async () => {
  const cwd = join(tmpdir(), `claude-adapter-${Date.now()}`);
  const extra = join(cwd, 'other-repo');
  await mkdir(extra, { recursive: true });
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const optionsSeen: ClaudeSdkQueryOptions[] = [];
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
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'sk-test-secret', executablePath, additionalDirectories: [extra], sdkLoader: async () => sdk, onNativeSessionId: (_platformId, nativeId) => { persistedNativeSessionId = nativeId; } });
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
    assert.equal(optionsSeen[0].permissionMode, 'bypassPermissions');
    assert.equal(optionsSeen[0].allowDangerouslySkipPermissions, true);
    assert.deepEqual(optionsSeen[0].additionalDirectories, [await realpath(extra)]);
    assert.equal(optionsSeen[0].env?.ANTHROPIC_API_KEY, 'sk-test-secret');
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

test('Claude Runtime 自动继续普通工具请求', async () => {
  const cwd = join(tmpdir(), `claude-adapter-auto-tools-${Date.now()}`);
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
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'sk-test-secret', executablePath, sdkLoader: async () => sdk });
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, '执行开发任务', cwd);
    assert.equal(seen?.tools, undefined, '保留 SDK 完整工具集');
    assert.equal(seen?.permissionMode, 'bypassPermissions');
    assert.equal(seen?.allowDangerouslySkipPermissions, true);
    assert.ok(canUseTool);
    for (const toolName of ['Read', 'Write', 'Edit', 'Bash', 'WebSearch']) {
      const result = await canUseTool!(toolName, {}, { toolName, input: {}, signal: new AbortController().signal });
      assert.deepEqual(result, { behavior: 'allow' }, `${toolName} 自动继续`);
    }
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


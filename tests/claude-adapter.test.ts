import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSdkMcpServer, tool, type SDKUserMessage, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkRuntimeAdapter, CLAUDE_AGENT_SDK_RUNTIME_VERSION, claudeRelayBaseUrl, normalizeClaudeSdkMessage, type ClaudeSdkModule, type ClaudeSdkQueryOptions } from '../packages/agent-runtime/src/claude-adapter';
import type { AuthorizedDirectoryPolicy } from '../packages/agent-runtime/src/authorized-directory-broker';

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

test('Claude 授权模式仅启用 MCP broker，动态撤销目录并限制项目写入范围', async () => {
  const root = join(tmpdir(), `claude-directory-tools-${Date.now()}`);
  const cwd = join(root, 'workspace');
  const documents = join(root, '资料');
  await mkdir(cwd, { recursive: true }); await mkdir(documents);
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  await writeFile(join(documents, '验收.txt'), 'MES WMS 文档解析内容');
  let policy: AuthorizedDirectoryPolicy = { mode: 'restricted', directories: [{ id: 'grant-1', path: documents }] };
  let definitions: SdkMcpToolDefinition<any>[] = [];
  const invoked: string[] = [];
  const writes: string[] = [];
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const definition = definitions.find(item => item.name === name);
    assert.ok(definition, name);
    return definition.handler(input, {});
  };
  const parseResult = (result: Awaited<ReturnType<typeof invoke>>) => {
    const content = result.content?.[0];
    assert.ok(content && content.type === 'text');
    return content.text as string;
  };
  const sdk: ClaudeSdkModule = {
    tool,
    createSdkMcpServer(options) { definitions = options.tools ?? []; return createSdkMcpServer(options); },
    query({ options, prompt }) {
      assert.equal(options.permissionMode, 'default');
      assert.equal(options.allowDangerouslySkipPermissions, undefined);
      assert.deepEqual(options.tools, []);
      assert.equal(options.strictMcpConfig, true);
      assert.equal(options.additionalDirectories, undefined, '外部资料目录不扩大 SDK 目录权限');
      assert.ok(options.mcpServers?.jinggong_files);
      assert.match(options.systemPrompt?.append ?? '', /不可信资料/);
      return { async *[Symbol.asyncIterator]() {
        assert.notEqual(typeof prompt, 'string', 'SDK MCP 使用流式用户输入');
        const messages: SDKUserMessage[] = [];
        for await (const item of prompt as AsyncIterable<SDKUserMessage>) messages.push(item);
        assert.equal(messages[0].message.content, '读取授权资料并修改工作区文件');
        for (const toolName of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'mcp__other__read']) {
          assert.equal((await options.canUseTool!(toolName, {}, { toolName, input: {}, signal: new AbortController().signal })).behavior, 'deny');
        }
        assert.equal((await options.canUseTool!('mcp__jinggong_files__read_authorized_document', {}, { toolName: 'mcp__jinggong_files__read_authorized_document', input: {}, signal: new AbortController().signal })).behavior, 'allow');
        assert.match(parseResult(await invoke('list_authorized_directories', {})), /grant-1/);
        assert.match(parseResult(await invoke('read_authorized_document', { grantId: 'grant-1', path: '验收.txt' })), /MES WMS 文档解析内容/);
        policy = { mode: 'restricted', directories: [] };
        assert.equal((await invoke('read_authorized_document', { grantId: 'grant-1', path: '验收.txt' })).isError, true);
        policy = { mode: 'full', directories: [{ id: 'full-fixture', path: documents }] };
        assert.match(parseResult(await invoke('list_authorized_directories', {})), /full/);
        assert.match(parseResult(await invoke('read_authorized_document', { grantId: 'full-fixture', path: '验收.txt' })), /MES WMS/);
        assert.equal((await invoke('write_project_file', { path: '交付.txt', content: '工作区写入' })).isError, undefined);
        assert.equal((await invoke('write_project_file', { path: '../资料/越界.txt', content: '不可写外部资料' })).isError, true);
        yield { type: 'result', subtype: 'success' };
      } };
    },
  };
  const adapter = new ClaudeAgentSdkRuntimeAdapter({
    model: 'claude-test', apiKey: 'sk-test-secret', executablePath, sdkLoader: async () => sdk,
    additionalDirectories: [documents], authorizedDirectories: () => policy,
    beforeWrite: async filename => { writes.push(filename); },
    toolGateway: async (request, execute) => { invoked.push(request.toolName); return execute(); },
  });
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, '读取授权资料并修改工作区文件', cwd);
    assert.equal(await readFile(join(cwd, '交付.txt'), 'utf8'), '工作区写入');
    assert.deepEqual(writes, ['交付.txt']);
    assert.ok(invoked.includes('read_authorized_document'));
    assert.equal((await invoke('list_authorized_directories', {})).isError, true, '任务结束后旧 MCP handler 不能再读取');
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});

test('Claude SDK 缺少自定义工具能力时授权会话明确失败，不退回原生绕过权限', async () => {
  const cwd = join(tmpdir(), `claude-no-mcp-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const executablePath = join(cwd, 'claude.exe'); await writeFile(executablePath, 'fixture');
  let queryCalled = false;
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'sk-test-secret', executablePath, authorizedDirectories: () => ({ mode: 'restricted', directories: [] }), sdkLoader: async () => ({ query() { queryCalled = true; throw new Error('不应调用'); } }) });
  try {
    const thread = await adapter.startSession(cwd);
    await assert.rejects(adapter.sendTurn(thread, '读取资料', cwd), /缺少受控文档 MCP 工具能力/);
    assert.equal(queryCalled, false);
  } finally { await adapter.close(); await rm(cwd, { recursive: true, force: true }); }
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


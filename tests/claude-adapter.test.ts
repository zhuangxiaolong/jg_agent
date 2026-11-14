import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSdkMcpServer, tool, type SDKUserMessage, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkRuntimeAdapter, CLAUDE_AGENT_SDK_RUNTIME_VERSION, claudeRelayBaseUrl, createClaudeWorkspaceSandbox, normalizeClaudeSdkMessage, type ClaudeSdkModule, type ClaudeSdkQueryOptions } from '../packages/agent-runtime/src/claude-adapter';
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

test('Claude SDK 失败结果保留结构化错误信息并脱敏', () => {
  assert.deepEqual(normalizeClaudeSdkMessage({
    type: 'result', subtype: 'error_during_execution', result: '上游拒绝 sk-secret12345', errors: ['401 invalid api key sk-secret12345'],
  }, 'sk-secret12345'), {
    type: 'error', text: 'Claude Runtime 执行失败：结果：上游拒绝 [已脱敏]；类型：error_during_execution；错误：401 invalid api key [已脱敏]', nativeSessionId: undefined, terminal: true,
  });
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
    assert.deepEqual(optionsSeen[0].sandbox, { enabled: false, allowUnsandboxedCommands: true }, '普通会话默认关闭工作区文件沙箱');
    assert.match(optionsSeen[0].systemPrompt?.append ?? '', /检查现有实现并实际修改文件/);
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

test('Claude 新建、后续轮次与冷恢复均追加查询指南，保留业务文档提示、模型及原始任务', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-execution-guidance-'));
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const instructions = '【业务要求】保留项目已有构建流程和工具文档，不修改需求范围。';
  const model = 'claude-user-selected-model';
  const prompts = ['今天南京的天气怎么样\n请简洁回答。', '保留同一会话继续处理', '恢复后继续原任务'];
  const calls: Array<{ prompt: string | AsyncIterable<SDKUserMessage>; options: ClaudeSdkQueryOptions }> = [];
  const sdk: ClaudeSdkModule = {
    tool,
    createSdkMcpServer,
    query(parameters) {
      calls.push(parameters);
      return { async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'native-execution-guidance' };
        yield { type: 'result', subtype: 'success', session_id: 'native-execution-guidance' };
      } };
    },
  };
  const options = {
    model, apiKey: 'synthetic-claude-execution-key', executablePath, additionalSystemPrompt: instructions,
    authorizedDirectories: (): AuthorizedDirectoryPolicy => ({ mode: 'full', directories: [] }),
    sdkLoader: async () => sdk,
  };
  const adapter = new ClaudeAgentSdkRuntimeAdapter(options);
  let resumed: ClaudeAgentSdkRuntimeAdapter | undefined;
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, prompts[0], cwd);
    await adapter.sendTurn(thread, prompts[1], cwd);
    await adapter.close();
    resumed = new ClaudeAgentSdkRuntimeAdapter(options);
    await resumed.resumeSession(thread, cwd, 'native-execution-guidance');
    await resumed.sendTurn(thread, prompts[2], cwd);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.prompt), prompts, '查询指南不能拼进或替换原始用户任务');
    assert.deepEqual(calls.map(call => call.options.resume), [undefined, 'native-execution-guidance', 'native-execution-guidance']);
    for (const { options: seen } of calls) {
      assert.equal(seen.model, model, '不得切换模型以实现查询优化');
      assert.ok(seen.systemPrompt?.append.startsWith(instructions), '保留原有业务要求');
      assert.match(seen.systemPrompt?.append ?? '', /【文档解析工具】.*jinggong_documents/s, '保留现有文档工具说明');
      assert.match(seen.systemPrompt?.append ?? '', /【查询执行效率】/);
      assert.match(seen.systemPrompt?.append ?? '', /【项目初读效率】/);
      if (process.platform === 'win32') {
        assert.match(seen.systemPrompt?.append ?? '', /PowerShell.*5\.1/s);
        assert.match(seen.systemPrompt?.append ?? '', /实际 Shell/);
        assert.match(seen.systemPrompt?.append ?? '', /Bash 工具保持 Bash 语法/);
      }
      assert.equal(seen.systemPrompt?.type, 'preset', '通过官方 preset 保留 SDK 原生系统提示');
      assert.equal(seen.systemPrompt?.preset, 'claude_code');
      assert.equal(seen.systemPrompt?.snapshot, false, '冷恢复也要应用当前指引');
      assert.equal(Object.hasOwn(seen, 'appendSystemPrompt'), false, '不能再传 SDK 不识别的顶层字段');
      assert.equal(seen.permissionMode, 'bypassPermissions');
      assert.equal(seen.allowDangerouslySkipPermissions, true);
      assert.equal(seen.tools, undefined);
    }
  } finally { await adapter.close(); await resumed?.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('Claude 受控新建和恢复只保留文件工具提示，不注入联网与Shell查询指南', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-controlled-guidance-'));
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const instructions = '【受控业务要求】只能分析用户授权资料。';
  const model = 'claude-controlled-selected';
  const prompts = ['仅分析资料，不执行命令', '恢复后继续分析资料'];
  const calls: Array<{ prompt: string | AsyncIterable<SDKUserMessage>; options: ClaudeSdkQueryOptions }> = [];
  const receivedPrompts: Array<SDKUserMessage[]> = [];
  const sdk: ClaudeSdkModule = {
    tool,
    createSdkMcpServer,
    query(parameters) {
      calls.push(parameters);
      return { async *[Symbol.asyncIterator]() {
        assert.notEqual(typeof parameters.prompt, 'string');
        const messages: SDKUserMessage[] = [];
        for await (const item of parameters.prompt as AsyncIterable<SDKUserMessage>) messages.push(item);
        receivedPrompts.push(messages);
        yield { type: 'system', subtype: 'init', session_id: 'native-controlled-guidance' };
        yield { type: 'result', subtype: 'success', session_id: 'native-controlled-guidance' };
      } };
    },
  };
  const options = {
    model, apiKey: 'synthetic-controlled-execution-key', executablePath, additionalSystemPrompt: instructions,
    controlledMode: true, sdkLoader: async () => sdk,
    authorizedDirectories: (): AuthorizedDirectoryPolicy => ({ mode: 'restricted', directories: [] }),
  };
  const adapter = new ClaudeAgentSdkRuntimeAdapter(options);
  let resumed: ClaudeAgentSdkRuntimeAdapter | undefined;
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, prompts[0], cwd);
    await adapter.close();
    resumed = new ClaudeAgentSdkRuntimeAdapter(options);
    await resumed.resumeSession(thread, cwd, 'native-controlled-guidance');
    await resumed.sendTurn(thread, prompts[1], cwd);
    assert.equal(calls.length, 2);
    assert.deepEqual(receivedPrompts.map(messages => messages.map(message => message.message.content)), prompts.map(prompt => [prompt]));
    assert.equal(calls[1].options.resume, 'native-controlled-guidance');
    for (const { options: seen } of calls) {
      assert.equal(seen.model, model);
      assert.equal(Object.hasOwn(seen, 'appendSystemPrompt'), false);
      assert.ok(seen.systemPrompt?.append.startsWith(instructions));
      assert.match(seen.systemPrompt?.append ?? '', /【受控文件工具】/);
      assert.doesNotMatch(seen.systemPrompt?.append ?? '', /【查询执行效率】|PowerShell|Invoke-RestMethod|wttr\.in/);
      assert.equal(seen.permissionMode, 'default');
      assert.deepEqual(seen.tools, []);
      assert.equal(seen.allowDangerouslySkipPermissions, undefined);
      assert.ok(seen.mcpServers?.jinggong_files);
    }
  } finally { await adapter.close(); await resumed?.close(); await rm(cwd, { recursive: true, force: true }); }
});

test('Claude 默认完全访问支持工作区外原生读写，不因文档工具进入受控模式', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-full-access-'));
  const cwd = join(root, 'workspace');
  const outside = join(root, '桌面资料.txt');
  await mkdir(cwd);
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const sdk: ClaudeSdkModule = {
    tool,
    createSdkMcpServer,
    query({ options }) {
      assert.equal(options.permissionMode, 'bypassPermissions');
      assert.equal(options.allowDangerouslySkipPermissions, true);
      assert.deepEqual(options.sandbox, { enabled: false, allowUnsandboxedCommands: true });
      assert.equal(options.tools, undefined);
      assert.ok(options.mcpServers?.jinggong_documents);
      assert.match(options.systemPrompt?.append ?? '', /【文档解析工具】jinggong_documents MCP/);
      assert.doesNotMatch(options.systemPrompt?.append ?? '', /【执行权限】|当前普通会话默认完全访问/);
      assert.doesNotMatch(options.systemPrompt?.append ?? '', /只能使用|不要通过 Shell|外部资料只读/);
      return { async *[Symbol.asyncIterator]() {
        for (const toolName of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'Bash']) {
          const input = { file_path: outside, path: root, notebook_path: outside, dangerouslyDisableSandbox: true };
          assert.equal((await options.canUseTool!(toolName, input, { toolName, input, signal: new AbortController().signal })).behavior, 'allow', `${toolName} 允许工作区外操作`);
        }
        await writeFile(outside, '工作区外写入成功');
        yield { type: 'result', subtype: 'success' };
      } };
    },
  };
  const adapter = new ClaudeAgentSdkRuntimeAdapter({
    model: 'claude-test', apiKey: 'sk-test-secret', executablePath, sdkLoader: async () => sdk,
    authorizedDirectories: () => ({ mode: 'restricted', directories: [] }),
    sandbox: createClaudeWorkspaceSandbox(cwd, [join(root, 'credentials')]),
  });
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, '在工作区外读写文件', cwd);
    assert.equal(await readFile(outside, 'utf8'), '工作区外写入成功');
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
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
    controlledMode: true,
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
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'sk-test-secret', executablePath, controlledMode: true, authorizedDirectories: () => ({ mode: 'restricted', directories: [] }), sdkLoader: async () => ({ query() { queryCalled = true; throw new Error('不应调用'); } }) });
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

test('Claude SDK 终态错误向调用方抛出并清理任务状态', async () => {
  const cwd = join(tmpdir(), `claude-adapter-result-error-${Date.now()}`);
  await mkdir(cwd, { recursive: true });
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  let queryCount = 0;
  const adapter = new ClaudeAgentSdkRuntimeAdapter({
    model: 'claude-test', apiKey: 'sk-test-secret', executablePath,
    sdkLoader: async () => ({ query() {
      queryCount += 1;
      return { async *[Symbol.asyncIterator]() {
        if (queryCount === 1) yield { type: 'result', subtype: 'error_during_execution', errors: ['401 unauthorized'] };
        else yield { type: 'result', subtype: 'success' };
      } };
    } }),
  });
  const events: string[] = [];
  adapter.onEvent(event => events.push(`${event.type}:${event.text}`));
  try {
    const thread = await adapter.startSession(cwd);
    await assert.rejects(adapter.sendTurn(thread, 'first', cwd), /error_during_execution.*401 unauthorized/);
    await adapter.sendTurn(thread, 'retry', cwd);
    assert.equal(queryCount, 2);
    assert.deepEqual(events, ['status:running', 'status:running', 'status:completed']);
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function startupFixture(loader: () => Promise<ClaudeSdkModule>) {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-adapter-startup-'));
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-test', apiKey: 'synthetic-claude-startup-key', executablePath, sdkLoader: loader });
  return { adapter, cwd, executablePath, async close() { await adapter.close(); await rm(cwd, { recursive: true, force: true }); } };
}

function successfulSdk(onQuery: () => void = () => undefined): ClaudeSdkModule {
  return { query() {
    onQuery();
    return { async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success' }; } };
  } };
}

test('Claude 成功启动后不重复预检，创建恢复发送及连接测试共享一次SDK加载', async () => {
  let loads = 0, queries = 0, checks = 0;
  const sdk = successfulSdk(() => { queries++; });
  const f = await startupFixture(async () => { loads++; return sdk; });
  const check = f.adapter.checkRuntime.bind(f.adapter);
  f.adapter.checkRuntime = async () => { checks++; return check(); };
  try {
    await f.adapter.start();
    const thread = await f.adapter.startSession(f.cwd);
    await f.adapter.resumeSession(thread, f.cwd, 'native-startup-session');
    await f.adapter.sendTurn(thread, '发送一轮任务', f.cwd);
    await f.adapter.start();
    assert.equal(loads, 1);
    assert.equal(checks, 1);
    assert.equal(queries, 1);
    assert.equal((await f.adapter.testConnection(f.cwd)).compatible, true);
    assert.equal(loads, 1);
    assert.equal(checks, 2, '主动连接测试仍重新核验本地组件');
    assert.equal(queries, 2);
  } finally { await f.close(); }
});

test('Claude 并发启动共享在途预检和SDK加载，不并行重复初始化', async () => {
  let loads = 0, checks = 0;
  let resolve!: (sdk: ClaudeSdkModule) => void;
  const loading = new Promise<ClaudeSdkModule>(done => { resolve = done; });
  const f = await startupFixture(async () => { loads++; return loading; });
  const check = f.adapter.checkRuntime.bind(f.adapter);
  f.adapter.checkRuntime = async () => { checks++; return check(); };
  try {
    const starts = [f.adapter.start(), f.adapter.start(), f.adapter.start()];
    await Promise.resolve();
    assert.equal(loads, 1);
    assert.equal(checks, 1);
    resolve(successfulSdk());
    await Promise.all(starts);
    await f.adapter.startSession(f.cwd);
    assert.equal(loads, 1);
    assert.equal(checks, 1);
  } finally { resolve(successfulSdk()); await f.close(); }
});

test('Claude SDK加载失败不缓存失败结果，组件恢复后可重新启动', async () => {
  let loads = 0;
  const f = await startupFixture(async () => {
    loads++;
    if (loads === 1) throw new Error('合成SDK加载失败');
    return successfulSdk();
  });
  try {
    await assert.rejects(f.adapter.start(), /合成SDK加载失败/);
    await f.adapter.start();
    const thread = await f.adapter.startSession(f.cwd);
    await f.adapter.sendTurn(thread, '恢复后发送', f.cwd);
    assert.equal(loads, 2);
  } finally { await f.close(); }
});

test('Claude 本地组件检查失败仍能重试，不把失败健康状态当作已启动', async () => {
  let loads = 0;
  const f = await startupFixture(async () => { loads++; return successfulSdk(); });
  try {
    await rm(f.executablePath);
    await assert.rejects(f.adapter.start(), /组件不可用/);
    await writeFile(f.executablePath, 'fixture');
    await f.adapter.start();
    assert.equal(loads, 1, 'SDK已成功加载时只重新检查恢复的本地组件');
  } finally { await f.close(); }
});

test('Claude 启动期间关闭会拒绝所有在途启动，迟到的SDK加载不能复活实例', async () => {
  let loads = 0, queries = 0;
  let resolve!: (sdk: ClaudeSdkModule) => void;
  const loading = new Promise<ClaudeSdkModule>(done => { resolve = done; });
  const f = await startupFixture(async () => { loads++; return loading; });
  try {
    const first = f.adapter.start(), second = f.adapter.start();
    const rejected = Promise.all([
      assert.rejects(first, /Runtime 已关闭/),
      assert.rejects(second, /Runtime 已关闭/),
    ]);
    await Promise.resolve();
    await f.adapter.close();
    resolve(successfulSdk(() => { queries++; }));
    await rejected;
    await assert.rejects(f.adapter.start(), /Runtime 已关闭/);
    await assert.rejects(f.adapter.startSession(f.cwd), /Runtime 已关闭/);
    assert.equal(loads, 1);
    assert.equal(queries, 0);
    assert.equal((f.adapter as any).started, false);
  } finally { resolve(successfulSdk()); await f.close(); }
});


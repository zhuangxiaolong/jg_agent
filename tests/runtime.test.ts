import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CODEX_REQUEST_MAX_RETRIES, CODEX_RUNTIME_VERSION, CODEX_STREAM_IDLE_TIMEOUT_MS, CODEX_STREAM_MAX_RETRIES, CodexRuntime, JsonLinesDecoder, buildDeveloperInstructions, explainRuntimeError, redactRuntimeText, runtimeEnvironment } from '../packages/agent-runtime/src/index';
import { GitConnector } from '../packages/git-connector/src/index';
import { ProjectReadBroker } from '../packages/agent-runtime/src/project-read-broker';

test('JSONL 协议处理跨行分帧和超长行', () => {
  const decoder = new JsonLinesDecoder();
  assert.deepEqual(decoder.push('{"id":1,"res'), []);
  assert.deepEqual(decoder.push('ult":"中文"}\n{"id":2}\n'), ['{"id":1,"result":"中文"}', '{"id":2}']);
  assert.throws(() => decoder.push('x'.repeat(4 * 1024 * 1024 + 1)), /超过/);
});

test('Runtime 对 SSE 空闲采用长容忍并启用有限重试', () => {
  assert.equal(CODEX_RUNTIME_VERSION, '0.156.1');
  assert.equal(CODEX_STREAM_IDLE_TIMEOUT_MS, 24 * 60 * 60 * 1000);
  assert.equal(CODEX_REQUEST_MAX_RETRIES, 3);
  assert.equal(CODEX_STREAM_MAX_RETRIES, 3);
  assert.ok(CODEX_STREAM_IDLE_TIMEOUT_MS > 30_000);
  assert.equal(explainRuntimeError('stream disconnected before completion: idle timeout waiting for SSE'), '模型流式连接长时间无数据，已自动重试；请检查模型服务网络或稍后重试。');
});

test('Runtime 错误脱敏与凭据环境隔离', () => {
  const key = 'unit-test-only-key-123';
  const cleaned = redactRuntimeText(`failed ${key} Authorization: Bearer abc123 access_token=credential`, key);
  assert.ok(!cleaned.includes(key));
  assert.ok(!cleaned.includes('abc123'));
  assert.ok(!cleaned.includes('credential'));
  const environment = runtimeEnvironment('C:\\jinggong-test-runtime', key);
  assert.equal(environment.CODEX_HOME, 'C:\\jinggong-test-runtime');
  assert.equal(environment.JINGGONG_MODEL_API_KEY, key);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CODEX_API_KEY, undefined);
});

test('开发规范完整注入且超容量明确拒绝', () => {
  const document = '完整开发规范\n'.repeat(30000);
  assert.ok(buildDeveloperInstructions({ mode: 'develop', developerInstructions: document }).endsWith(document));
  assert.match(buildDeveloperInstructions({ mode: 'develop' }), /完整开发模式/);
  assert.match(buildDeveloperInstructions({ mode: 'read' }), /完整开发模式/);
  assert.throws(() => buildDeveloperInstructions({ developerInstructions: '中'.repeat(800000) }), /不会静默截断/);
});

test('真实 Windows Codex 固定版本、完整开发会话、凭据缺失和退出', { timeout: 45000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('仅验证 Windows 原生 Runtime');
  const nativeRoot = path.resolve('apps/desktop/resources/runtime');
  let executable = path.join(nativeRoot, 'bin/codex.exe');
  try { await access(executable); } catch {
    executable = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    try { await access(executable); } catch { return t.skip('请先安装固定版本开发依赖或执行 stage-runtime'); }
  }
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-test-'));
  const workspace = path.join(root, '项目 带空格');
  await mkdir(workspace);
  const runtime = new CodexRuntime({ executable, home: path.join(root, 'runtime-home'), baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' });
  try {
    const health = await runtime.checkRuntime();
    assert.equal(health.available, true);
    assert.equal(health.version, '0.156.1');
    assert.equal(health.compatible, true);
    await runtime.start();
    const threadId = await runtime.startSession(workspace);
    assert.ok(threadId.length > 10);
    await assert.rejects(runtime.sendTurn(threadId, '只回复协议验证成功', workspace), /尚未配置模型 API Key/);
    await runtime.cancelRun(threadId);
    await runtime.close();
    const resumedId = await runtime.resumeSession(threadId, workspace);
    assert.ok(resumedId.length > 10);
    assert.notEqual(resumedId, threadId, '首个 turn 前无 rollout 的空会话需重建 Runtime thread');
    await assert.rejects(runtime.sendTurn(resumedId, '只回复验证成功', workspace), /尚未配置模型 API Key/);
  } finally { await runtime.close(); }
  await runtime.close();
});

test('Runtime 关闭后回收 CLI 子进程，CLI 仍可独立调用', { timeout: 45000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('仅验证 Windows 原生 Runtime');
  let executable = path.resolve('apps/desktop/resources/runtime/bin/codex.exe');
  try { await access(executable); } catch {
    executable = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    try { await access(executable); } catch { return t.skip('请先安装固定版本 Runtime'); }
  }
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-close-'));
  const runtime = new CodexRuntime({ executable, home: path.join(root, 'runtime-home'), baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4' });
  const execute = promisify(execFile);
  try {
    await runtime.start();
    const child = (runtime as any).child as { pid?: number; exitCode: number | null; signalCode: string | null; once: (event: string, listener: (code: number | null, signal: string | null) => void) => void };
    assert.ok(child?.pid, 'Runtime 应持有已启动的 Codex CLI 子进程');
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await runtime.close();
    const result = await exited;
    assert.equal(result.code, 0, '关闭 Runtime 后 Codex CLI 应正常退出');
    assert.equal((runtime as any).child, undefined);
    const version = await execute(executable, ['--version'], { env: runtimeEnvironment(path.join(root, 'independent-home')), windowsHide: true, timeout: 10000 });
    assert.match(version.stdout, /0\.156\.1/);
  } finally { await runtime.close(); }
});

test('缺失 Runtime 与错误 Provider 都明确失败', async () => {
  const runtime = new CodexRuntime({ executable: path.resolve('not-a-runtime.exe'), home: path.join(tmpdir(), 'jinggong-no-runtime'), baseUrl: 'https://api.openai.com/v1', model: 'test' });
  assert.equal((await runtime.checkRuntime()).available, false);
  await assert.rejects(runtime.start(), /不可用/);
});

test('真实 Windows Runtime 接受开发工具 Schema 与完整规范并恢复无模型调用会话', { timeout: 45000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('仅验证 Windows 原生 Runtime');
  let executable = path.resolve('apps/desktop/resources/runtime/bin/codex.exe');
  try { await access(executable); } catch {
    executable = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    try { await access(executable); } catch { return t.skip('请先安装固定版本 Runtime'); }
  }
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-develop-runtime-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  const execute = promisify(execFile);
  const git = (args: string[]) => execute('git', args, { cwd: source, windowsHide: true });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', '精工协议测试']);
  await git(['config', 'user.email', 'protocol@example.invalid']);
  await writeFile(path.join(source, 'README.md'), '# Runtime 开发模式测试\n');
  await git(['add', '--', 'README.md']);
  await git(['commit', '-m', '建立协议测试基线']);
  const connector = new GitConnector(path.join(root, 'workspaces'));
  const workspace = await connector.createWorkspace(await connector.register(source), 'protocol-develop');
  const developerInstructions = '# 项目强制开发规范\n每次修改必须检查边界和保留人工修改。\n'.repeat(1000) + '\n接口示例 password="business-example"\nAuthorization: Bearer synthetic-business-example';
  const runtime = new CodexRuntime({ executable, home: path.join(root, 'runtime-home'), baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', mode: 'develop', developerInstructions, beforeWrite: async () => undefined, browser: async () => ({ text: '协议验证，不操作真实页面' }) });
  const rpc = runtime as unknown as { request(method: string, params: Record<string, any>): Promise<any> };
  const actualRequest = rpc.request.bind(runtime);
  let startParams: Record<string, any> | undefined;
  rpc.request = async (method, params) => { if (method === 'thread/start') startParams = params; return actualRequest(method, params); };
  try {
    const threadId = await runtime.startSession(workspace.path);
    assert.deepEqual(startParams!.dynamicTools.map((tool: { name: string }) => tool.name), ['list_project_files', 'read_project_file', 'write_project_file', 'delete_project_file', 'publish_change_plan', 'search_dictionary', 'read_dictionary', 'browser_action']);
    assert.equal(startParams!.environments, undefined);
    assert.equal(startParams!.sandbox, 'danger-full-access');
    assert.equal(startParams!.approvalPolicy, 'never');
    assert.ok(startParams!.developerInstructions.endsWith(developerInstructions));
    // 仅追加真实探针用户输入以触发持久化；不注入模型输出、不请求外部模型。
    await actualRequest('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '开发模式协议持久化验证，不请求模型。' }] }] });
    await runtime.close();
    assert.equal(await runtime.resumeSession(threadId, workspace.path), threadId);
    await assert.rejects(runtime.sendTurn(threadId, '请修改代码', workspace.path), /尚未配置模型 API Key/);
  } finally { await runtime.close(); }
});

test('turn 终态先于 RPC 微任务时不能重建幽灵活动任务（无模型文本）', async () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://api.openai.com/v1', model: 'test', apiKey: 'unit-test-only-not-a-real-key' });
  const state = runtime as unknown as {
    sessions: Set<string>;
    active: Map<string, string>;
    receive(message: unknown): void;
    request(method: string, params?: Record<string, any>): Promise<unknown>;
  };
  state.sessions.add('thread-race');
  state.request = async (method, params) => {
    assert.equal(method, 'turn/start');
    assert.equal(params?.environments, undefined);
    assert.deepEqual(params?.sandboxPolicy, { type: 'dangerFullAccess' });
    state.receive({ method: 'turn/started', params: { threadId: 'thread-race', turn: { id: 'turn-race', status: 'inProgress' } } });
    state.receive({ method: 'turn/completed', params: { threadId: 'thread-race', turn: { id: 'turn-race', status: 'completed' } } });
    return { turn: { id: 'turn-race', status: 'inProgress' } };
  };
  const statuses: string[] = [];
  runtime.onEvent((event) => { if (event.type === 'status') statuses.push(event.text); });
  await runtime.sendTurn('thread-race', '协议状态测试', 'D:\\test');
  assert.equal(state.active.size, 0);
  assert.deepEqual(statuses, ['running', 'completed']);
  await runtime.close();
});

test('运行中的任务不因固定时限被取消，只有协议终态或人工取消才能清除活动状态', async () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://api.openai.com/v1', model: 'test' });
  const state = runtime as any;
  const events: string[] = [];
  runtime.onEvent(event => events.push(`${event.type}:${event.text}`));
  state.setActive('thread-timeout', 'turn-timeout');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(state.active.get('thread-timeout'), 'turn-timeout');
  assert.deepEqual(events, []);
  state.clearActive('thread-timeout');
  await runtime.close();
});

test('Runtime 在发送 RPC 与落地 rollout 前拒绝任务中的已配置模型凭据', async () => {
  const value = 'unit-only-sentinel-not-a-real-key';
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://api.openai.com/v1', model: 'test', apiKey: value });
  const state = runtime as unknown as { sessions: Set<string>; request(): Promise<unknown> };
  state.sessions.add('thread-local-only');
  let called = false;
  state.request = async () => { called = true; throw new Error('不应发送'); };
  await assert.rejects(runtime.sendTurn('thread-local-only', `用户粘贴了 ${value}`, 'D:\\local'), /包含已配置模型凭据/);
  assert.equal(called, false);
});

test('字典工具仅向已绑定项目的当前活动 turn 返回结果', async () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://api.openai.com/v1', model: 'test', dictionaries: [{ id: 'local-dict', kind: 'dictionary', system: '通用', name: '字典.txt', content: 'TABLE_X', digest: 'test-digest', enabled: true, createdAt: '2026-11-04' }] });
  const state = runtime as any;
  state.child = {};
  state.readBrokers.set('bound-thread', {});
  const replies: any[] = [];
  state.write = (message: any) => replies.push(message);
  const params = { tool: 'search_dictionary', arguments: { query: 'TABLE_X' } };
  await state.handleReadTool(1, params, 'bound-thread');
  assert.equal(replies.pop().result.success, false);
  state.active.set('bound-thread', 'active-turn');
  await state.handleReadTool(2, { ...params, turnId: 'other-turn' }, 'bound-thread');
  assert.equal(replies.pop().result.success, false);
  await state.handleReadTool(3, { ...params, turnId: 'active-turn' }, 'other-thread');
  assert.equal(replies.pop().result.success, false);
  await state.handleReadTool(4, { ...params, turnId: 'active-turn' }, 'bound-thread');
  const reply = replies.pop().result;
  assert.equal(reply.success, true);
  assert.equal(JSON.parse(reply.contentItems[0].text).matches[0].name, '字典.txt');
});

test('Runtime 受控代码工具保留分页元数据，连续读完大控制器且拒绝旧文件版本续读', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-code-pages-'));
  const code = '// password="unit-only-example"\r\n// Authorization: Bearer synthetic-business-token\r\n' + '// 采集和日志已有实现\r\n'.repeat(10000) + '// catch 中回滚并重新抛出异常\r\n';
  await writeFile(path.join(root, 'AssemblyOperationController.cs'), code);
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'test' });
  const state = runtime as any, replies: any[] = [];
  state.child = {}; state.write = (message: any) => replies.push(message);
  state.readBrokers.set('code-thread', await ProjectReadBroker.create(root));
  state.setActive('code-thread', 'code-turn');
  try {
    let offset: number | null = 0, hash: string | undefined, combined = '';
    while (offset !== null) {
      await state.handleReadTool(1, { tool: 'read_project_file', arguments: { path: 'AssemblyOperationController.cs', offset, ...(hash ? { expectedHash: hash } : {}) }, turnId: 'code-turn' }, 'code-thread');
      const reply = replies.pop().result;
      assert.equal(reply.success, true);
      assert.ok(reply.contentItems[0].text.length <= 24000);
      const result = JSON.parse(reply.contentItems[0].text);
      combined += result.content; hash = result.hash; offset = result.nextOffset;
    }
    assert.equal(combined, code);
    await writeFile(path.join(root, 'AssemblyOperationController.cs'), code + '// 人工编辑\r\n');
    await state.handleReadTool(2, { tool: 'read_project_file', arguments: { path: 'AssemblyOperationController.cs', offset: 8000, expectedHash: hash }, turnId: 'code-turn' }, 'code-thread');
    assert.equal(replies.pop().result.success, false);
  } finally { state.child = undefined; await runtime.close(); }
});

test('业务任务和模型消息中的密码Token示例保持原文，诊断脱敏与当前模型密钥保护继续独立生效', async () => {
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'test', apiKey: 'unit-configured-model-value' });
  const state = runtime as any;
  const text = 'password="synthetic-business-password"\nAuthorization: Bearer synthetic-business-token\nApiKey: sk-syntheticBusinessExample123456';
  state.sessions.add('business-thread');
  state.request = async (_method: string, params: any) => {
    assert.equal(params.input[0].text, text);
    return { turn: { id: 'business-turn', status: 'completed' } };
  };
  const messages: string[] = [];
  runtime.onEvent(event => messages.push(event.text));
  await runtime.sendTurn('business-thread', text, 'D:\\local');
  state.receive({ method: 'item/agentMessage/delta', params: { threadId: 'business-thread', itemId: 'message', delta: text } });
  assert.deepEqual(messages, [text]);
  assert.notEqual(redactRuntimeText(text), text);
  await runtime.close();
});

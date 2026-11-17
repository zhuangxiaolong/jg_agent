import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentSdkRuntimeAdapter, createClaudeSdkMessageNormalizer, normalizeClaudeSdkMessage, type ClaudeSdkModule } from '../packages/agent-runtime/src/claude-adapter';
import type { RuntimeEvent } from '../packages/agent-runtime/src';

function assistant(text: string, parentToolUseId: string | null = null, id = 'message-main') {
  return { type: 'assistant', parent_tool_use_id: parentToolUseId, session_id: 'native-main', message: { id, content: [{ type: 'text', text }] } };
}

function delta(text: string, parentToolUseId: string | null = null) {
  return { type: 'stream_event', parent_tool_use_id: parentToolUseId, session_id: 'native-main', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } };
}

test('Claude 原生子 Agent 的流式及完整正文不会混入主会话', () => {
  assert.equal(normalizeClaudeSdkMessage(assistant('子 Agent 的详细总结', 'tool-explore')), undefined);
  assert.equal(normalizeClaudeSdkMessage(delta('子 Agent 的详细总结', 'tool-explore')), undefined);
  assert.equal(normalizeClaudeSdkMessage(assistant('相同结论', 'tool-explore')), undefined);
  assert.deepEqual(normalizeClaudeSdkMessage(assistant('相同结论')), { type: 'message', text: '相同结论', nativeSessionId: 'native-main' });
});

test('Claude 顶层正文兼容 null 和旧版本缺省父工具 ID，并保留无流式回复', () => {
  for (const parentToolUseId of [null, undefined]) {
    assert.deepEqual(normalizeClaudeSdkMessage({ ...assistant('顶层完整回复'), parent_tool_use_id: parentToolUseId }), { type: 'message', text: '顶层完整回复', nativeSessionId: 'native-main' });
    assert.deepEqual(normalizeClaudeSdkMessage({ ...delta('顶层增量'), parent_tool_use_id: parentToolUseId }), { type: 'delta', text: '顶层增量', nativeSessionId: 'native-main' });
  }
});

test('Claude 同一消息的多个文本块及不同轮次的相同回复均不按消息 ID 或文字丢弃', () => {
  const messages = [delta('第一块'), assistant('第一块'), delta('第二块'), assistant('第二块'), assistant('第二块')];
  assert.deepEqual(messages.map(message => normalizeClaudeSdkMessage(message)).map(event => event && `${event.type}:${event.text}`), [
    'delta:第一块', 'message:第一块', 'delta:第二块', 'message:第二块', 'message:第二块',
  ]);
});

test('Claude 保留子 Agent 工具摘要，隐藏 thinking 和工具参数正文', () => {
  assert.deepEqual(normalizeClaudeSdkMessage({ type: 'tool_progress', parent_tool_use_id: 'tool-explore', session_id: 'native-main', tool_name: 'Read' }), { type: 'tool', text: 'Claude 工具执行中：Read', nativeSessionId: undefined });
  assert.equal(normalizeClaudeSdkMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '隐藏推理' }, { type: 'tool_use', input: { command: '隐藏参数' } }] } }), undefined);
  assert.equal(normalizeClaudeSdkMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '隐藏推理' } } }), undefined);
});

test('Claude API 自动重试显示安全诊断信息但隐藏 SDK 错误正文', () => {
  assert.deepEqual(normalizeClaudeSdkMessage({
    type: 'system', subtype: 'api_retry', session_id: 'native-main', attempt: 1, max_retries: 2,
    retry_delay_ms: 1500, error_status: null,
    no_response: { waited_ms: 60000, retry_wait_ms: 4000 },
    error: { message: 'Bearer secret-api-key should never be shown' },
  }), {
    type: 'status',
    text: 'Claude API 请求重试中：第 1/2 次；网络未收到 HTTP 响应，等待 1500 毫秒；首次响应头等待 60000 毫秒后仍未收到响应，下一次首响应头等待上限 4000 毫秒',
    nativeSessionId: 'native-main',
  });
  assert.deepEqual(normalizeClaudeSdkMessage({
    type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 3,
    retry_delay_ms: 800, error_status: 429, error: 'api key secret-api-key',
  }), {
    type: 'status', text: 'Claude API 请求重试中：第 2/3 次；HTTP 429，等待 800 毫秒', nativeSessionId: undefined,
  });
  assert.deepEqual(normalizeClaudeSdkMessage({ type: 'system', subtype: 'api_retry', error: 'secret error' }), {
    type: 'status', text: 'Claude API 请求暂时失败，SDK 正在自动重试', nativeSessionId: undefined,
  });
});

test('Claude 工具生命周期按调用 ID 关联并保留同消息正文，不存参数、输出或隐藏推理', () => {
  let time = 1000;
  const normalize = createClaudeSdkMessageNormalizer('synthetic-key', () => time);
  const call = {
    type: 'assistant', parent_tool_use_id: null, session_id: 'native-main',
    message: { content: [{ type: 'thinking', thinking: '不能记录的推理' }, { type: 'tool_use', id: 'toolu_fetch', name: 'WebFetch', input: { url: '不能记录的网址 synthetic-key' } }, { type: 'text', text: '正在查询' }] },
  };
  assert.deepEqual(normalize(call), [
    { type: 'tool', text: 'Claude 工具开始：WebFetch', performance: { callId: 'toolu_fetch', phase: 'started', operation: 'claude.WebFetch', stage: 'search' } },
    { type: 'message', text: '正在查询', nativeSessionId: 'native-main' },
  ]);
  assert.equal(normalize(call).filter(event => event.performance).length, 0, '重复 assistant 不会重复开启同一调用');
  assert.deepEqual(normalize({ type: 'tool_progress', tool_use_id: 'toolu_fetch', tool_name: 'WebFetch', elapsed_time_seconds: 1.25, session_id: 'native-main', parent_tool_use_id: null }), [
    { type: 'tool', text: 'Claude 工具执行中：WebFetch（已执行 1.3 秒）', nativeSessionId: 'native-main' },
  ]);
  time = 3500;
  const result = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fetch', is_error: true, content: '不能记录的服务响应 synthetic-key' }] } };
  assert.deepEqual(normalize(result), [
    { type: 'tool', text: 'Claude 工具失败：WebFetch（耗时 2500 毫秒）', performance: { callId: 'toolu_fetch', phase: 'completed', operation: 'claude.WebFetch', stage: 'search', exitCode: 1 } },
  ]);
  assert.deepEqual(normalize(result), [], '重复结果不会重复结束调用');
  assert.deepEqual(createClaudeSdkMessageNormalizer()(result), [], '新轮次不会继承上一轮的调用记录');
});

test('Claude 工具事件拒绝不安全名称和 ID，忽略子 Agent 工具正文且不改变主会话绑定', () => {
  const normalize = createClaudeSdkMessageNormalizer('synthetic-key');
  const message = { type: 'assistant', parent_tool_use_id: 'tool-parent', session_id: 'native-child', message: { content: [{ type: 'tool_use', id: 'child_call', name: 'Read', input: { path: 'private' } }, { type: 'text', text: '子 Agent 正文' }] } };
  assert.deepEqual(normalize(message), []);
  assert.deepEqual(normalize({ type: 'user', parent_tool_use_id: 'tool-parent', message: { content: [{ type: 'tool_result', tool_use_id: 'child_call', content: 'private' }] } }), []);
  assert.deepEqual(normalize({ type: 'tool_progress', tool_use_id: 'child_call', tool_name: 'Read', parent_tool_use_id: 'tool-parent', session_id: 'native-child', elapsed_time_seconds: 2 }), [
    { type: 'tool', text: 'Claude 工具执行中：Read（已执行 2 秒）', nativeSessionId: undefined },
  ]);
  const unsafeEvents = normalize({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'unsafe\ncall', name: 'Read' }, { type: 'tool_use', id: 'safe_call', name: 'synthetic-key', input: { secret: 'private' } }] } });
  assert.deepEqual(unsafeEvents, [{ type: 'tool', text: 'Claude 工具开始：未知工具', performance: { callId: 'safe_call', phase: 'started', operation: 'claude.未知工具', stage: 'tool' } }]);
});

test('Claude sendTurn 中子 Agent 总结不会冒充主回复或替换原生会话绑定', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-parent-events-'));
  const executablePath = join(cwd, 'claude.exe');
  await writeFile(executablePath, 'fixture');
  const sdk: ClaudeSdkModule = { query() {
    return { async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'native-main' };
      yield { ...delta('子 Agent 长总结', 'tool-explore'), session_id: 'native-child' };
      yield { ...assistant('子 Agent 长总结', 'tool-explore'), session_id: 'native-child' };
      yield { type: 'tool_progress', tool_name: 'Read', parent_tool_use_id: 'tool-explore', session_id: 'native-child', elapsed_time_seconds: 2 };
      yield delta('主 Agent 最终总结');
      yield { ...assistant('主 Agent 最终总结'), message: { content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { path: 'private' } }, { type: 'text', text: '主 Agent 最终总结' }] } };
      yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'private output' }] } };
      yield { type: 'result', subtype: 'success', session_id: 'native-main' };
    } };
  } };
  const events: RuntimeEvent[] = [];
  const nativeIds: string[] = [];
  const adapter = new ClaudeAgentSdkRuntimeAdapter({ model: 'claude-fixture', apiKey: 'synthetic-claude-events-key', executablePath, sdkLoader: async () => sdk, onNativeSessionId: (_threadId, nativeId) => nativeIds.push(nativeId) });
  adapter.onEvent(event => events.push(event));
  try {
    const thread = await adapter.startSession(cwd);
    await adapter.sendTurn(thread, '读一下这个项目', cwd);
    assert.deepEqual(events.filter(event => !event.performance).map(event => `${event.type}:${event.text}`), [
      'status:running', 'status:Claude Runtime 会话已启动', 'tool:Claude 工具执行中：Read（已执行 2 秒）', 'delta:主 Agent 最终总结', 'message:主 Agent 最终总结', 'status:completed',
    ]);
    assert.deepEqual(events.filter(event => event.performance).map(event => event.performance), [
      { callId: 'toolu_read', phase: 'started', operation: 'claude.Read', stage: 'read' },
      { callId: 'toolu_read', phase: 'completed', operation: 'claude.Read', stage: 'read', exitCode: 0 },
    ]);
    assert.ok(events.every(event => event.threadId === thread));
    assert.ok(nativeIds.length > 0 && nativeIds.every(nativeId => nativeId === 'native-main'));
    assert.equal(adapter.getNativeSessionId(thread), 'native-main');
    await adapter.sendTurn(thread, '继续阅读', cwd);
    assert.equal(events.filter(event => event.type === 'message' && event.text === '主 Agent 最终总结').length, 2, '相同顶层回复在不同轮次均保留');
    assert.equal(events.filter(event => event.performance?.phase === 'started').length, 2, '每轮独立记录相同工具 ID 的生命周期');
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

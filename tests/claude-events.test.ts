import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeAgentSdkRuntimeAdapter, normalizeClaudeSdkMessage, type ClaudeSdkModule } from '../packages/agent-runtime/src/claude-adapter';
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
  assert.deepEqual(normalizeClaudeSdkMessage({ type: 'tool_progress', parent_tool_use_id: 'tool-explore', session_id: 'native-main', tool_name: 'Read' }), { type: 'tool', text: 'Claude 工具执行中：Read', nativeSessionId: 'native-main' });
  assert.equal(normalizeClaudeSdkMessage({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '隐藏推理' }, { type: 'tool_use', input: { command: '隐藏参数' } }] } }), undefined);
  assert.equal(normalizeClaudeSdkMessage({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '隐藏推理' } } }), undefined);
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
      yield delta('主 Agent 最终总结');
      yield assistant('主 Agent 最终总结');
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
    assert.deepEqual(events.map(event => `${event.type}:${event.text}`), [
      'status:running', 'status:Claude Runtime 会话已启动', 'delta:主 Agent 最终总结', 'message:主 Agent 最终总结', 'status:completed',
    ]);
    assert.ok(events.every(event => event.threadId === thread));
    assert.ok(nativeIds.length > 0 && nativeIds.every(nativeId => nativeId === 'native-main'));
    assert.equal(adapter.getNativeSessionId(thread), 'native-main');
    await adapter.sendTurn(thread, '继续阅读', cwd);
    assert.equal(events.filter(event => event.type === 'message' && event.text === '主 Agent 最终总结').length, 2, '相同顶层回复在不同轮次均保留');
  } finally {
    await adapter.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

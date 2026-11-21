import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeForSelectedModel } from '../apps/desktop/src/renderer/session-runtime-selection';

test('GPT 模型默认选择 Codex Runtime', () => {
  assert.equal(runtimeForSelectedModel('gpt-5.4'), 'codex');
  assert.equal(runtimeForSelectedModel('openai/gpt-4.1-mini'), 'codex');
  assert.equal(runtimeForSelectedModel('model-42', 'GPT5.4'), 'codex');
});

test('Claude 模型默认选择 Claude Agent SDK Runtime', () => {
  assert.equal(runtimeForSelectedModel('claude-sonnet-4-5'), 'claude_agent_sdk');
  assert.equal(runtimeForSelectedModel('anthropic/claude-opus-4'), 'claude_agent_sdk');
  assert.equal(runtimeForSelectedModel('model-42', 'Claude 3.7 Sonnet'), 'claude_agent_sdk');
});

test('其他模型不覆盖手动选择的 Runtime', () => {
  assert.equal(runtimeForSelectedModel('deepseek-v3'), undefined);
  assert.equal(runtimeForSelectedModel('chatgpt-compatible-model'), undefined);
  assert.equal(runtimeForSelectedModel('o3-mini'), undefined);
});

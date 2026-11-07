import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionRunActive } from '../apps/desktop/src/renderer/session-run-state';

test('历史 running 状态不会锁定没有本地活动任务的会话输入框', () => {
  assert.equal(isSessionRunActive('session-1', new Set(), false), false);
  assert.equal(isSessionRunActive('session-1', new Set(['other-session']), false), false);
});

test('当前会话发送中或在本地运行集合中时保持运行锁定', () => {
  assert.equal(isSessionRunActive('session-1', new Set(['session-1']), false), true);
  assert.equal(isSessionRunActive('session-1', new Set(), true), true);
  assert.equal(isSessionRunActive('', new Set(['session-1']), false), false);
});

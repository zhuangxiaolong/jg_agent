import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionRunActive } from '../apps/desktop/src/renderer/session-run-state';

test('历史 running 状态不会锁定没有本地活动任务的会话输入框', () => {
  assert.equal(isSessionRunActive('session-1', new Set(), new Set()), false);
  assert.equal(isSessionRunActive('session-1', new Set(['other-session']), new Set()), false);
});

test('当前会话发送中或在本地运行集合中时保持运行锁定', () => {
  assert.equal(isSessionRunActive('session-1', new Set(['session-1']), new Set()), true);
  assert.equal(isSessionRunActive('session-1', new Set(), new Set(['session-1'])), true);
  assert.equal(isSessionRunActive('', new Set(['session-1']), new Set()), false);
});

test('其它会话发送尚未返回时，新会话不显示停止按钮也不锁定输入', () => {
  const active = new Set(['session-1']);
  const sending = new Set(['session-1']);
  assert.equal(isSessionRunActive('session-2', active, sending), false);
  assert.equal(isSessionRunActive('session-1', active, sending), true);
});

test('并行发送时一个会话结束不会解锁其它仍在运行的会话', () => {
  const active = new Set(['session-1', 'session-2']);
  const sending = new Set(['session-1', 'session-2']);
  active.delete('session-1');
  sending.delete('session-1');
  assert.equal(isSessionRunActive('session-1', active, sending), false);
  assert.equal(isSessionRunActive('session-2', active, sending), true);
  assert.equal(isSessionRunActive('session-3', active, sending), false);
});

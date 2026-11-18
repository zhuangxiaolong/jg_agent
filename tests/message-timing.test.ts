import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../packages/domain/src';
import { assistantMessageDurations, formatClockTime, formatDuration } from '../apps/desktop/src/renderer/message-timing';

function event(id: string, type: AgentEvent['type'], text: string, createdAt: string, requestId?: string): AgentEvent {
  return { id, sessionId: 'session-1', type, text, createdAt, ...(requestId ? { requestId } : {}) };
}

test('会话时钟显示本地时分秒', () => {
  assert.match(formatClockTime('2026-11-17T13:40:05.000+08:00'), /^\d{2}:\d{2}:\d{2}$/);
});

test('回复用时按小时、分钟和秒显示', () => {
  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(65_999), '1分钟5秒');
  assert.equal(formatDuration(3_723_999), '1小时2分钟3秒');
  assert.equal(formatDuration(-5_000), '0秒');
});

test('正常和失败回复分别关联到各自本轮的最后一条助手输出', () => {
  const durations = assistantMessageDurations([
    event('u1', 'user', '查天气', '2026-11-17T05:40:00.000Z'),
    event('s1', 'status', 'running', '2026-11-17T05:40:02.000Z'),
    event('d1', 'delta', '佛山明天', '2026-11-17T05:40:03.000Z'),
    event('m1', 'message', '佛山明天有小雨。', '2026-11-17T05:40:10.000Z'),
    event('c1', 'status', 'completed', '2026-11-17T05:51:53.000Z'),
    event('u2', 'user', '再查一次', '2026-11-17T05:52:00.000Z'),
    event('s2', 'status', 'running', '2026-11-17T05:52:01.000Z'),
    event('e2', 'error', '连接失败', '2026-11-17T05:52:03.000Z'),
    event('f2', 'status', 'failed', '2026-11-17T05:52:05.000Z')
  ]);
  assert.deepEqual([...durations], [['m1', 713_000], ['e2', 5_000]]);
});

test('排队补充任务从开始执行事件计时，不包含排队等待', () => {
  const durations = assistantMessageDurations([
    event('u1', 'user', '当前任务', '2026-11-17T05:40:00.000Z'),
    event('s1', 'status', 'running', '2026-11-17T05:40:01.000Z'),
    event('u2', 'user', '排队任务', '2026-11-17T05:40:05.000Z', 'queued-turn:1'),
    event('c1', 'status', 'completed', '2026-11-17T05:40:30.000Z'),
    event('q2', 'status', '开始执行排队补充任务。', '2026-11-17T05:40:31.000Z', 'queued-turn:1'),
    event('s2', 'status', 'running', '2026-11-17T05:40:32.000Z'),
    event('m2', 'message', '排队回复', '2026-11-17T05:40:40.000Z'),
    event('c2', 'status', 'completed', '2026-11-17T05:40:50.000Z')
  ]);
  assert.deepEqual([...durations], [['m2', 19_000]]);
});

test('仍在运行的会话不提前显示回复用时', () => {
  const durations = assistantMessageDurations([
    event('u1', 'user', '任务', '2026-11-17T05:40:00.000Z'),
    event('s1', 'status', 'running', '2026-11-17T05:40:01.000Z'),
    event('m1', 'message', '尚未结束的输出', '2026-11-17T05:40:05.000Z')
  ]);
  assert.equal(durations.size, 0);
});

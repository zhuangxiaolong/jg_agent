import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventBatcher } from '../apps/desktop/src/main/runtime-event-batcher';
import type { RuntimeEvent } from '../packages/agent-runtime/src';

test('流式增量合并减少同步SQLite写入，工具与终态前完整刷新', () => {
  const rows: RuntimeEvent[] = [], batcher = new RuntimeEventBatcher(event => rows.push(event));
  for (let i = 0; i < 100; i++) batcher.push({ type: 'delta', text: '中', threadId: 'a' });
  assert.equal(rows.length, 0);
  batcher.push({ type: 'tool', text: '命令已完成', threadId: 'a' });
  batcher.push({ type: 'delta', text: '结束', threadId: 'a' });
  batcher.push({ type: 'status', text: 'completed', threadId: 'a' });
  assert.deepEqual(rows.map(row => [row.type, row.text]), [['delta', '中'.repeat(100)], ['tool', '命令已完成'], ['delta', '结束'], ['status', 'completed']]);
});

test('不同线程不能合并，定时刷新与取消前手动刷新不丢文本', async () => {
  const rows: RuntimeEvent[] = [], batcher = new RuntimeEventBatcher(event => rows.push(event), 10);
  batcher.push({ type: 'delta', text: '一', threadId: 'a' });
  batcher.push({ type: 'delta', text: '二', threadId: 'b' });
  await new Promise(resolve => setTimeout(resolve, 25));
  batcher.push({ type: 'delta', text: '三', threadId: 'b' }); batcher.flush(); batcher.flush();
  assert.deepEqual(rows.map(row => row.text), ['一', '二', '三']);
});

test('首个可见增量立即发布，随后100片合并且工具与终态前保持顺序', () => {
  const rows: RuntimeEvent[] = [], batcher = new RuntimeEventBatcher(event => rows.push(event), 80, true);
  batcher.push({ type: 'delta', text: '首', threadId: 'a' });
  assert.deepEqual(rows.map(row => row.text), ['首']);
  for (let i = 0; i < 100; i++) batcher.push({ type: 'delta', text: '中', threadId: 'a' });
  assert.equal(rows.length, 1);
  batcher.push({ type: 'tool', text: '读取完成', threadId: 'a' });
  batcher.push({ type: 'delta', text: '结', threadId: 'a' });
  batcher.push({ type: 'delta', text: '束', threadId: 'a' });
  assert.equal(rows.length, 3);
  batcher.push({ type: 'status', text: 'completed', threadId: 'a' });
  assert.deepEqual(rows.map(row => [row.type, row.text]), [['delta', '首'], ['delta', '中'.repeat(100)], ['tool', '读取完成'], ['delta', '结束'], ['status', 'completed']]);
});

test('空白增量不占用首字即时发布机会，先前空白按原顺序保留', () => {
  const rows: RuntimeEvent[] = [], batcher = new RuntimeEventBatcher(event => rows.push(event), 80, true);
  batcher.push({ type: 'delta', text: '', threadId: 'a' });
  batcher.push({ type: 'delta', text: '\n ', threadId: 'a' });
  assert.equal(rows.length, 0);
  batcher.push({ type: 'delta', text: '首字', threadId: 'a' });
  assert.deepEqual(rows.map(row => row.text), ['\n ', '首字']);
  batcher.push({ type: 'delta', text: '后续', threadId: 'a' });
  assert.equal(rows.length, 2);
  batcher.flush();
  assert.deepEqual(rows.map(row => row.text), ['\n ', '首字', '后续']);
});

test('首字即时模式仍隔离不同线程，定时刷新和终态不丢字或重复发布', async () => {
  const rows: RuntimeEvent[] = [], batcher = new RuntimeEventBatcher(event => rows.push(event), 10, true);
  batcher.push({ type: 'delta', text: '首', threadId: 'a' });
  batcher.push({ type: 'delta', text: '一', threadId: 'a' });
  batcher.push({ type: 'delta', text: '二', threadId: 'b' });
  assert.deepEqual(rows.map(row => [row.threadId, row.text]), [['a', '首'], ['a', '一']]);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(rows.map(row => [row.threadId, row.text]), [['a', '首'], ['a', '一'], ['b', '二']]);
  batcher.push({ type: 'delta', text: '三', threadId: 'b' });
  batcher.push({ type: 'status', text: 'interrupted', threadId: 'b' });
  batcher.flush();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(rows.map(row => [row.threadId, row.text]), [['a', '首'], ['a', '一'], ['b', '二'], ['b', '三'], ['b', 'interrupted']]);
});

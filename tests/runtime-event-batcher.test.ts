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

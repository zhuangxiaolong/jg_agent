import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadonlyToolConcurrency } from '../packages/agent-runtime/src/readonly-tool-concurrency';

test('只读工具并发最多三路且排队调用可取消', async () => {
  const gate = new ReadonlyToolConcurrency(3);
  let active = 0; let peak = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => gate.run('turn', async () => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return index;
  }));
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(peak, 3);
  const busy = Array.from({ length: 3 }, () => gate.run('busy-turn', async () => { await new Promise(resolve => setTimeout(resolve, 20)); return 1; }));
  const controller = new AbortController(); const pending = gate.run('cancelled-turn', async () => 1, controller.signal);
  controller.abort(); await assert.rejects(pending, /取消/); await Promise.all(busy);
});

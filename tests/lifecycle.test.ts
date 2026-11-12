import test from 'node:test';
import assert from 'node:assert/strict';
import { RunLifecycle } from '../apps/desktop/src/main/lifecycle';

test('取消异步启动后禁止旧请求进入下一阶段，也不能清除新任务', async () => {
  const runs = new RunLifecycle();
  const old = runs.begin('first-session');
  let resume!: () => void;
  let turnStarted = false;
  const startup = (async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    runs.assertCurrent(old);
    turnStarted = true;
  })();
  runs.cancel(old);
  assert.throws(() => runs.begin('first-session'), /执行的任务/);
  runs.finish(old);
  const next = runs.begin('second-session');
  resume();
  await assert.rejects(startup, /已取消/);
  assert.equal(turnStarted, false);
  runs.finish(old);
  assert.equal(runs.get('second-session'), next);
});

test('任务令牌按对象身份绑定，同一会话的旧完成事件不能覆盖新请求', () => {
  const runs = new RunLifecycle();
  const first = runs.begin('same-session');
  runs.finish(first);
  const second = runs.begin('same-session');
  assert.throws(() => runs.assertCurrent(first), /已取消/);
  runs.cancel(first);
  assert.equal(second.cancelled, false);
  runs.assertCurrent(second);
  runs.finish(second);
  assert.equal(runs.get('same-session'), undefined);
});

test('不同会话可并发运行，取消或结束一个会话不影响另一个会话', () => {
  const runs = new RunLifecycle();
  const first = runs.begin('first-session');
  const second = runs.begin('second-session');
  assert.equal(runs.size, 2);
  assert.deepEqual(runs.tickets, [first, second]);
  assert.throws(() => runs.begin('second-session'), /当前会话有正在执行的任务/);
  runs.cancel(first);
  assert.throws(() => runs.assertCurrent(first), /已取消/);
  runs.assertCurrent(second);
  assert.equal(second.cancelled, false);
  runs.finish(first);
  assert.equal(runs.get('first-session'), undefined);
  assert.equal(runs.get('second-session'), second);
  assert.equal(runs.size, 1);
  const newer = runs.begin('first-session');
  runs.finish(first);
  runs.cancel(first);
  runs.assertCurrent(newer);
  runs.assertCurrent(second);
  assert.equal(runs.size, 2);
});

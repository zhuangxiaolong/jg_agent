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
  assert.throws(() => runs.begin('another-session'), /执行的任务/);
  runs.finish(old);
  const next = runs.begin('second-session');
  resume();
  await assert.rejects(startup, /已取消/);
  assert.equal(turnStarted, false);
  runs.finish(old);
  assert.equal(runs.current, next);
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
  assert.equal(runs.current, undefined);
});

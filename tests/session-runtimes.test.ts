import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRuntimes } from '../apps/desktop/src/main/session-runtimes';
import { RunLifecycle } from '../apps/desktop/src/main/lifecycle';
import type { RuntimeAdapter } from '../packages/agent-runtime/src/manager';

function runtimeFixture() {
  let closed = 0;
  const cancelled: string[] = [];
  const adapter: RuntimeAdapter = {
    kind: 'claude_agent_sdk', version: 'fixture', capabilitiesVersion: 1,
    onEvent() { return () => undefined; },
    async checkRuntime() { return { kind: 'claude_agent_sdk', available: true, compatible: true, version: 'fixture', detail: '测试实例' }; },
    async start() {}, async startSession() { return 'fixture-thread'; }, async resumeSession(threadId) { return threadId; },
    async sendTurn() {}, async cancelRun(threadId) { cancelled.push(threadId); }, async close() { closed += 1; },
  };
  return { adapter, cancelled, get closed() { return closed; } };
}

test('会话 Runtime 各自持有实例，停止一个会话不会关闭或取消其它会话', async () => {
  const runs = new RunLifecycle();
  const runtimes = new SessionRuntimes();
  const first = runs.begin('first-session');
  const second = runs.begin('second-session');
  const a = runtimeFixture(), b = runtimeFixture();
  runtimes.bind(first, a.adapter);
  runtimes.bind(second, b.adapter);
  assert.equal(runtimes.get(first.sessionId), a.adapter);
  assert.equal(runtimes.get(second.sessionId), b.adapter);
  runs.cancel(first);
  await runtimes.get(first.sessionId)!.cancelRun('first-thread');
  await runtimes.closeSession(first.sessionId);
  runs.finish(first);
  assert.equal(a.closed, 1);
  assert.deepEqual(a.cancelled, ['first-thread']);
  assert.equal(b.closed, 0);
  assert.deepEqual(b.cancelled, []);
  assert.equal(runtimes.get(first.sessionId), undefined);
  assert.equal(runtimes.get(second.sessionId), b.adapter);
  assert.equal(runtimes.owns(second, b.adapter), true);
  runs.assertCurrent(second);
});

test('旧实例的延迟事件或取消清理不能匹配并释放同会话的新轮次', async () => {
  const runs = new RunLifecycle();
  const runtimes = new SessionRuntimes();
  const old = runs.begin('same-session');
  const a = runtimeFixture(), b = runtimeFixture();
  runtimes.bind(old, a.adapter);
  runs.finish(old);
  const next = runs.begin('same-session');
  runtimes.bind(next, b.adapter);
  assert.equal(runtimes.owns(old, a.adapter), false);
  assert.equal(runtimes.owns(next, a.adapter), false);
  assert.equal(runtimes.owns(old, b.adapter), false);
  assert.equal(runtimes.getForTicket(old), undefined);
  assert.equal(runtimes.getForTicket(next), b.adapter);
  runtimes.release(old, a.adapter);
  runs.finish(old);
  assert.equal(runtimes.get(next.sessionId), b.adapter);
  runs.assertCurrent(next);
  runtimes.release(next, b.adapter);
  assert.equal(runtimes.get(next.sessionId), undefined);
});

test('退出时关闭所有会话 Runtime，某个实例失败不会遗漏其余实例', async () => {
  const runs = new RunLifecycle();
  const runtimes = new SessionRuntimes();
  const a = runtimeFixture(), b = runtimeFixture();
  a.adapter.close = async () => { throw new Error('测试关闭失败'); };
  runtimes.bind(runs.begin('first-session'), a.adapter);
  runtimes.bind(runs.begin('second-session'), b.adapter);
  await runtimes.closeAll();
  assert.equal(b.closed, 1);
  assert.equal(runtimes.get('first-session'), undefined);
  assert.equal(runtimes.get('second-session'), undefined);
});

for (const terminalFirst of [true, false]) {
  test(`Runtime 终态${terminalFirst ? '早于' : '晚于'}发送结算时，两个条件满足才关闭并释放实例`, async () => {
    const runs = new RunLifecycle();
    const runtimes = new SessionRuntimes();
    const ticket = runs.begin('session');
    const a = runtimeFixture();
    runtimes.bind(ticket, a.adapter);
    if (terminalFirst) await runtimes.markTerminal(ticket, a.adapter);
    else await runtimes.markSendSettled(ticket, a.adapter);
    assert.equal(a.closed, 0);
    assert.equal(runtimes.get(ticket.sessionId), a.adapter);
    if (terminalFirst) await runtimes.markSendSettled(ticket, a.adapter);
    else await runtimes.markTerminal(ticket, a.adapter);
    assert.equal(a.closed, 1);
    assert.equal(runtimes.get(ticket.sessionId), undefined);
    await runtimes.markTerminal(ticket, a.adapter);
    await runtimes.markSendSettled(ticket, a.adapter);
    assert.equal(a.closed, 1);
  });
}

test('旧轮次迟到的终态或发送结算不会关闭同会话新实例', async () => {
  const runs = new RunLifecycle();
  const runtimes = new SessionRuntimes();
  const old = runs.begin('session');
  const a = runtimeFixture(), b = runtimeFixture();
  runtimes.bind(old, a.adapter);
  await runtimes.markTerminal(old, a.adapter);
  runs.finish(old);
  const next = runs.begin('session');
  runtimes.bind(next, b.adapter);
  await runtimes.markSendSettled(old, a.adapter);
  await runtimes.markTerminal(old, a.adapter);
  assert.equal(b.closed, 0);
  assert.equal(runtimes.get(next.sessionId), b.adapter);
  assert.equal(runtimes.owns(next, b.adapter), true);
});

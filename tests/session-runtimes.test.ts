import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionRuntimes } from '../apps/desktop/src/main/session-runtimes';
import { RunLifecycle } from '../apps/desktop/src/main/lifecycle';
import type { RuntimeAdapter } from '../packages/agent-runtime/src/manager';

function runtimeFixture(kind: RuntimeAdapter['kind'] = 'claude_agent_sdk') {
  let closed = 0;
  const cancelled: string[] = [];
  const adapter: RuntimeAdapter = {
    kind, version: 'fixture', capabilitiesVersion: 1,
    onEvent() { return () => undefined; },
    async checkRuntime() { return { kind, available: true, compatible: true, version: 'fixture', detail: '测试实例' }; },
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

for (const terminalFirst of [true, false]) {
  test(`Grok 可复用终态${terminalFirst ? '早于' : '晚于'}发送结算时，双结算后才空闲并注销旧监听`, async () => {
    const runs = new RunLifecycle(), runtimes = new SessionRuntimes();
    const old = runs.begin('session'), a = runtimeFixture('grok_build_acp');
    let unsubscribed = 0;
    runtimes.bind(old, a.adapter, 'same-configuration');
    assert.equal(runtimes.hasActive(old.sessionId), true);
    runtimes.setEventSubscription(old, a.adapter, () => { unsubscribed++; });
    if (terminalFirst) await runtimes.markTerminal(old, a.adapter, true);
    else await runtimes.markSendSettled(old, a.adapter);
    runs.finish(old);
    const next = runs.begin('session');
    assert.equal(runtimes.takeReusable(next, 'same-configuration'), undefined);
    assert.equal(runtimes.hasActive(old.sessionId), true);
    assert.equal(unsubscribed, 0);
    if (terminalFirst) await runtimes.markSendSettled(old, a.adapter);
    else await runtimes.markTerminal(old, a.adapter, true);
    assert.equal(a.closed, 0);
    assert.equal(unsubscribed, 1);
    assert.equal(runtimes.hasActive(old.sessionId), false);
    assert.equal(runtimes.takeReusable(next, 'same-configuration'), a.adapter);
    assert.equal(runtimes.getForTicket(old), undefined);
    assert.equal(runtimes.get('session'), undefined);
    assert.equal(unsubscribed, 1);
    runtimes.bind(next, a.adapter, 'same-configuration');
    assert.equal(runtimes.hasActive(next.sessionId), true);
    runtimes.setEventSubscription(next, a.adapter, () => { unsubscribed++; });
    await runtimes.markTerminal(old, a.adapter);
    await runtimes.markSendSettled(old, a.adapter);
    runtimes.release(old, a.adapter);
    assert.equal(runtimes.getForTicket(next), a.adapter);
    assert.equal(a.closed, 0);
    assert.equal(unsubscribed, 1);
    await runtimes.closeAll();
    assert.equal(runtimes.hasActive(next.sessionId), false);
    assert.equal(a.closed, 1);
    assert.equal(unsubscribed, 2);
  });
}

test('只有显式允许且存在配置标识的受支持 Runtime 保留，其它终态沿用关闭行为', async () => {
  const cases: Array<{ kind: RuntimeAdapter['kind']; key?: string; reusable: boolean; cancelled?: boolean }> = [
    { kind: 'grok_build_acp', key: 'config', reusable: false },
    { kind: 'grok_build_acp', reusable: true },
    { kind: 'claude_agent_sdk', key: 'config', reusable: true },
    { kind: 'codex', reusable: true },
    { kind: 'grok_build_acp', key: 'config', reusable: true, cancelled: true },
  ];
  for (const item of cases) {
    const runs = new RunLifecycle(), runtimes = new SessionRuntimes(), a = runtimeFixture(item.kind);
    const ticket = runs.begin('session');
    runtimes.bind(ticket, a.adapter, item.key);
    assert.equal(runtimes.hasActive(ticket.sessionId), true);
    await runtimes.markTerminal(ticket, a.adapter, item.reusable);
    if (item.cancelled) runs.cancel(ticket);
    await runtimes.markSendSettled(ticket, a.adapter);
    assert.equal(a.closed, 1);
    assert.equal(runtimes.get('session'), undefined);
    assert.equal(runtimes.hasActive('session'), false);
  }
});

test('Grok 空闲复用校验会话、配置和新旧票据取消状态，不跨会话取得实例', async () => {
  const runs = new RunLifecycle(), runtimes = new SessionRuntimes(), a = runtimeFixture('grok_build_acp');
  const old = runs.begin('session');
  runtimes.bind(old, a.adapter, 'config');
  await runtimes.markTerminal(old, a.adapter, true);
  await runtimes.markSendSettled(old, a.adapter);
  assert.equal(runtimes.takeReusable(old, 'config'), undefined);
  assert.equal(runtimes.takeReusable(runs.begin('other-session'), 'config'), undefined);
  runs.finish(old);
  const next = runs.begin('session');
  assert.equal(runtimes.takeReusable(next, 'changed-config'), undefined);
  next.cancelled = true;
  assert.equal(runtimes.takeReusable(next, 'config'), undefined);
  next.cancelled = false;
  old.cancelled = true;
  assert.equal(runtimes.takeReusable(next, 'config'), undefined);
  assert.equal(a.closed, 0);
  await runtimes.closeAll();
  assert.equal(a.closed, 1);
});

test('Grok 空闲超时回收，取出重绑后旧超时和旧票据不能关闭新轮', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const runs = new RunLifecycle(), runtimes = new SessionRuntimes(50), a = runtimeFixture('grok_build_acp'), b = runtimeFixture('grok_build_acp');
  const first = runs.begin('expired'), old = runs.begin('reused');
  runtimes.bind(first, a.adapter, 'config'); runtimes.bind(old, b.adapter, 'config');
  await runtimes.markTerminal(first, a.adapter, true); await runtimes.markSendSettled(first, a.adapter);
  await runtimes.markTerminal(old, b.adapter, true); await runtimes.markSendSettled(old, b.adapter);
  runs.finish(old);
  const next = runs.begin('reused');
  assert.equal(runtimes.takeReusable(next, 'config'), b.adapter);
  runtimes.bind(next, b.adapter, 'config');
  t.mock.timers.tick(51);
  await Promise.resolve();
  assert.equal(a.closed, 1);
  assert.equal(runtimes.get('expired'), undefined);
  assert.equal(b.closed, 0);
  assert.equal(runtimes.getForTicket(next), b.adapter);
  await runtimes.markTerminal(old, b.adapter);
  await runtimes.markSendSettled(old, b.adapter);
  assert.equal(b.closed, 0);
  await runtimes.closeAll();
  t.mock.timers.tick(100);
  assert.equal(b.closed, 1);
});

test('Grok 最多保留三个空闲实例，超限按进入空闲顺序回收且不影响活动实例', async () => {
  const runs = new RunLifecycle(), runtimes = new SessionRuntimes();
  const active = runtimeFixture('grok_build_acp');
  const ticket = runs.begin('active'); runtimes.bind(ticket, active.adapter, 'config');
  const idle: ReturnType<typeof runtimeFixture>[] = [];
  for (let index = 0; index < 5; index++) {
    const a = runtimeFixture('grok_build_acp'), current = runs.begin(`idle-${index}`); idle.push(a);
    runtimes.bind(current, a.adapter, 'config');
    await runtimes.markTerminal(current, a.adapter, true); await runtimes.markSendSettled(current, a.adapter);
  }
  assert.deepEqual(idle.map(item => item.closed), [1, 1, 0, 0, 0]);
  assert.equal(active.closed, 0);
  assert.equal(runtimes.getForTicket(ticket), active.adapter);
  await runtimes.closeAll();
  assert.deepEqual(idle.map(item => item.closed), [1, 1, 1, 1, 1]);
  assert.equal(active.closed, 1);
});

test('Runtime 监听替换、失效注册和 release 都只清理所属实例', async () => {
  const runs = new RunLifecycle(), runtimes = new SessionRuntimes(), a = runtimeFixture();
  const old = runs.begin('session'); let unsubscribed = 0;
  runtimes.bind(old, a.adapter);
  runtimes.setEventSubscription(old, a.adapter, () => { unsubscribed++; });
  runtimes.setEventSubscription(old, a.adapter, () => { unsubscribed++; });
  assert.equal(unsubscribed, 1);
  runs.finish(old); const next = runs.begin('session');
  runtimes.setEventSubscription(next, a.adapter, () => { unsubscribed++; });
  assert.equal(unsubscribed, 2);
  runtimes.release(next, a.adapter);
  assert.equal(runtimes.getForTicket(old), a.adapter);
  runtimes.release(old, a.adapter);
  assert.equal(unsubscribed, 3);
  assert.equal(runtimes.get('session'), undefined);
  assert.equal(a.closed, 0);
  await a.adapter.close();
});

test('空闲 Runtime 不接受旧监听重新注册，closeSession 和 release 清理超时', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const runs = new RunLifecycle(), runtimes = new SessionRuntimes(20);
  const a = runtimeFixture('grok_build_acp'), b = runtimeFixture('grok_build_acp');
  const first = runs.begin('first'), second = runs.begin('second'); let unsubscribed = 0;
  for (const [ticket, adapter] of [[first, a.adapter], [second, b.adapter]] as const) {
    runtimes.bind(ticket, adapter, 'config');
    runtimes.setEventSubscription(ticket, adapter, () => { unsubscribed++; });
    await runtimes.markTerminal(ticket, adapter, true); await runtimes.markSendSettled(ticket, adapter);
  }
  assert.equal(unsubscribed, 2);
  runtimes.setEventSubscription(first, a.adapter, () => { unsubscribed++; });
  assert.equal(unsubscribed, 3);
  await runtimes.closeSession(first.sessionId);
  runtimes.release(second, b.adapter);
  t.mock.timers.tick(21);
  await Promise.resolve();
  assert.equal(a.closed, 1);
  assert.equal(b.closed, 0);
  assert.equal(runtimes.get('first'), undefined);
  assert.equal(runtimes.get('second'), undefined);
  await b.adapter.close();
});

test('退出清理活动与空闲 Runtime 的监听和超时，监听异常不阻止回收', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const runs = new RunLifecycle(), runtimes = new SessionRuntimes(20);
  const a = runtimeFixture('grok_build_acp'), b = runtimeFixture('grok_build_acp');
  const first = runs.begin('first'), second = runs.begin('second'); let unsubscribed = 0;
  runtimes.bind(first, a.adapter, 'config'); runtimes.bind(second, b.adapter, 'config');
  runtimes.setEventSubscription(first, a.adapter, () => { unsubscribed++; throw new Error('测试监听清理失败'); });
  runtimes.setEventSubscription(second, b.adapter, () => { unsubscribed++; });
  await runtimes.markTerminal(first, a.adapter, true); await runtimes.markSendSettled(first, a.adapter);
  assert.equal(unsubscribed, 1);
  await runtimes.closeAll();
  t.mock.timers.tick(30);
  await Promise.resolve();
  assert.equal(unsubscribed, 2);
  assert.equal(a.closed, 1); assert.equal(b.closed, 1);
  assert.equal(runtimes.get('first'), undefined); assert.equal(runtimes.get('second'), undefined);
});

test('Codex 显式配置匹配时复用，旧票据无法释放新轮，失败结算后关闭', async () => {
  const runs = new RunLifecycle(), runtimes = new SessionRuntimes(), a = runtimeFixture('codex');
  const old = runs.begin('codex-session');
  runtimes.bind(old, a.adapter, 'codex-config');
  await runtimes.markTerminal(old, a.adapter, true);
  assert.equal(runtimes.hasActive(old.sessionId), true);
  await runtimes.markSendSettled(old, a.adapter);
  assert.equal(runtimes.hasActive(old.sessionId), false);
  assert.equal(a.closed, 0);
  runs.finish(old);
  const next = runs.begin(old.sessionId);
  assert.equal(runtimes.takeReusable(next, 'different-config'), undefined);
  assert.equal(runtimes.takeReusable(next, 'codex-config'), a.adapter);
  runtimes.bind(next, a.adapter, 'codex-config');
  await runtimes.markTerminal(old, a.adapter);
  runtimes.release(old, a.adapter);
  assert.equal(runtimes.getForTicket(next), a.adapter);
  assert.equal(runtimes.hasActive(next.sessionId), true);
  await runtimes.markSendSettled(next, a.adapter);
  await runtimes.markTerminal(next, a.adapter);
  assert.equal(a.closed, 1);
  assert.equal(runtimes.get(next.sessionId), undefined);
});

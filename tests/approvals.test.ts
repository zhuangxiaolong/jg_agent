import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker } from '../apps/desktop/src/main/approvals';
import { RunLifecycle } from '../apps/desktop/src/main/lifecycle';

test('审批只接受一次并以随机令牌绑定当前任务', async () => {
  const runs = new RunLifecycle();
  const ticket = runs.begin('session-1');
  const requests: any[] = [], resolved: string[] = [];
  const broker = new ApprovalBroker(() => runs.current, request => requests.push(request), token => resolved.push(token));
  const controller = new AbortController();
  const decision = broker.request(ticket, { kind: 'command', summary: 'npm test' }, controller.signal);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sessionId, 'session-1');
  assert.ok(requests[0].token);
  broker.decide(requests[0].token, 'accept');
  assert.equal(await decision, 'accept');
  assert.deepEqual(resolved, [requests[0].token]);
  assert.throws(() => broker.decide(requests[0].token, 'accept'), /已失效/);
});

test('取消和过期请求只能拒绝，不能批准旧任务', async () => {
  const runs = new RunLifecycle();
  const ticket = runs.begin('session-2');
  const requests: any[] = [];
  const broker = new ApprovalBroker(() => runs.current, request => requests.push(request), () => undefined);
  const controller = new AbortController();
  const decision = broker.request(ticket, { kind: 'fileChange', summary: '修改文件' }, controller.signal);
  controller.abort();
  assert.equal(await decision, 'decline');
  assert.throws(() => broker.decide(requests[0].token, 'accept'), /已失效/);

  const secondController = new AbortController();
  const secondDecision = broker.request(ticket, { kind: 'command', summary: 'npm test' }, secondController.signal);
  runs.cancel(ticket);
  broker.decline('session-2');
  assert.equal(await secondDecision, 'decline');
  assert.throws(() => broker.decide(requests[1].token, 'accept'), /已失效/);
});

test('窗口推送失败时自动拒绝审批', async () => {
  const runs = new RunLifecycle();
  const ticket = runs.begin('session-3');
  const broker = new ApprovalBroker(() => runs.current, () => { throw new Error('renderer closed'); }, () => undefined);
  assert.equal(await broker.request(ticket, { kind: 'command', summary: 'dotnet test' }, new AbortController().signal), 'decline');
});

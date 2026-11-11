import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WECOM_EVENT_POLICY,
  WeComDesktopNotificationService,
  WeComNotificationSender,
  WeComWebhookAdapter,
  createWeComIdempotencyKey,
  createWeComTextPayload,
  renderWeComMessage,
  resolveWeComTargets,
  type WeComNotificationTarget,
  type WeComDeliveryRecord,
  type WeComDeliveryRepository,
} from '../packages/wecom-notification/src';

const target = (overrides: Partial<WeComNotificationTarget> = {}): WeComNotificationTarget => ({
  id: 'team', name: '研发群', purpose: 'team_group', credentialRef: 'wecom.webhook.team', enabled: true,
  eventPolicy: { ...DEFAULT_WECOM_EVENT_POLICY }, ...overrides,
});

test('通知目标按会话、工作区、Runtime、全局顺序去重并过滤策略', () => {
  const event = { eventId: 'e1', platformSessionId: 's1', workspaceId: 'w1', runtimeKind: 'codex' as const, eventType: 'session.completed' as const, occurredAt: '2026-11-09T01:02:03Z', title: '任务' };
  const first = target({ id: 'first' });
  const second = target({ id: 'second', workspaceIds: ['w2'] });
  const disabled = target({ id: 'disabled', enabled: false });
  assert.deepEqual(resolveWeComTargets(event, [first, second, disabled], { sessionTargetIds: ['first', 'first'], workspaceTargetIds: ['second'], defaultTargetIds: ['disabled'] }).map(item => item.id), ['first']);
  assert.deepEqual(resolveWeComTargets({ ...event, eventType: 'session.cancelled' }, [first], { defaultTargetIds: ['first'] }), []);
});

test('成功与失败消息只保留摘要并脱敏控制字符、凭据和本机链接', () => {
  const success = renderWeComMessage({ eventId: 'e', platformSessionId: 's', runtimeKind: 'claude_agent_sdk', eventType: 'session.completed', occurredAt: '2026-11-09T01:02:03Z', title: '改造\n系统', workspaceId: 'workspace-1', workspaceName: 'D:\\secret', repositorySummaries: [{ name: '主仓库' }], changedFileCount: 2, testSummary: '通过', durationMs: 65000 });
  assert.match(success, /任务：改造 系统/);
  assert.match(success, /Claude Agent SDK/);
  assert.doesNotMatch(success, /D:\\secret/);
  const failed = renderWeComMessage({ eventId: 'e', platformSessionId: 's', runtimeKind: 'codex', eventType: 'session.error', occurredAt: 'now', title: '任务', errorSummary: 'Authorization: Bearer secret api_key=real' });
  assert.match(failed, /已脱敏/);
  assert.doesNotMatch(failed, /secret|real/);
});

test('文本消息仅允许团队目标配置@，拒绝 @all 和非法成员值', () => {
  assert.deepEqual(createWeComTextPayload('测试', { purpose: 'private_group', mentionedUserIds: ['bad user'], mentionedMobiles: ['not-phone'] }), { msgtype: 'text', text: { content: '测试' } });
  const payload = createWeComTextPayload('测试', { purpose: 'team_group', mentionedUserIds: ['zhang.san'], mentionedMobiles: ['13800138000'] });
  assert.deepEqual(payload.text.mentioned_list, ['zhang.san']);
  assert.deepEqual(payload.text.mentioned_mobile_list, ['13800138000']);
  assert.throws(() => createWeComTextPayload('测试', { purpose: 'team_group', mentionedUserIds: ['@all'] }), /@all/);
  assert.throws(() => createWeComTextPayload('测试', { purpose: 'team_group', mentionedMobiles: ['1'] }), /手机号/);
});

test('Webhook 请求只通过凭据读取地址，解析企业微信 errcode 并脱敏错误', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const adapter = new WeComWebhookAdapter(
    { getSecret: async reference => reference === 'wecom.webhook.team' ? 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' : null },
    async (url, init) => { requests.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ errcode: 0, errmsg: 'ok' }); },
  );
  const result = await adapter.sendText(target(), '完成');
  assert.deepEqual(result, { httpStatus: 200, errcode: 0 });
  assert.match(requests[0].url, /qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send/);
  assert.equal(requests[0].body.text.content, '完成');

  const rejected = new WeComWebhookAdapter(
    { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    async () => Response.json({ errcode: 93009, errmsg: '内部敏感服务端信息' }),
  );
  await assert.rejects(rejected.sendText(target(), '失败测试'), (error: any) => error.code === 'MENTION_INVALID' && !error.message.includes('内部'));
  const tooLong = new WeComWebhookAdapter(
    { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    async () => Response.json({ errcode: 93013 }),
  );
  await assert.rejects(tooLong.sendText(target(), '长度超限'), (error: any) => error.code === 'MESSAGE_INVALID' && !error.retryable);
  const missing = new WeComWebhookAdapter({ getSecret: async () => null });
  await assert.rejects(missing.sendText(target(), '缺凭据测试'), (error: any) => error.code === 'CREDENTIAL_MISSING');
  const credentialFailure = new WeComWebhookAdapter({ getSecret: async () => { throw new Error('webhook key=secret-key'); } });
  await assert.rejects(credentialFailure.sendText(target(), '凭据异常测试'), (error: any) => error.code === 'CREDENTIAL_MISSING' && !error.message.includes('secret-key'));
});

test('发送器对网络错误最多重试三次，永久错误不重试且按目标节流', async () => {
  let calls = 0;
  const waits: number[] = [];
  const adapter = new WeComWebhookAdapter(
    { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    async () => { calls++; if (calls < 3) throw new Error('offline'); return Response.json({ errcode: 0 }); },
    1000,
  );
  const sender = new WeComNotificationSender(adapter, { baseDelayMs: 10, minIntervalMs: 0, sleep: async value => { waits.push(value); }, random: () => 0 });
  const result = await sender.send(target(), '完成');
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [10, 20]);

  let permanentCalls = 0;
  const permanent = new WeComWebhookAdapter(
    { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    async () => { permanentCalls++; return Response.json({ errcode: 93008 }); },
  );
  const permanentResult = await new WeComNotificationSender(permanent, { minIntervalMs: 0 }).send(target(), '完成');
  assert.equal(permanentResult.ok, false);
  assert.equal(permanentResult.code, 'WEBHOOK_INVALID');
  assert.equal(permanentResult.attempts, 1);
  assert.equal(permanentCalls, 1);
});

test('同一机器人并发通知串行发送并满足最小发送间隔', async () => {
  let clock = 10_000;
  const startedAt: number[] = [];
  const adapter = new WeComWebhookAdapter(
    { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    async () => { startedAt.push(clock); await Promise.resolve(); return Response.json({ errcode: 0 }); },
  );
  const sender = new WeComNotificationSender(adapter, {
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
    minIntervalMs: 3000,
  });
  const results = await Promise.all([sender.send(target(), '第一条'), sender.send(target(), '第二条')]);
  assert.ok(results.every(result => result.ok));
  assert.equal(startedAt.length, 2);
  assert.ok(startedAt[1] - startedAt[0] >= 3000);
});

test('幂等键由稳定平台事件 ID 和目标组成', () => {
  assert.equal(createWeComIdempotencyKey('event-1', 'target-1'), 'event-1:target-1');
  assert.throws(() => createWeComIdempotencyKey('', 'target-1'), /去重/);
});

class MemoryWeComDeliveries implements WeComDeliveryRepository {
  readonly records = new Map<string, WeComDeliveryRecord>();

  async findByIdempotencyKey(key: string): Promise<WeComDeliveryRecord | undefined> {
    return [...this.records.values()].find(record => record.idempotencyKey === key);
  }

  async findById(id: string): Promise<WeComDeliveryRecord | undefined> {
    return this.records.get(id);
  }

  async listByStatus(status: WeComDeliveryRecord['status']): Promise<readonly WeComDeliveryRecord[]> {
    return [...this.records.values()].filter(record => record.status === status);
  }

  async insertIfAbsent(record: WeComDeliveryRecord): Promise<boolean> {
    if (await this.findByIdempotencyKey(record.idempotencyKey)) return false;
    this.records.set(record.id, record);
    return true;
  }

  async save(record: WeComDeliveryRecord): Promise<void> {
    this.records.set(record.id, record);
  }
}

const terminalEvent = {
  eventId: 'event-1', platformSessionId: 'session-1', workspaceId: 'workspace-1', workspaceName: 'MES 项目',
  runtimeKind: 'codex' as const, eventType: 'session.completed' as const, occurredAt: '2026-11-09T01:02:03Z', title: '完成设备筛选',
};

test('桌面通知服务只发送策略命中的终态目标并持久化幂等结果', async () => {
  const deliveries = new MemoryWeComDeliveries();
  let sends = 0;
  const service = new WeComDesktopNotificationService({
    listTargets: () => [target()],
    credentials: { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    deliveries,
    transport: async () => { sends++; return Response.json({ errcode: 0 }); },
    senderOptions: { minIntervalMs: 0 },
    now: () => new Date('2026-11-09T01:02:03Z'),
    createId: (() => { let value = 0; return () => `delivery-${++value}`; })(),
  });

  const first = await service.notifyTerminal(terminalEvent);
  const duplicate = await service.notifyTerminal(terminalEvent);
  assert.equal(first[0].status, 'sent');
  assert.equal(duplicate[0].status, 'skipped');
  assert.equal(duplicate[0].reason, 'already_recorded');
  assert.equal(sends, 1);
  assert.equal(deliveries.records.size, 1);
  assert.equal([...deliveries.records.values()][0].status, 'sent');
  assert.equal(JSON.stringify([...deliveries.records.values()]).includes('secret-key'), false);

  const secondTerminalEvent = { ...terminalEvent, eventId: 'event-2', occurredAt: '2026-11-09T01:04:03Z' };
  assert.equal((await service.notifyTerminal(secondTerminalEvent))[0].status, 'sent');
  assert.equal(sends, 2, '同一会话后续同类型的独立终态事件不应被永久去重');
});

test('应用启动恢复将遗留 sending 记录转为可人工重试失败且不自动重发', async () => {
  const deliveries = new MemoryWeComDeliveries();
  const interrupted: WeComDeliveryRecord = {
    id: 'interrupted-delivery', idempotencyKey: 'event-interrupted:team', kind: 'terminal', status: 'sending',
    eventId: 'event-interrupted', platformSessionId: 'session-interrupted', eventType: 'session.completed',
    targetId: 'team', targetName: '研发群', targetSnapshot: target(), content: '任务已完成', attempts: 1,
    createdAt: '2026-11-09T01:00:00.000Z', updatedAt: '2026-11-09T01:00:00.000Z',
  };
  deliveries.records.set(interrupted.id, interrupted);
  let sends = 0;
  const service = new WeComDesktopNotificationService({
    listTargets: () => [target()],
    credentials: { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    deliveries,
    transport: async () => { sends++; return Response.json({ errcode: 0 }); },
    senderOptions: { minIntervalMs: 0 },
    now: () => new Date('2026-11-10T01:00:00.000Z'),
  });

  assert.equal(await service.recoverInterruptedDeliveries(), 1);
  const recovered = deliveries.records.get(interrupted.id)!;
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.errorCode, 'DELIVERY_INTERRUPTED');
  assert.match(recovered.errorSummary!, /手动重试/);
  assert.equal(sends, 0);
  assert.equal((await service.retry(interrupted.id)).status, 'sent');
  assert.equal(sends, 1);
});

test('桌面通知服务只记录失败摘要，手动重试创建关联的新记录', async () => {
  const deliveries = new MemoryWeComDeliveries();
  let sends = 0;
  let mentionIds = ['employee-1'];
  const service = new WeComDesktopNotificationService({
    listTargets: () => [target({ mentionedUserIds: mentionIds })],
    credentials: { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    deliveries,
    transport: async (_url, init) => {
      sends++;
      const body = JSON.parse(String(init.body));
      if (body.text.mentioned_list) return Response.json({ errcode: 93009, errmsg: 'private webhook key=secret-key' });
      return Response.json({ errcode: 0 });
    },
    senderOptions: { minIntervalMs: 0 },
    now: () => new Date('2026-11-09T01:02:03Z'),
    createId: (() => { let value = 0; return () => `delivery-${++value}`; })(),
  });

  const failed = await service.notifyTerminal(terminalEvent);
  const original = failed[0].record!;
  assert.equal(failed[0].status, 'failed');
  assert.equal(original.errorCode, 'MENTION_INVALID');
  assert.doesNotMatch(JSON.stringify(original), /secret-key|private webhook/);
  mentionIds = [];
  const retried = await service.retry(original.id);
  assert.equal(retried.status, 'sent');
  assert.equal(retried.record?.kind, 'manual_retry');
  assert.equal(retried.record?.retryOfId, original.id);
  assert.equal(deliveries.records.size, 2);
  assert.equal(sends, 2);
});

test('Webhook 测试消息明确标记测试且不会 @ 群成员', async () => {
  const deliveries = new MemoryWeComDeliveries();
  let payload: any;
  const service = new WeComDesktopNotificationService({
    listTargets: () => [target({ mentionedUserIds: ['employee-1'] })],
    credentials: { getSecret: async () => 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret-key' },
    deliveries,
    transport: async (_url, init) => { payload = JSON.parse(String(init.body)); return Response.json({ errcode: 0 }); },
    senderOptions: { minIntervalMs: 0 },
    now: () => new Date('2026-11-09T01:02:03Z'),
    createId: () => 'test-delivery',
  });
  const outcome = await service.sendTest('team');
  assert.equal(outcome.status, 'sent');
  assert.match(payload.text.content, /测试通知/);
  assert.equal(payload.text.mentioned_list, undefined);
});

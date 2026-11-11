import {
  createWeComIdempotencyKey,
  renderWeComMessage,
  resolveWeComTargets,
  WeComNotificationSender,
  WeComWebhookAdapter,
  type WeComCredentialReader,
  type WeComDeliveryError,
  type WeComErrorCode,
  type WeComNotificationTarget,
  type WeComRetryOptions,
  type WeComSendResult,
  type WeComTargetPrecedence,
  type WeComTerminalEvent,
  type WeComTransport,
} from './index';

export type WeComDeliveryKind = 'terminal' | 'test' | 'manual_retry';
export type WeComDeliveryStatus = 'sending' | 'sent' | 'failed';

/** 只包含可审计摘要和目标元数据；不得包含 Webhook URL 或凭据明文。 */
export interface WeComDeliveryRecord {
  id: string;
  idempotencyKey: string;
  kind: WeComDeliveryKind;
  status: WeComDeliveryStatus;
  eventId?: string;
  platformSessionId?: string;
  eventType?: WeComTerminalEvent['eventType'];
  targetId: string;
  targetName: string;
  /** 用于手动重试的非敏感配置快照，credentialRef 仅为凭据名称。 */
  targetSnapshot: WeComNotificationTarget;
  /** 已脱敏、限长的消息正文，用于历史展示和手动重试。 */
  content: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  httpStatus?: number;
  errcode?: number;
  errorCode?: WeComErrorCode;
  errorSummary?: string;
  retryOfId?: string;
}

/** 存储实现应保证同一 idempotencyKey 的首次 reserve 操作具备唯一性。 */
export interface WeComDeliveryRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<WeComDeliveryRecord | undefined>;
  findById(id: string): Promise<WeComDeliveryRecord | undefined>;
  /** 可选：启动恢复时读取仍处于发送中的记录。老的内存/外部实现可暂不提供。 */
  listByStatus?(status: WeComDeliveryStatus): Promise<readonly WeComDeliveryRecord[]>;
  /** 插入新记录时按 idempotencyKey 原子去重；已有记录时返回 false。 */
  insertIfAbsent(record: WeComDeliveryRecord): Promise<boolean>;
  save(record: WeComDeliveryRecord): Promise<void>;
}

export interface WeComDesktopNotificationOptions {
  listTargets(): Promise<readonly WeComNotificationTarget[]> | readonly WeComNotificationTarget[];
  credentials: WeComCredentialReader;
  deliveries: WeComDeliveryRepository;
  transport?: WeComTransport;
  senderOptions?: WeComRetryOptions;
  now?: () => Date;
  createId?: () => string;
  /** 如未提供，所有启用目标作为 Runtime/全局默认目标。 */
  resolvePrecedence?: (event: WeComTerminalEvent, targets: readonly WeComNotificationTarget[]) => WeComTargetPrecedence;
}

export interface WeComDeliveryOutcome {
  targetId: string;
  status: 'sent' | 'failed' | 'skipped';
  reason?: 'already_recorded' | 'disabled' | 'not_found' | 'not_retryable' | 'storage_error';
  record?: WeComDeliveryRecord;
}

function safeStoredText(value: string, limit = 320): string {
  return value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已脱敏]')
    .replace(/\bkey\s*=\s*[^&\s,;]+/gi, 'key=[已脱敏]')
    .replace(/Bearer\s+[^\s,;"'<>]+/gi, 'Bearer [已脱敏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[已脱敏]')
    .replace(/(https?:\/\/[^\s?]+\?[^\s#]*\bkey=)[^&\s]+/gi, '$1[已脱敏]')
    .replace(/\b[A-Za-z]:\\[^\r\n]*/g, '[本机路径已省略]')
    .replace(/\\\\[^\\\s]+\\[^\\\s]+(?:\\[^\\\s]+)*/g, '[本机路径已省略]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function cloneTarget(target: WeComNotificationTarget): WeComNotificationTarget {
  return {
    id: target.id,
    name: safeStoredText(target.name, 120) || '未命名通知目标',
    purpose: target.purpose,
    credentialRef: /^wecom\.webhook\.[A-Za-z0-9._-]{1,120}$/.test(target.credentialRef) ? target.credentialRef : 'invalid-reference',
    enabled: target.enabled,
    eventPolicy: { ...target.eventPolicy },
    ...(target.mentionedUserIds ? { mentionedUserIds: [...target.mentionedUserIds] } : {}),
    ...(target.mentionedMobiles ? { mentionedMobiles: [...target.mentionedMobiles] } : {}),
    ...(target.workspaceIds ? { workspaceIds: [...target.workspaceIds] } : {}),
    ...(target.runtimeKinds ? { runtimeKinds: [...target.runtimeKinds] } : {}),
  };
}

/**
 * 主进程调用的通知编排器。只接收平台终态事件；不依赖 Electron，也不改变会话运行结果。
 * 网络、凭据和持久化都通过依赖注入，便于单元测试和桌面主进程接入。
 */
export class WeComDesktopNotificationService {
  private readonly sender: WeComNotificationSender;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly inFlight = new Map<string, Promise<WeComDeliveryOutcome>>();

  constructor(private readonly options: WeComDesktopNotificationOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    const adapter = new WeComWebhookAdapter(options.credentials, options.transport, undefined, () => this.now().getTime());
    this.sender = new WeComNotificationSender(adapter, options.senderOptions);
  }

  /** 按目标优先级解析并发送单次 Session 终态；相同幂等键不会重复自动发送。 */
  async notifyTerminal(event: WeComTerminalEvent, precedence?: WeComTargetPrecedence): Promise<WeComDeliveryOutcome[]> {
    let targets: readonly WeComNotificationTarget[];
    try {
      targets = await this.options.listTargets();
    } catch {
      return [{ targetId: '', status: 'failed', reason: 'storage_error' }];
    }
    const resolvedPrecedence = precedence ?? this.options.resolvePrecedence?.(event, targets) ?? {
      defaultTargetIds: targets.map(target => target.id),
    };
    const selected = resolveWeComTargets(event, targets, resolvedPrecedence);
    const content = renderWeComMessage(event);
    return Promise.all(selected.map(async target => {
      try { return await this.sendTerminalTarget(event, target, content); }
      catch { return { targetId: target.id, status: 'failed' as const, reason: 'storage_error' as const }; }
    }));
  }

  /** 对已配置的单个目标发送明确标记为测试的文本，并记录测试结果。 */
  async sendTest(targetId: string): Promise<WeComDeliveryOutcome> {
    let targets: readonly WeComNotificationTarget[];
    try { targets = await this.options.listTargets(); }
    catch { return { targetId, status: 'failed', reason: 'storage_error' }; }
    const target = targets.find(item => item.id === targetId);
    if (!target) return { targetId, status: 'skipped', reason: 'not_found' };
    if (!target.enabled) return { targetId, status: 'skipped', reason: 'disabled' };
    const timestamp = this.now().toISOString();
    const id = this.createId();
    const content = `【精工Agent测试通知】\n该消息用于验证企业微信群机器人 Webhook 连通性。\n发送时间：${timestamp}`;
    const testTarget = cloneTarget(target);
    // 测试消息不应意外 @ 真实群成员。
    delete testTarget.mentionedUserIds;
    delete testTarget.mentionedMobiles;
    const record = this.newRecord({
      id,
      idempotencyKey: `test:${id}:${target.id}`,
      kind: 'test',
      target: testTarget,
      content,
      createdAt: timestamp,
    });
    try { return await this.deliver(record); }
    catch { return { targetId, status: 'failed', reason: 'storage_error' }; }
  }

  /** 对单条失败记录发起独立的人工重试操作，原失败记录保留。 */
  async retry(deliveryId: string): Promise<WeComDeliveryOutcome> {
    let original: WeComDeliveryRecord | undefined;
    try { original = await this.options.deliveries.findById(deliveryId); }
    catch { return { targetId: '', status: 'failed', reason: 'storage_error' }; }
    if (!original) return { targetId: '', status: 'skipped', reason: 'not_found' };
    if (original.status !== 'failed') return { targetId: original.targetId, status: 'skipped', reason: 'not_retryable', record: original };
    let currentTarget: WeComNotificationTarget | undefined;
    try { currentTarget = (await this.options.listTargets()).find(item => item.id === original.targetId); }
    catch { return { targetId: original.targetId, status: 'failed', reason: 'storage_error' }; }
    if (currentTarget && !currentTarget.enabled) return { targetId: original.targetId, status: 'skipped', reason: 'disabled' };
    const timestamp = this.now().toISOString();
    const retryId = this.createId();
    const record = this.newRecord({
      id: retryId,
      idempotencyKey: `${original.idempotencyKey}:retry:${retryId}`,
      kind: 'manual_retry',
      eventId: original.eventId,
      platformSessionId: original.platformSessionId,
      eventType: original.eventType,
      target: cloneTarget(currentTarget ?? original.targetSnapshot),
      content: original.content,
      createdAt: timestamp,
      retryOfId: original.id,
    });
    try { return await this.deliver(record, false); }
    catch { return { targetId: original.targetId, status: 'failed', reason: 'storage_error' }; }
  }

  /**
   * 将上次进程退出时未完成的记录转为可人工重试的失败记录。
   *
   * 发送请求可能已经到达企业微信但结果尚未写回本地，因此这里不自动重发，
   * 由用户确认目标群后再点击“重试”，避免应用重启造成重复通知。
   */
  async recoverInterruptedDeliveries(): Promise<number> {
    const listByStatus = this.options.deliveries.listByStatus;
    if (!listByStatus) return 0;
    let records: readonly WeComDeliveryRecord[];
    try { records = await listByStatus.call(this.options.deliveries, 'sending'); }
    catch { return 0; }
    let recovered = 0;
    const timestamp = this.now().toISOString();
    for (const record of records) {
      if (record.status !== 'sending') continue;
      try {
        await this.options.deliveries.save({
          ...record,
          status: 'failed',
          updatedAt: timestamp,
          errorCode: 'DELIVERY_INTERRUPTED',
          errorSummary: '应用重启后未能确认通知结果，请确认目标群后手动重试。',
        });
        recovered++;
      } catch {
        // 单条恢复失败不应阻断应用启动；记录仍会在下次启动再次检查。
      }
    }
    return recovered;
  }

  private async sendTerminalTarget(event: WeComTerminalEvent, target: WeComNotificationTarget, content: string): Promise<WeComDeliveryOutcome> {
    const idempotencyKey = createWeComIdempotencyKey(event.eventId, target.id);
    const running = this.inFlight.get(idempotencyKey);
    if (running) return running;
    const operation = this.deliverTerminalOnce(event, target, content, idempotencyKey);
    this.inFlight.set(idempotencyKey, operation);
    try { return await operation; }
    finally { if (this.inFlight.get(idempotencyKey) === operation) this.inFlight.delete(idempotencyKey); }
  }

  private async deliverTerminalOnce(event: WeComTerminalEvent, target: WeComNotificationTarget, content: string, idempotencyKey: string): Promise<WeComDeliveryOutcome> {
    const previous = await this.options.deliveries.findByIdempotencyKey(idempotencyKey);
    if (previous) return { targetId: target.id, status: 'skipped', reason: 'already_recorded', record: previous };
    const timestamp = this.now().toISOString();
    const record = this.newRecord({
      id: this.createId(), idempotencyKey, kind: 'terminal', eventId: event.eventId,
      platformSessionId: event.platformSessionId, eventType: event.eventType,
      target, content, createdAt: timestamp,
    });
    return this.deliver(record);
  }

  private newRecord(input: {
    id: string;
    idempotencyKey: string;
    kind: WeComDeliveryKind;
    target: WeComNotificationTarget;
    content: string;
    createdAt: string;
    eventId?: string;
    platformSessionId?: string;
    eventType?: WeComTerminalEvent['eventType'];
    retryOfId?: string;
  }): WeComDeliveryRecord {
    return {
      ...input,
      targetId: input.target.id,
      targetName: safeStoredText(input.target.name, 120) || '未命名通知目标',
      targetSnapshot: cloneTarget(input.target),
      content: safeStoredText(input.content, 1800),
      status: 'sending',
      attempts: 0,
      updatedAt: input.createdAt,
    };
  }

  private async deliver(record: WeComDeliveryRecord, checkIdempotency = true): Promise<WeComDeliveryOutcome> {
    if (checkIdempotency) {
      const previous = await this.options.deliveries.findByIdempotencyKey(record.idempotencyKey);
      if (previous) return { targetId: record.targetId, status: 'skipped', reason: 'already_recorded', record: previous };
    }
    try {
      if (checkIdempotency) {
        const inserted = await this.options.deliveries.insertIfAbsent(record);
        if (!inserted) {
          const previous = await this.options.deliveries.findByIdempotencyKey(record.idempotencyKey);
          return { targetId: record.targetId, status: 'skipped', reason: 'already_recorded', record: previous };
        }
      } else {
        await this.options.deliveries.save(record);
      }
    } catch {
      return { targetId: record.targetId, status: 'failed', record: { ...record, status: 'failed', errorSummary: '通知记录保存失败，未发送' } };
    }

    let result: WeComSendResult;
    try {
      result = await this.sender.send(record.targetSnapshot, record.content);
    } catch (error) {
      const safeError = error as Partial<WeComDeliveryError>;
      result = {
        ok: false,
        code: 'REMOTE_REJECTED',
        retryable: false,
        attempts: 1,
        errorSummary: safeStoredText(typeof safeError.message === 'string' ? safeError.message : '通知发送失败'),
      };
    }
    const updated: WeComDeliveryRecord = {
      ...record,
      status: result.ok ? 'sent' : 'failed',
      attempts: result.attempts,
      updatedAt: this.now().toISOString(),
      ...(result.ok ? { httpStatus: result.httpStatus, errcode: result.errcode } : {
        errorCode: result.code,
        errorSummary: safeStoredText(result.errorSummary),
        ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(result.errcode === undefined ? {} : { errcode: result.errcode }),
      }),
    };
    try {
      await this.options.deliveries.save(updated);
    } catch {
      return { targetId: record.targetId, status: result.ok ? 'sent' : 'failed', record: { ...updated, errorSummary: result.ok ? undefined : updated.errorSummary } };
    }
    return { targetId: record.targetId, status: updated.status === 'sent' ? 'sent' : 'failed', record: updated };
  }
}

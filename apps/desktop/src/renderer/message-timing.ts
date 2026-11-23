import type { AgentEvent } from '../../../../packages/domain/src';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const QUEUED_TURN_PREFIX = 'queued-turn:';
const STEERED_TURN_PREFIX = 'steered-turn:';

export function formatClockTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
}

export function formatLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分钟${remainingSeconds}秒`;
  if (minutes > 0) return `${minutes}分钟${remainingSeconds}秒`;
  return `${remainingSeconds}秒`;
}

/** 按 Runtime 的 running/terminal 事件计算本轮耗时，并关联到终态前最后一条助手输出。 */
export function assistantMessageDurations(events: readonly AgentEvent[]): Map<string, number> {
  const durations = new Map<string, number>();
  let pendingUserAt: number | undefined;
  let active: { startedAt: number; lastAssistantId?: string } | undefined;

  for (const event of events) {
    const createdAt = Date.parse(event.createdAt);
    if (!Number.isFinite(createdAt)) continue;

    if (event.type === 'user') {
      if (typeof event.requestId !== 'string' || (!event.requestId.startsWith(QUEUED_TURN_PREFIX) && !event.requestId.startsWith(STEERED_TURN_PREFIX))) {
        pendingUserAt = createdAt;
      }
      continue;
    }

    if (event.type === 'status' && event.text === '开始执行排队补充任务。') {
      pendingUserAt = createdAt;
      continue;
    }

    if (event.type === 'status' && event.text === 'running') {
      if (!active) active = { startedAt: pendingUserAt ?? createdAt };
      pendingUserAt = undefined;
      continue;
    }

    if (event.type === 'status' && TERMINAL_STATUSES.has(event.text)) {
      if (active?.lastAssistantId) durations.set(active.lastAssistantId, Math.max(0, createdAt - active.startedAt));
      active = undefined;
      pendingUserAt = undefined;
      continue;
    }

    if (event.type === 'message' || event.type === 'delta' || event.type === 'error') {
      if (!active && pendingUserAt !== undefined) active = { startedAt: pendingUserAt };
      if (active) active.lastAssistantId = event.id;
    }
  }

  return durations;
}

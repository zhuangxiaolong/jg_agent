import type { AgentEvent } from '../../../../packages/domain/src';
import { compactAgentEvent, compactToolEvent, engineText, toolPlatformText } from './branding';

const statusLabels: Record<string, string> = {
  idle: '就绪',
  running: '运行中',
  'waiting-approval': '等待确认',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

export interface RunningIndicatorDetail {
  id: string;
  type: 'tool' | 'status' | 'error' | 'response';
  text: string;
  createdAt: string;
}

function responseSummary(value: string): string {
  const response = value.replace(/\s+/g, ' ').trim();
  return response ? `回复进展：${response.length > 240 ? `…${response.slice(-239)}` : response}` : '';
}

/** 主时间线保持简洁，运行指示器单独保留本轮最近的可读进度。 */
export function runningIndicatorDetails(events: AgentEvent[], limit = 5): RunningIndicatorDetail[] {
  if (limit <= 0) return [];
  const details: RunningIndicatorDetail[] = [];
  const seen = new Set<string>();
  for (let index = events.length - 1; index >= 0 && details.length < limit; index -= 1) {
    const event = events[index];
    if (event.type === 'user' || (event.type === 'status' && ['completed', 'failed', 'interrupted'].includes(event.text))) break;
    if (event.type === 'delta') {
      const chunks = [event.text];
      let length = event.text.length;
      let first = index;
      while (first > 0 && events[first - 1].type === 'delta' && events[first - 1].sessionId === event.sessionId) {
        first -= 1;
        if (length < 480) chunks.push(events[first].text);
        length += events[first].text.length;
      }
      const text = responseSummary(chunks.reverse().join(''));
      if (text && !seen.has(text)) {
        seen.add(text);
        details.push({ id: `response-${events[first].id}-${event.id}`, type: 'response', text, createdAt: event.createdAt });
      }
      index = first;
      continue;
    }
    if (event.type !== 'tool' && event.type !== 'status' && event.type !== 'error' && event.type !== 'message') continue;
    if (event.type === 'message' && /^### (?:代码变更(?:已)?核验|构建、测试与报告核验)/.test(event.text.trim())) continue;
    // “运行中/已完成”等生命周期状态已经在会话顶部显示，避免重复占用最新进度。
    if (event.type === 'status' && event.text in statusLabels && event.text !== 'waiting-approval') continue;
    const compact = event.type === 'tool' && /^(?:执行命令|命令执行完成|已执行项目文件工具|已执行字典工具|已拒绝项目或字典访问)：?/.test(event.text)
      ? /^执行命令：/.test(event.text) ? `正在执行：${event.text.slice('执行命令：'.length).replace(/\s+/g, ' ').trim().slice(0, 180)}` : compactToolEvent(event.text)
      : compactAgentEvent(event);
    if (!compact) continue;
    const text = event.type === 'tool'
      ? toolPlatformText(compact)
      : event.type === 'error'
        ? `运行错误：${engineText(compact)}`
        : event.type === 'message' ? responseSummary(compact) : engineText(statusLabels[compact] ?? compact);
    const normalized = text.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    details.push({ id: event.id, type: event.type === 'message' ? 'response' : event.type, text: normalized, createdAt: event.createdAt });
  }
  return details.reverse();
}

export function latestRunningIndicator(events: AgentEvent[]): string {
  return runningIndicatorDetails(events, 1)[0]?.text ?? '正在准备运行环境…';
}

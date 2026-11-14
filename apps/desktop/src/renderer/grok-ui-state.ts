import type { AgentEvent, ProviderProfile, RuntimeKind, SettingsSnapshot } from '../../../../packages/domain/src';
import { isGrokModel } from '../../../../packages/domain/src/runtime-compatibility';

export interface SessionProviderChoice { id: string; name: string; baseUrl: string; hasKey: boolean; enabled: boolean; models: Array<{ id: string; name: string; enabled: boolean; backend?: string; unavailableReason?: 'claude-grok' }> }

/** 所有 Runtime 共用模型中转站；Grok 只补充逐模型协议，不维护第二份凭据。 */
export function sessionProviderChoices(settings: SettingsSnapshot | undefined, runtimeKind: RuntimeKind): SessionProviderChoice[] {
  return (settings?.providers ?? []).map((provider: ProviderProfile) => {
    const grok = runtimeKind === 'grok_build_acp' ? settings?.grok?.providers.find(item => item.id === provider.id) : undefined;
    return { ...provider, enabled: true, models: provider.models.map(id => {
      const claudeGrok = runtimeKind === 'claude_agent_sdk' && isGrokModel(provider, id);
      return { id, name: provider.modelCatalog?.find(model => model.id === id)?.name || id, enabled: !claudeGrok, ...(claudeGrok ? { unavailableReason: 'claude-grok' as const } : {}), ...(runtimeKind === 'grok_build_acp' ? { backend: grok?.models.find(model => model.id === id)?.apiBackend || 'chat_completions' } : {}) };
    }) };
  });
}

/** 只展示当前进程活动会话内、尚未被后续决策覆盖的审批请求。 */
export function pendingRuntimeApprovals(events: AgentEvent[], sessionId: string, active: boolean): AgentEvent[] {
  if (!active || !sessionId) return [];
  const latest = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.sessionId !== sessionId || event.type !== 'approval' || !event.approval?.requestId) continue;
    const previous = latest.get(event.approval.requestId);
    if (previous?.approval?.state !== undefined && previous.approval.state !== 'pending') continue;
    latest.set(event.approval.requestId, event);
  }
  return [...latest.values()].filter(event => event.approval?.state === 'pending');
}

export function grokCompatibilityLabel(result?: { status: 'passed' | 'failed'; level: 'untested' | 'text' | 'agent' }): string {
  if (!result) return '未验证';
  if (result.status === 'failed') return '验证未通过';
  return result.level === 'agent' ? 'Agent 兼容已验证' : result.level === 'text' ? '仅文本连通已验证' : '未验证';
}

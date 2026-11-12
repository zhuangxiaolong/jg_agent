import type { RuntimeKind } from '../../domain/src';

export type RuntimeCapabilityName = 'native_subagents' | 'independent_agent_context' | 'pause_resume' | 'session_recovery' | 'token_usage' | 'cost_usage' | 'tool_permission_interception' | 'worktree_support' | 'event_stream' | 'structured_result' | 'model_request_interception';
export interface RuntimeGovernanceCapability { readonly supported: boolean | 'partial'; readonly enforcementLayer: 'platform' | 'runtime' | 'adapter' | 'none'; readonly notes: string }
export type RuntimeGovernanceCapabilities = Readonly<Record<RuntimeCapabilityName, RuntimeGovernanceCapability>>;
function capability(supported: boolean | 'partial', enforcementLayer: RuntimeGovernanceCapability['enforcementLayer'], notes: string): RuntimeGovernanceCapability { return Object.freeze({ supported, enforcementLayer, notes }); }

/** 依据当前适配器已接入的协议声明能力，不把上游产品能力当成本平台能力。 */
export function runtimeCapabilityMatrix(kind: RuntimeKind): RuntimeGovernanceCapabilities {
  if (!['codex', 'jinggong', 'claude_agent_sdk'].includes(kind)) throw new GovernanceError('unsupported_runtime');
  const claude = kind === 'claude_agent_sdk';
  return Object.freeze({
    native_subagents: capability(false, 'none', '当前未接入 Runtime 原生子代理；Codex/jinggong 原生多代理功能已关闭。'),
    independent_agent_context: capability(true, 'platform', '平台为每个任务创建独立 Runtime 会话，上下文由平台编排。'),
    pause_resume: capability(false, 'none', '当前只有取消/中断；不支持保存执行栈后继续，不会自动重放工具调用。'),
    session_recovery: capability('partial', 'adapter', claude ? '依赖已持久化 native session ID 及 SDK resume；不恢复在途工具执行。' : '支持 thread/resume 恢复会话上下文；不恢复在途工具执行。'),
    token_usage: capability(false, 'none', '当前适配器未归一化并持久化权威 token usage；缺失值保持 unknown。'),
    cost_usage: capability(false, 'none', '当前未采集可审计实际费用；不依据 token 或固定单价伪造费用。'),
    tool_permission_interception: capability('partial', 'platform', claude ? 'SDK 普通工具自动执行，尚未接入逐工具契约网关；无法声明全部原生工具已受控。' : '平台动态工具网关及原生 command/fileChange 请求校验覆盖部分路径；不覆盖全部原生工具。'),
    worktree_support: capability(true, 'platform', '隔离 Git worktree 由平台创建和绑定；不是 Runtime 原生隔离声明。'),
    event_stream: capability(true, 'adapter', '适配器提供消息、工具摘要和终态事件；摘要不是权威工具调用计数。'),
    structured_result: capability('partial', 'adapter', '目前仅有终态及平台结果封装，不保证模型输出符合业务结构化 Schema。'),
    model_request_interception: capability(false, 'none', '平台可统计启动的 turn，不能拦截 Runtime 内部每个模型请求或内部重试。'),
  });
}

export class GovernanceError extends Error {
  constructor(readonly code: string) { super(`任务治理拒绝：${code}`); this.name = 'GovernanceError'; }
}

/** 自动规划与执行共用同一能力声明，能力不足时不创建注定阻塞的任务。 */
export function automaticAgentTaskAvailability(kind: RuntimeKind): { available: boolean; reason?: string } {
  if (kind === 'claude_agent_sdk') return { available: false, reason: 'Claude Agent SDK Runtime 尚未接入受控分析子 Agent。' };
  const matrix = runtimeCapabilityMatrix(kind);
  const missing: string[] = [];
  if (matrix.tool_permission_interception.supported !== true) missing.push('完整工具权限拦截');
  if (matrix.model_request_interception.supported !== true) missing.push('模型请求限额');
  return missing.length
    ? { available: false, reason: `当前 Runtime 尚未接入${missing.join('和')}，自动子 Agent 暂不可用；主会话可以正常执行。` }
    : { available: true };
}

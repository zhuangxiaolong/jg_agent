import type { RuntimeKind } from '../../domain/src';

export type RuntimeCapabilityName = 'native_subagents' | 'independent_agent_context' | 'pause_resume' | 'session_recovery' | 'token_usage' | 'cost_usage' | 'tool_permission_interception' | 'worktree_support' | 'event_stream' | 'structured_result' | 'model_request_interception';
export interface RuntimeGovernanceCapability { readonly supported: boolean | 'partial'; readonly enforcementLayer: 'platform' | 'runtime' | 'adapter' | 'none'; readonly notes: string }
export type RuntimeGovernanceCapabilities = Readonly<Record<RuntimeCapabilityName, RuntimeGovernanceCapability>>;
function capability(supported: boolean | 'partial', enforcementLayer: RuntimeGovernanceCapability['enforcementLayer'], notes: string): RuntimeGovernanceCapability { return Object.freeze({ supported, enforcementLayer, notes }); }

/** 依据当前适配器已接入的协议声明能力，不把上游产品能力当成本平台能力。 */
export function runtimeCapabilityMatrix(kind: RuntimeKind, executionMode: 'native' | 'controlled_analysis' = 'native'): RuntimeGovernanceCapabilities {
  if (!['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp'].includes(kind)) throw new GovernanceError('unsupported_runtime');
  const claude = kind === 'claude_agent_sdk';
  const grok = kind === 'grok_build_acp';
  const controlled = executionMode === 'controlled_analysis' && !claude && !grok;
  return Object.freeze({
    native_subagents: capability(false, 'none', grok ? 'Grok Build ACP 未接入原生子代理；平台不会为 Grok 自动创建子 Agent。' : '当前未接入 Runtime 原生子代理；Codex/jinggong 原生多代理功能已关闭。'),
    independent_agent_context: capability(true, 'platform', '平台为每个任务创建独立 Runtime 会话，上下文由平台编排。'),
    pause_resume: capability(false, 'none', '当前只有取消/中断；不支持保存执行栈后继续，不会自动重放工具调用。'),
    session_recovery: capability(controlled || grok ? false : 'partial', 'adapter', grok ? 'Grok ACP 仅恢复受管 session 绑定，不恢复在途工具执行。' : controlled ? '受控分析请求循环不恢复在途请求；中断后保留审计，由平台决定是否重试。' : claude ? '依赖已持久化 native session ID 及 SDK resume；不恢复在途工具执行。' : '支持 thread/resume 恢复会话上下文；不恢复在途工具执行。'),
    token_usage: capability(false, 'none', '当前适配器未归一化并持久化权威 token usage；缺失值保持 unknown。'),
    cost_usage: capability(false, 'none', '当前未采集可审计实际费用；不依据 token 或固定单价伪造费用。'),
    tool_permission_interception: capability(grok ? false : controlled ? true : 'partial', grok ? 'none' : 'platform', grok ? 'Grok 完整访问模式直接执行文件和命令，不逐次审批，也不限制工作区外路径；遵循当前系统用户权限。' : controlled ? '受控分析仅暴露项目与字典只读工具，全部经契约网关，不提供原生命令、写入、插件或外部工具。' : claude ? 'SDK 普通会话默认完整文件读写与命令访问，按当前系统用户权限直接执行；平台工具网关不覆盖全部原生工具。' : 'Codex/精工普通会话默认完整文件读写与命令访问，不逐次审批；平台动态工具网关及请求归属校验不构成工作区外访问限制。'),
    worktree_support: capability(true, 'platform', '隔离 Git worktree 由平台创建和绑定；不是 Runtime 原生隔离声明。'),
    event_stream: capability(true, 'adapter', '适配器提供消息、工具摘要和终态事件；摘要不是权威工具调用计数。'),
    structured_result: capability('partial', 'adapter', '目前仅有终态及平台结果封装，不保证模型输出符合业务结构化 Schema。'),
    model_request_interception: capability(controlled, controlled ? 'platform' : 'none', grok ? '平台不能拦截 Grok ACP 内部每个模型请求；文本/Agent 兼容性必须按中转站、模型和 backend 实测。' : controlled ? '受控分析的每次 HTTP 请求前由平台预留请求预算，适配器不自动重试，超限不发送。' : '平台可统计启动的 turn，不能拦截 Runtime 内部每个模型请求或内部重试。'),
  });
}

export class GovernanceError extends Error {
  constructor(readonly code: string) { super(`任务治理拒绝：${code}`); this.name = 'GovernanceError'; }
}

/** 自动规划与执行共用同一能力声明，能力不足时不创建注定阻塞的任务。 */
export function automaticAgentTaskAvailability(kind: RuntimeKind): { available: boolean; reason?: string } {
  if (kind === 'claude_agent_sdk') return { available: false, reason: 'Claude Agent SDK Runtime 尚未接入受控分析子 Agent。' };
  if (kind === 'grok_build_acp') return { available: false, reason: 'Grok Build ACP 暂不支持平台受控子 Agent；请在主会话中执行任务。' };
  const matrix = runtimeCapabilityMatrix(kind, 'controlled_analysis');
  const missing: string[] = [];
  if (matrix.tool_permission_interception.supported !== true) missing.push('完整工具权限拦截');
  if (matrix.model_request_interception.supported !== true) missing.push('模型请求限额');
  return missing.length
    ? { available: false, reason: `当前 Runtime 尚未接入${missing.join('和')}，自动子 Agent 暂不可用；主会话可以正常执行。` }
    : { available: true };
}

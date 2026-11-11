import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RuntimeKind, TaskBudgetPolicy, TaskContract, TaskPermission } from '../../domain/src';
import { taskContentHash } from './engineering';

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
    tool_permission_interception: capability('partial', 'platform', claude ? 'SDK canUseTool 有权限回调，但尚未接入逐工具契约网关；无法声明全部原生工具已受控。' : '平台动态工具网关及原生 command/fileChange 审批可控制部分路径；不覆盖全部原生工具。'),
    worktree_support: capability(true, 'platform', '隔离 Git worktree 由平台创建和绑定；不是 Runtime 原生隔离声明。'),
    event_stream: capability(true, 'adapter', '适配器提供消息、工具摘要和终态事件；摘要不是权威工具调用计数。'),
    structured_result: capability('partial', 'adapter', '目前仅有终态及平台结果封装，不保证模型输出符合业务结构化 Schema。'),
    model_request_interception: capability(false, 'none', '平台可统计启动的 turn，不能拦截 Runtime 内部每个模型请求或内部重试。'),
  });
}

export class GovernanceError extends Error {
  constructor(readonly code: string) { super(`任务治理拒绝：${code}`); this.name = 'GovernanceError'; }
}
export interface RuntimeGovernanceRequirements { strictModelRequests?: boolean; strictTools?: boolean; strictTokenUsage?: boolean; strictCostUsage?: boolean }
export function assertRuntimeGovernance(kind: RuntimeKind, requirements: RuntimeGovernanceRequirements): void {
  const capabilities = runtimeCapabilityMatrix(kind);
  const checks: Array<[boolean | undefined, RuntimeCapabilityName]> = [[requirements.strictModelRequests, 'model_request_interception'], [requirements.strictTools, 'tool_permission_interception'], [requirements.strictTokenUsage, 'token_usage'], [requirements.strictCostUsage, 'cost_usage']];
  for (const [strict, key] of checks) if (strict && capabilities[key].supported !== true) throw new GovernanceError(`unsupported_strict_${key}`);
}

export type BudgetSource = 'project' | 'parent' | 'task';
export type BudgetLimit = Exclude<keyof TaskBudgetPolicy, 'currency'>;
export interface ResolvedTaskBudget { readonly policy: Readonly<TaskBudgetPolicy>; readonly sources: Readonly<Partial<Record<BudgetLimit, readonly BudgetSource[]>>> }
const BUDGET_LIMITS: readonly BudgetLimit[] = ['maxConcurrentAgents', 'maxAgentDepth', 'maxTotalAgentsPerTask', 'maxRuntimeMinutes', 'maxModelRequests', 'maxToolCalls', 'maxRetriesPerTask', 'maxInputTokens', 'maxOutputTokens', 'maxCostAmount'];
export function resolveTaskBudgetPolicy(input: { project?: Partial<TaskBudgetPolicy>; parent?: Partial<TaskBudgetPolicy>; task: TaskBudgetPolicy }): ResolvedTaskBudget {
  const layers = (['project', 'parent', 'task'] as const).map(source => ({ source, policy: input[source] }));
  const policy = { ...input.task };
  const sources: Partial<Record<BudgetLimit, readonly BudgetSource[]>> = {};
  for (const key of BUDGET_LIMITS) {
    const values = layers.flatMap(({ source, policy }) => policy?.[key] === undefined ? [] : [{ source, value: policy[key]! }]);
    if (values.some(({ value }) => !Number.isFinite(value) || value < 0 || key !== 'maxCostAmount' && !Number.isSafeInteger(value))) throw new GovernanceError('invalid_budget');
    if (!values.length) continue;
    if (key === 'maxCostAmount') {
      const currencies = layers.filter(item => item.policy?.maxCostAmount !== undefined).map(item => item.policy?.currency);
      if (currencies.some(currency => !currency || !/^[A-Z]{3}$/.test(currency)) || new Set(currencies).size !== 1) throw new GovernanceError('budget_currency_mismatch');
      policy.currency = currencies[0];
    }
    const minimum = Math.min(...values.map(item => item.value));
    policy[key] = minimum;
    sources[key] = Object.freeze(values.filter(item => item.value === minimum).map(item => item.source));
  }
  return Object.freeze({ policy: Object.freeze(policy), sources: Object.freeze(sources) });
}

export interface TaskUsageCounters { readonly modelTurns: number; readonly toolCalls: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly costAmount?: number; readonly currency?: string }
export interface TaskBudgetSnapshot extends TaskUsageCounters { readonly elapsedMs: number; readonly tokenUsage: 'unknown' | 'reported'; readonly costUsage: 'unknown' | 'reported' }
export class TaskBudgetGuard {
  private counters: TaskUsageCounters;
  private readonly now: () => number;
  private readonly startedAt: number;
  constructor(readonly policy: Readonly<TaskBudgetPolicy>, options: { now?: () => number; startedAt?: number; initial?: Partial<TaskUsageCounters> } = {}) {
    this.now = options.now ?? Date.now; this.startedAt = options.startedAt ?? this.now();
    this.counters = { modelTurns: 0, toolCalls: 0, ...options.initial };
    this.validateCounters(this.counters);
  }
  private validateCounters(counters: TaskUsageCounters) { for (const key of ['modelTurns', 'toolCalls', 'inputTokens', 'outputTokens', 'costAmount'] as const) { const value = counters[key]; if (value !== undefined && (!Number.isFinite(value) || value < 0 || key !== 'costAmount' && !Number.isSafeInteger(value))) throw new GovernanceError('invalid_usage'); } }
  check(): void {
    const limits: Array<[string, number | undefined, number | undefined]> = [['elapsed', this.now() - this.startedAt, this.policy.maxRuntimeMinutes * 60000], ['model_turns', this.counters.modelTurns, this.policy.maxModelRequests], ['tool_calls', this.counters.toolCalls, this.policy.maxToolCalls], ['input_tokens', this.counters.inputTokens, this.policy.maxInputTokens], ['output_tokens', this.counters.outputTokens, this.policy.maxOutputTokens], ['cost', this.counters.costAmount, this.policy.maxCostAmount]];
    for (const [name, observed, limit] of limits) if (observed !== undefined && limit !== undefined && (name === 'elapsed' ? observed >= limit : observed > limit)) throw new GovernanceError(`budget_exceeded_${name}`);
    if (this.policy.maxCostAmount !== undefined && this.counters.costAmount !== undefined && this.counters.currency !== this.policy.currency) throw new GovernanceError('usage_currency_mismatch');
  }
  reserveModelTurn(): void { this.check(); if (this.counters.modelTurns >= this.policy.maxModelRequests) throw new GovernanceError('budget_exceeded_model_turns'); this.counters = { ...this.counters, modelTurns: this.counters.modelTurns + 1 }; }
  reserveToolCall(): void { this.check(); if (this.counters.toolCalls >= this.policy.maxToolCalls) throw new GovernanceError('budget_exceeded_tool_calls'); this.counters = { ...this.counters, toolCalls: this.counters.toolCalls + 1 }; }
  /** 仅接受真实采集的增量；不传值保持未知，不把缺失转换为零。 */
  recordUsage(usage: Partial<Pick<TaskUsageCounters, 'inputTokens' | 'outputTokens' | 'costAmount' | 'currency'>>): void {
    this.validateCounters({ modelTurns: 0, toolCalls: 0, ...usage });
    if (usage.costAmount !== undefined && (!usage.currency || !/^[A-Z]{3}$/.test(usage.currency) || this.counters.currency && usage.currency !== this.counters.currency)) throw new GovernanceError('usage_currency_mismatch');
    const next: { -readonly [Key in keyof TaskUsageCounters]: TaskUsageCounters[Key] } = { ...this.counters };
    for (const key of ['inputTokens', 'outputTokens', 'costAmount'] as const) if (usage[key] !== undefined) next[key] = (next[key] ?? 0) + usage[key]!;
    if (usage.currency) next.currency = usage.currency;
    this.counters = next; this.check();
  }
  snapshot(): TaskBudgetSnapshot { return Object.freeze({ ...this.counters, elapsedMs: Math.max(0, this.now() - this.startedAt), tokenUsage: this.counters.inputTokens === undefined || this.counters.outputTokens === undefined ? 'unknown' : 'reported', costUsage: this.counters.costAmount === undefined ? 'unknown' : 'reported' }); }
}

export interface RetryFailure { readonly retryable: boolean; readonly reason: 'rate_limit' | 'network' | 'timeout' | 'service_unavailable' | 'cancelled' | 'policy' | 'authentication' | 'unknown' }
export function classifyRetryFailure(error: unknown): RetryFailure {
  const item = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; message?: unknown; name?: unknown } : {};
  const code = String(item.code ?? ''); const message = String(item.message ?? ''); const status = Number(item.status);
  const result = (retryable: boolean, reason: RetryFailure['reason']) => Object.freeze({ retryable, reason });
  if (error instanceof GovernanceError || /permission|denied|policy|审批|权限/i.test(code + ' ' + message)) return result(false, 'policy');
  if (item.name === 'AbortError' || /cancelled|canceled|aborted/i.test(code)) return result(false, 'cancelled');
  if (status === 401 || status === 403 || /authentication|invalid_api_key/i.test(code)) return result(false, 'authentication');
  if (status === 429 || /rate_limit/i.test(code)) return result(true, 'rate_limit');
  if (status >= 500 && status <= 599) return result(true, 'service_unavailable');
  if (/ETIMEDOUT|TIMEOUT/i.test(code)) return result(true, 'timeout');
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EPIPE/i.test(code)) return result(true, 'network');
  return result(false, 'unknown');
}
export function retryPolicyDecision(input: { failure: RetryFailure; attempt: number; maxRetries: number; baseDelayMs?: number; maxDelayMs?: number; random?: () => number }): Readonly<{ retry: boolean; delayMs: number; reason: RetryFailure['reason'] }> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || !Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0) throw new GovernanceError('invalid_retry_policy');
  const retry = input.failure.retryable && input.attempt <= input.maxRetries;
  const ceiling = Math.min(input.maxDelayMs ?? 30000, (input.baseDelayMs ?? 500) * 2 ** Math.min(input.attempt - 1, 20));
  const random = Math.max(0, Math.min(1, (input.random ?? Math.random)()));
  return Object.freeze({ retry, delayMs: retry ? Math.round(ceiling * (0.5 + random * 0.5)) : 0, reason: input.failure.reason });
}
export class TaskCircuitBreaker {
  private failures = 0; private openedAt?: number; private probe = false;
  constructor(private readonly options: { threshold?: number; cooldownMs?: number; now?: () => number } = {}) {}
  private now() { return (this.options.now ?? Date.now)(); }
  assertCanExecute(): void {
    if (this.openedAt === undefined) return;
    if (this.now() - this.openedAt < (this.options.cooldownMs ?? 30000) || this.probe) throw new GovernanceError('circuit_open');
    this.probe = true;
  }
  recordSuccess(): void { this.failures = 0; this.openedAt = undefined; this.probe = false; }
  recordFailure(failure: RetryFailure): void { if (!failure.retryable) { this.probe = false; return; } this.failures += 1; if (this.probe || this.failures >= (this.options.threshold ?? 3)) this.openedAt = this.now(); this.probe = false; }
  snapshot() { return Object.freeze({ state: this.openedAt === undefined ? 'closed' : this.probe ? 'half_open' : 'open', failures: this.failures, ...(this.openedAt === undefined ? {} : { openedAt: this.openedAt }) }); }
}

export interface TaskApprovalScope { readonly taskId: string; readonly sessionId: string; readonly projectId?: string; readonly runtimeKind: RuntimeKind; readonly workspacePath: string; readonly toolName: string; readonly contractVersion: number }
export interface OneShotTaskApproval extends TaskApprovalScope { readonly id: string; readonly argumentsHash: string; readonly expiresAt: number }
function workspaceIdentity(value: string): string { const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(value); return windows ? path.win32.resolve(value).replace(/\\+$/, '').toLowerCase() : path.resolve(value); }
export function canonicalTaskArgumentsHash(value: unknown): string {
  const seen = new Set<object>();
  const check = (item: unknown, depth: number) => {
    if (depth > 64) throw new GovernanceError('invalid_tool_arguments');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || seen.has(item) || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new GovernanceError('invalid_tool_arguments');
    seen.add(item); for (const entry of Array.isArray(item) ? item : Object.values(item)) check(entry, depth + 1); seen.delete(item);
  };
  check(value, 0); return taskContentHash(value);
}
function normalizedScope(scope: TaskApprovalScope): TaskApprovalScope { return { taskId: scope.taskId, sessionId: scope.sessionId, projectId: scope.projectId, runtimeKind: scope.runtimeKind, workspacePath: workspaceIdentity(scope.workspacePath), toolName: scope.toolName, contractVersion: scope.contractVersion }; }
export class OneShotTaskApprovalBroker {
  private readonly grants = new Map<string, OneShotTaskApproval>();
  constructor(private readonly now: () => number = Date.now) {}
  grant(scope: TaskApprovalScope, args: unknown, expiresAt: number): OneShotTaskApproval {
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() || !Number.isSafeInteger(scope.contractVersion) || scope.contractVersion < 1) throw new GovernanceError('invalid_approval');
    const approval = Object.freeze({ ...normalizedScope(scope), id: randomUUID(), argumentsHash: canonicalTaskArgumentsHash(args), expiresAt });
    this.grants.set(approval.id, approval); return approval;
  }
  consume(id: string, scope: TaskApprovalScope, args: unknown): OneShotTaskApproval {
    const approval = this.grants.get(id);
    if (!approval) throw new GovernanceError('approval_missing_or_consumed');
    this.grants.delete(id);
    if (approval.expiresAt <= this.now() || approval.argumentsHash !== canonicalTaskArgumentsHash(args) || taskContentHash(normalizedScope(scope)) !== taskContentHash(normalizedScope(approval))) throw new GovernanceError('approval_scope_mismatch_or_expired');
    return approval;
  }
  revoke(id: string): boolean { return this.grants.delete(id); }
  revokeTask(taskId: string): void { for (const [id, approval] of this.grants) if (approval.taskId === taskId) this.grants.delete(id); }
}

export type TaskGovernanceAuditType = 'tool.started' | 'tool.completed' | 'tool.failed' | 'tool.denied' | 'tool.unknown_outcome' | 'approval.consumed' | 'budget.exceeded';
export interface TaskGovernanceAuditEvent { readonly eventType: TaskGovernanceAuditType; readonly payload: Readonly<{ callId: string; toolName: string; argumentsHash: string; idempotencyKeyHash: string; resultHash?: string; outcome?: string; reason?: string; approvalId?: string }> }
export interface GovernedToolInvocation { callId: string; toolName: string; arguments: unknown; requiredPermission: TaskPermission; paths?: readonly string[]; approvalId?: string; idempotencyKey?: string }
export interface RecoveredToolCall { readonly callId: string; readonly argumentsHash: string; readonly toolName: string; readonly idempotencyKeyHash?: string; readonly outcome: 'completed' | 'failed' | 'unknown_outcome' | 'started' }
export function normalizeTaskRelativePath(value: string): string {
  if (typeof value !== 'string' || !value || /^[\\/]/.test(value) || /[:\x00-\x1f]/.test(value)) throw new GovernanceError('invalid_relative_path');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) throw new GovernanceError('invalid_relative_path');
  return parts.join('/');
}
function matchesPattern(relative: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**/', '\u0000').replaceAll('**', '\u0001').replaceAll('*', '[^/]*').replaceAll('?', '[^/]').replaceAll('\u0000', '(?:.*/)?').replaceAll('\u0001', '.*');
  return new RegExp(`^${source}$`, 'i').test(relative);
}
export function assertTaskPathAllowed(contract: Pick<TaskContract, 'allowedPaths' | 'deniedPaths'>, rawPath: string): void {
  const relative = normalizeTaskRelativePath(rawPath);
  if (contract.deniedPaths.some(pattern => matchesPattern(relative, pattern)) || !contract.allowedPaths.some(pattern => matchesPattern(relative, pattern))) throw new GovernanceError('path_denied');
}
export class GovernedToolGateway {
  private readonly calls = new Map<string, { identity: string; promise?: Promise<unknown>; recovered?: boolean }>();
  constructor(private readonly options: { contract: TaskContract; workspacePath: string; budget: TaskBudgetGuard; approvals?: OneShotTaskApprovalBroker; audit?: (event: TaskGovernanceAuditEvent) => void | Promise<void>; initialCalls?: readonly RecoveredToolCall[] }) {
    for (const call of options.initialCalls ?? []) { const recovered = { identity: '', recovered: true }; this.calls.set(call.callId, recovered); if (call.idempotencyKeyHash) this.calls.set(`key:${call.idempotencyKeyHash}`, recovered); }
  }
  async execute<T>(input: GovernedToolInvocation, operation: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.callId) || !/^[A-Za-z0-9_.-]{1,128}$/.test(input.toolName)) throw new GovernanceError('invalid_tool_identity');
    const argumentsHash = canonicalTaskArgumentsHash(input.arguments);
    const idempotencyKeyHash = taskContentHash(input.idempotencyKey ?? input.callId);
    const identity = taskContentHash({ toolName: input.toolName, argumentsHash, requiredPermission: input.requiredPermission, paths: input.paths, idempotencyKeyHash });
    const previous = this.calls.get(input.callId);
    if (previous?.recovered) throw new GovernanceError('recovered_tool_outcome_requires_manual_review');
    if (previous) { if (previous.identity !== identity) throw new GovernanceError('idempotency_scope_mismatch'); return previous.promise as Promise<T>; }
    const alias = this.calls.get(`key:${idempotencyKeyHash}`);
    if (alias) { if (alias.recovered || alias.identity !== identity) throw new GovernanceError('idempotency_scope_mismatch'); return alias.promise as Promise<T>; }
    const payload = { callId: input.callId, toolName: input.toolName, argumentsHash, idempotencyKeyHash };
    const audit = async (eventType: TaskGovernanceAuditType, extra: Partial<TaskGovernanceAuditEvent['payload']> = {}) => this.options.audit?.(Object.freeze({ eventType, payload: Object.freeze({ ...payload, ...extra }) }));
    const promise = Promise.resolve().then(async () => {
      try {
        const contract = this.options.contract;
        if (!contract.allowedTools.includes(input.toolName) && !contract.allowedTools.includes(input.requiredPermission)) throw new GovernanceError('tool_not_allowed');
        if (!contract.permissions.includes(input.requiredPermission)) throw new GovernanceError('permission_denied');
        for (const raw of input.paths ?? []) assertTaskPathAllowed(contract, raw);
        if (input.requiredPermission !== 'read_project') {
          if (!input.approvalId || !this.options.approvals) throw new GovernanceError('approval_required');
          this.options.approvals.consume(input.approvalId, { taskId: contract.taskId, sessionId: contract.sessionId, projectId: contract.projectId, runtimeKind: contract.runtimeKind, workspacePath: this.options.workspacePath, toolName: input.toolName, contractVersion: contract.contractVersion }, input.arguments);
          await audit('approval.consumed', { approvalId: input.approvalId });
        }
        this.options.budget.reserveToolCall();
      } catch (error) { await audit(error instanceof GovernanceError && error.code.startsWith('budget_') ? 'budget.exceeded' : 'tool.denied', { reason: error instanceof GovernanceError ? error.code : 'policy_check_failed' }); throw error; }
      await audit('tool.started');
      if (canonicalTaskArgumentsHash(input.arguments) !== argumentsHash) {
        await audit('tool.denied', { reason: 'arguments_changed_after_authorization' });
        throw new GovernanceError('arguments_changed_after_authorization');
      }
      let result: T;
      try { result = await operation(); }
      catch (error) {
        if (input.requiredPermission !== 'read_project') {
          await audit('tool.unknown_outcome', { outcome: 'unknown_outcome', reason: 'side_effect_result_unconfirmed' });
          throw new GovernanceError('tool_outcome_unknown');
        }
        await audit('tool.failed', { outcome: 'failed', reason: 'tool_execution_failed' }); throw error;
      }
      try { await audit('tool.completed', { resultHash: canonicalTaskArgumentsHash(result), outcome: 'completed' }); }
      catch {
        try { await audit('tool.unknown_outcome', { outcome: 'unknown_outcome', reason: 'completion_audit_unconfirmed' }); } catch { /* 开始记录仍保留待确认；恢复时禁止重放。 */ }
        throw new GovernanceError('tool_completed_audit_unconfirmed');
      }
      return result;
    });
    const entry = { identity, promise }; this.calls.set(input.callId, entry); this.calls.set(`key:${idempotencyKeyHash}`, entry);
    return promise;
  }
}

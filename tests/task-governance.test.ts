import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTask, createTaskContract, DEFAULT_TASK_BUDGET, taskContentHash } from '../packages/agent-orchestrator/src';
import { assertRuntimeGovernance, canonicalTaskArgumentsHash, classifyRetryFailure, GovernanceError, GovernedToolGateway, normalizeTaskRelativePath, resolveTaskBudgetPolicy, retryPolicyDecision, runtimeCapabilityMatrix, TaskBudgetGuard, TaskCircuitBreaker, type TaskGovernanceAuditEvent } from '../packages/agent-orchestrator/src/governance';

function contract() {
  const task = createAgentTask({ id: 'task-1', sessionId: 'session-1', projectId: 'project-1', name: '治理样本', role: 'developer', description: '受控工具治理测试', runtimeKind: 'codex', workspaceMode: 'worktree' });
  return createTaskContract(task, { acceptanceCriteria: ['通过治理样本测试'], allowedTools: ['read_project', 'write_workspace'], permissions: ['read_project', 'write_workspace'], allowedPaths: ['src/**'], deniedPaths: ['src/private/**', '**/.env', '**/.env.*'] });
}
const scope = { workspacePath: path.resolve('task-governance-fixture'), toolName: 'write_project_file' };

test('三类 Runtime 能力矩阵如实声明原生权限部分可控及 usage 未接入', () => {
  for (const kind of ['codex', 'jinggong', 'claude_agent_sdk'] as const) {
    const matrix = runtimeCapabilityMatrix(kind);
    assert.equal(Object.keys(matrix).length, 11);
    assert.equal(matrix.tool_permission_interception.supported, 'partial');
    assert.equal(matrix.model_request_interception.supported, false);
    assert.equal(matrix.pause_resume.supported, false);
    assert.equal(matrix.token_usage.supported, false);
    assert.equal(matrix.cost_usage.supported, false);
    assert.equal(matrix.independent_agent_context.enforcementLayer, 'platform');
    assert.equal(Object.isFrozen(matrix), true);
    assert.equal(Object.isFrozen(matrix.event_stream), true);
    assert.throws(() => assertRuntimeGovernance(kind, { strictTools: true }), /unsupported_strict/);
    assert.throws(() => assertRuntimeGovernance(kind, { strictModelRequests: true }), /unsupported_strict/);
    assert.throws(() => assertRuntimeGovernance(kind, { strictTokenUsage: true }), /unsupported_strict/);
    assert.throws(() => assertRuntimeGovernance(kind, { strictCostUsage: true }), /unsupported_strict/);
    assert.doesNotThrow(() => assertRuntimeGovernance(kind, {}));
  }
});

test('预算逐维取项目、父任务、任务的最小值并保留来源，不能被子任务放大', () => {
  const resolved = resolveTaskBudgetPolicy({ project: { maxModelRequests: 20, maxToolCalls: 30, maxAgentDepth: 0 }, parent: { maxModelRequests: 10, maxToolCalls: 30 }, task: { ...DEFAULT_TASK_BUDGET, maxModelRequests: 100, maxToolCalls: 50 } });
  assert.equal(resolved.policy.maxModelRequests, 10);
  assert.deepEqual(resolved.sources.maxModelRequests, ['parent']);
  assert.equal(resolved.policy.maxToolCalls, 30);
  assert.deepEqual(resolved.sources.maxToolCalls, ['project', 'parent']);
  assert.equal(resolved.policy.maxAgentDepth, 0);
  assert.deepEqual(resolved.sources.maxAgentDepth, ['project']);
  assert.equal(Object.isFrozen(resolved.policy), true);
  assert.throws(() => resolveTaskBudgetPolicy({ project: { maxCostAmount: 5, currency: 'USD' }, task: { ...DEFAULT_TASK_BUDGET, maxCostAmount: 20, currency: 'CNY' } }), /currency/);
  assert.throws(() => resolveTaskBudgetPolicy({ project: { maxToolCalls: Number.NaN }, task: DEFAULT_TASK_BUDGET }), /invalid_budget/);
});

test('可选 token 与费用上限继承，费用只有同币种才可比较', () => {
  const budget = resolveTaskBudgetPolicy({ project: { maxInputTokens: 100, maxCostAmount: 2, currency: 'CNY' }, parent: { maxOutputTokens: 40 }, task: { ...DEFAULT_TASK_BUDGET, maxInputTokens: 400, maxCostAmount: 8, currency: 'CNY' } });
  assert.equal(budget.policy.maxInputTokens, 100);
  assert.equal(budget.policy.maxOutputTokens, 40);
  assert.equal(budget.policy.maxCostAmount, 2);
  assert.equal(budget.policy.currency, 'CNY');
});

test('turn/受控工具计数预留后封顶，缺失 usage 始终 unknown', () => {
  let now = 1000;
  const guard = new TaskBudgetGuard({ ...DEFAULT_TASK_BUDGET, maxModelRequests: 1, maxToolCalls: 2, maxRuntimeMinutes: 1 }, { now: () => now });
  assert.equal(guard.snapshot().tokenUsage, 'unknown');
  assert.equal(guard.snapshot().inputTokens, undefined);
  assert.equal(guard.snapshot().costUsage, 'unknown');
  guard.reserveModelTurn();
  assert.throws(() => guard.reserveModelTurn(), /budget_exceeded_model_turns/);
  guard.reserveToolCall(); guard.reserveToolCall();
  assert.throws(() => guard.reserveToolCall(), /budget_exceeded_tool_calls/);
  now += 60000;
  assert.throws(() => guard.check(), /budget_exceeded_elapsed/);
});

test('真实采集 usage 增量可累计，超限、负数、币种不匹配拒绝', () => {
  const guard = new TaskBudgetGuard({ ...DEFAULT_TASK_BUDGET, maxInputTokens: 10, maxOutputTokens: 8, maxCostAmount: 2, currency: 'CNY' });
  guard.recordUsage({ inputTokens: 3 });
  assert.equal(guard.snapshot().tokenUsage, 'unknown');
  guard.recordUsage({ inputTokens: 2, outputTokens: 1, costAmount: 0.5, currency: 'CNY' });
  assert.equal(guard.snapshot().inputTokens, 5);
  assert.equal(guard.snapshot().tokenUsage, 'reported');
  assert.equal(guard.snapshot().costUsage, 'reported');
  assert.throws(() => guard.recordUsage({ inputTokens: -1 }), /invalid_usage/);
  assert.throws(() => guard.recordUsage({ costAmount: 0.1, currency: 'USD' }), /currency/);
  assert.throws(() => guard.recordUsage({ inputTokens: 6 }), /budget_exceeded_input_tokens/);
  assert.equal(guard.snapshot().inputTokens, 11);
});

test('重启计数从持久化消耗恢复，不因新 guard 清零', () => {
  const guard = new TaskBudgetGuard({ ...DEFAULT_TASK_BUDGET, maxToolCalls: 2 }, { startedAt: 0, now: () => 1000, initial: { toolCalls: 2, modelTurns: 1 } });
  assert.equal(guard.snapshot().elapsedMs, 1000);
  assert.throws(() => guard.reserveToolCall(), /budget_exceeded_tool_calls/);
});

test('仅限流、暂时网络与服务失败可退避重试，权限认证取消和未知失败不重试', () => {
  for (const error of [{ status: 429 }, { status: 503 }, { code: 'ETIMEDOUT' }, { code: 'ECONNRESET' }]) assert.equal(classifyRetryFailure(error).retryable, true);
  for (const error of [{ status: 401 }, { status: 403 }, { name: 'AbortError' }, new GovernanceError('permission_denied'), new Error('编译失败')]) assert.equal(classifyRetryFailure(error).retryable, false);
  const failure = classifyRetryFailure({ status: 429 });
  assert.deepEqual(retryPolicyDecision({ failure, attempt: 1, maxRetries: 2, random: () => 0 }), { retry: true, delayMs: 250, reason: 'rate_limit' });
  assert.equal(retryPolicyDecision({ failure, attempt: 2, maxRetries: 2, random: () => 1 }).delayMs, 1000);
  assert.equal(retryPolicyDecision({ failure, attempt: 3, maxRetries: 2 }).retry, false);
});

test('连续暂时失败触发熔断，冷却后只允许一个探测请求', () => {
  let now = 0;
  const breaker = new TaskCircuitBreaker({ threshold: 2, cooldownMs: 100, now: () => now });
  const transient = classifyRetryFailure({ status: 503 });
  breaker.recordFailure(transient); breaker.assertCanExecute();
  breaker.recordFailure(transient);
  assert.equal(breaker.snapshot().state, 'open');
  assert.throws(() => breaker.assertCanExecute(), /circuit_open/);
  now = 100; breaker.assertCanExecute();
  assert.equal(breaker.snapshot().state, 'half_open');
  assert.throws(() => breaker.assertCanExecute(), /circuit_open/);
  breaker.recordSuccess(); assert.equal(breaker.snapshot().state, 'closed');
});

test('参数摘要键顺序规范化、原文不保留，拒绝非 JSON 与循环', () => {
  assert.equal(canonicalTaskArgumentsHash({ b: 2, a: 1 }), canonicalTaskArgumentsHash({ a: 1, b: 2 }));
  assert.notEqual(canonicalTaskArgumentsHash({ a: 1 }), canonicalTaskArgumentsHash({ a: 2 }));
  assert.throws(() => canonicalTaskArgumentsHash({ invalid: undefined }), /invalid_tool_arguments/);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => canonicalTaskArgumentsHash(cycle), /invalid_tool_arguments/);
});

test('路径只接受相对路径，拒绝 UNC/盘符/遍历/ADS/尾点空格等 Windows 别名', () => {
  assert.equal(normalizeTaskRelativePath('src\\A.ts'), 'src/A.ts');
  for (const value of ['../x', 'src/../x', 'src/./x', '/root', '\\\\server\\share', 'C:\\file', 'C:relative', 'src/a.ts:secret', 'src/name.', 'src/name ', 'src//x']) assert.throws(() => normalizeTaskRelativePath(value), /invalid_relative_path/, value);
});

test('工具网关允许路径内读取，禁止规则优先且大小写无法绕过', async () => {
  const events: TaskGovernanceAuditEvent[] = [];
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { events.push(event); } });
  assert.deepEqual(await gateway.execute({ callId: 'read-1', toolName: 'read_project_file', arguments: { path: 'src/A.ts' }, requiredPermission: 'read_project', paths: ['src/A.ts'] }, async () => ({ text: '样本' })), { text: '样本' });
  for (const [index, relative] of ['src/private/a.ts', 'SRC/PRIVATE/a.ts', 'src/.ENV', 'outside/a.ts'].entries()) await assert.rejects(gateway.execute({ callId: `deny-${index}`, toolName: 'read_project_file', arguments: { path: relative }, requiredPermission: 'read_project', paths: [relative] }, async () => assert.fail('禁止路径不应执行')), /path_denied/);
  assert.equal(events[0].eventType, 'tool.started');
  assert.equal(events[1].eventType, 'tool.completed');
  assert.equal(Object.isFrozen(events[0].payload), true);
});

test('已获契约权限的写操作直接执行，审计只有摘要没有参数和结果原文', async () => {
  const events: TaskGovernanceAuditEvent[] = [];
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { events.push(event); } });
  const args = { path: 'src/a.ts', content: '合成秘密原文不应进入审计' };
  let executions = 0;
  await gateway.execute({ callId: 'write-1', toolName: scope.toolName, arguments: args, requiredPermission: 'write_workspace', paths: ['src/a.ts'] }, async () => { executions++; return { text: '合成结果原文不应进入审计' }; });
  assert.equal(executions, 1);
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes(args.content), false);
  assert.equal(encoded.includes('合成结果原文'), false);
  assert.deepEqual(events.map(event => event.eventType), ['tool.started', 'tool.completed']);
  await assert.rejects(gateway.execute({ callId: 'write-denied-path', toolName: scope.toolName, arguments: { ...args, path: 'src/private/a.ts' }, requiredPermission: 'write_workspace', paths: ['src/private/a.ts'] }, async () => assert.fail('契约禁止路径不应执行')), /path_denied/);
});

test('契约内非读取工具自动执行并计入预算，契约外权限继续拒绝', async () => {
  const permissions = ['write_workspace', 'execute_command', 'access_network', 'install_dependency', 'read_secrets', 'database_read', 'database_write', 'git_commit', 'git_push', 'git_merge', 'delete_files'] as const;
  const granted = contract(); granted.allowedTools = [...permissions]; granted.permissions = [...permissions];
  const budget = new TaskBudgetGuard(DEFAULT_TASK_BUDGET);
  const gateway = new GovernedToolGateway({ contract: granted, workspacePath: scope.workspacePath, budget });
  let executions = 0;
  for (const permission of permissions) {
    assert.deepEqual(await gateway.execute({ callId: permission, toolName: permission, arguments: {}, requiredPermission: permission }, async () => { executions++; return { executed: permission }; }), { executed: permission });
  }
  assert.equal(executions, permissions.length); assert.equal(budget.snapshot().toolCalls, permissions.length);
  const denied = contract(); denied.allowedTools.push('git_push');
  const deniedGateway = new GovernedToolGateway({ contract: denied, workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET) });
  await assert.rejects(deniedGateway.execute({ callId: 'no-contract-permission', toolName: 'git_push', arguments: {}, requiredPermission: 'git_push' }, async () => assert.fail('未获契约权限不应执行')), /permission_denied/);
});

test('网关在途与已完成调用复用同一次执行，变更参数不得借用幂等键', async () => {
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET) });
  let count = 0; let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const input = { callId: 'call-1', toolName: 'read_project_file', arguments: { path: 'src/a.ts' }, requiredPermission: 'read_project' as const, paths: ['src/a.ts'], idempotencyKey: 'same-operation' };
  const operation = async () => { count += 1; await waiting; return { result: 1 }; };
  const one = gateway.execute(input, operation); const two = gateway.execute(input, operation);
  release(); assert.deepEqual(await one, await two); assert.equal(count, 1);
  await gateway.execute({ ...input, callId: 'call-alias' }, operation); assert.equal(count, 1);
  await assert.rejects(gateway.execute({ ...input, arguments: { path: 'src/b.ts' } }, operation), /idempotency_scope_mismatch/);
});

test('恢复后的开始或完成历史不自动重放，新调用ID也不能复用历史幂等键', async () => {
  const idempotencyKey = 'historical-operation';
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), initialCalls: [{ callId: 'old', toolName: 'read_project_file', argumentsHash: taskContentHash({}), idempotencyKeyHash: taskContentHash(idempotencyKey), outcome: 'started' }] });
  const operation = async () => assert.fail('未知历史结果不能重放');
  await assert.rejects(gateway.execute({ callId: 'old', toolName: 'read_project_file', arguments: {}, requiredPermission: 'read_project' }, operation), /manual_review/);
  await assert.rejects(gateway.execute({ callId: 'new', idempotencyKey, toolName: 'read_project_file', arguments: {}, requiredPermission: 'read_project' }, operation), /idempotency_scope_mismatch/);
});

test('预算超限、未授权工具及权限均在真正工具执行前拒绝', async () => {
  const budget = new TaskBudgetGuard({ ...DEFAULT_TASK_BUDGET, maxToolCalls: 1 }); budget.reserveToolCall();
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget });
  await assert.rejects(gateway.execute({ callId: 'limit', toolName: 'read_project_file', arguments: {}, requiredPermission: 'read_project' }, async () => assert.fail('超预算不应执行')), /budget_exceeded/);
  await assert.rejects(gateway.execute({ callId: 'permission', toolName: 'git_push', arguments: {}, requiredPermission: 'git_push' }, async () => assert.fail('未授权不应执行')), /tool_not_allowed|permission_denied/);
});

test('执行错误仅审计固定分类，错误后相同调用不会自动再次执行', async () => {
  const events: TaskGovernanceAuditEvent[] = []; let count = 0;
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { events.push(event); } });
  const input = { callId: 'failure', toolName: 'read_project_file', arguments: {}, requiredPermission: 'read_project' as const };
  const operation = async () => { count += 1; throw new Error('合成敏感错误原文'); };
  await assert.rejects(gateway.execute(input, operation)); await assert.rejects(gateway.execute(input, operation));
  assert.equal(count, 1); assert.equal(JSON.stringify(events).includes('合成敏感错误原文'), false);
  assert.equal(events.at(-1)?.eventType, 'tool.failed');
});

test('写操作开始审计失败不执行工具，重复请求仍保持同一失败', async () => {
  let count = 0;
  const args = { path: 'src/a.ts', content: '尚未执行' };
  const events: TaskGovernanceAuditEvent[] = [];
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { events.push(event); if (event.eventType === 'tool.started') throw new Error('合成写操作开始审计写入失败'); } });
  const input = { callId: 'write-start-audit-fault', toolName: scope.toolName, arguments: args, requiredPermission: 'write_workspace' as const, paths: ['src/a.ts'] };
  const operation = async () => { count += 1; return {}; };
  await assert.rejects(gateway.execute(input, operation)); await assert.rejects(gateway.execute(input, operation));
  assert.equal(count, 0); assert.deepEqual(events.map(event => event.eventType), ['tool.started']);
});

test('tool.started 审计失败时工具尚未执行，重复请求仍保持拒绝', async () => {
  let count = 0;
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { if (event.eventType === 'tool.started') throw new Error('合成开始审计写入失败'); } });
  const input = { callId: 'start-fault', toolName: 'read_project_file', arguments: {}, requiredPermission: 'read_project' as const };
  const operation = async () => { count += 1; return {}; };
  await assert.rejects(gateway.execute(input, operation)); await assert.rejects(gateway.execute(input, operation)); assert.equal(count, 0);
});

test('真实文件副作用后发生异常时审计 unknown_outcome，同一调用不再次写入', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jinggong-tool-side-effect-'));
  try {
    const args = { path: 'src/a.ts', content: '真实副作用样本' }; const events: TaskGovernanceAuditEvent[] = []; let count = 0;
    const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: root, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { events.push(event); } });
    const input = { callId: 'side-effect-fault', toolName: scope.toolName, arguments: args, requiredPermission: 'write_workspace' as const, paths: ['src/a.ts'] };
    const operation = async () => { count += 1; await writeFile(path.join(root, 'actual-result.txt'), args.content); throw new Error('已写入之后的合成响应异常'); };
    await assert.rejects(gateway.execute(input, operation), /tool_outcome_unknown/);
    await assert.rejects(gateway.execute(input, operation), /tool_outcome_unknown/);
    assert.equal(count, 1); assert.equal(await readFile(path.join(root, 'actual-result.txt'), 'utf8'), args.content);
    assert.equal(events.at(-1)?.eventType, 'tool.unknown_outcome'); assert.equal(events.at(-1)?.payload.reason, 'side_effect_result_unconfirmed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tool.completed 审计失败会尽力落 unknown_outcome 并禁止相同调用重放', async () => {
  const events: TaskGovernanceAuditEvent[] = []; let count = 0;
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { if (event.eventType === 'tool.completed') throw new Error('合成完成审计写入失败'); events.push(event); } });
  const input = { callId: 'completed-fault', toolName: 'read_project_file', arguments: {}, requiredPermission: 'read_project' as const };
  const operation = async () => { count += 1; return { value: 1 }; };
  await assert.rejects(gateway.execute(input, operation), /audit_unconfirmed/); await assert.rejects(gateway.execute(input, operation), /audit_unconfirmed/);
  assert.equal(count, 1); assert.deepEqual(events.map(event => event.eventType), ['tool.started', 'tool.unknown_outcome']);
});

test('契约校验后等待审计期间参数发生变化时，在真正执行前拒绝', async () => {
  const args = { path: 'src/a.ts', content: '校验时内容' }; let count = 0;
  const gateway = new GovernedToolGateway({ contract: contract(), workspacePath: scope.workspacePath, budget: new TaskBudgetGuard(DEFAULT_TASK_BUDGET), audit: event => { if (event.eventType === 'tool.started') args.content = '校验后的变更内容'; } });
  await assert.rejects(gateway.execute({ callId: 'mutation-after-contract-check', toolName: scope.toolName, arguments: args, requiredPermission: 'write_workspace', paths: ['src/a.ts'] }, async () => { count += 1; return {}; }), /arguments_changed_after_authorization/);
  assert.equal(count, 0);
});

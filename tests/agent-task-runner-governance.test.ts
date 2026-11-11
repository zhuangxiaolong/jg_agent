import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentTaskRunner, createAgentTaskToolGateway } from '../apps/desktop/src/main/agent-tasks';
import type { SettingsService } from '../apps/desktop/src/main/settings';
import { LocalStore } from '../packages/storage/src';
import { classifyRetryFailure, createAgentTask, createTaskContract, reconcileTaskStates, TASK_GOVERNANCE_BLOCKED_PREFIX, TaskBudgetGuard, taskContentHash, transitionAgentTask } from '../packages/agent-orchestrator/src';
import { ProjectReadBroker } from '../packages/agent-runtime/src/project-read-broker';
import type { RuntimeAdapter, RuntimeEvent, RuntimeOptions } from '../packages/agent-runtime/src';
import type { AgentTask, TaskBudgetPolicy, TaskContract } from '../packages/domain/src';

class FixtureRuntime implements RuntimeAdapter {
  readonly kind = 'codex' as const; readonly version = 'fixture'; readonly capabilitiesVersion = 1;
  listener?: (event: RuntimeEvent) => void; starts = 0; turns = 0; closed = 0; startFailure?: Error;
  onEvent(listener: (event: RuntimeEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  async checkRuntime() { return { kind: this.kind, available: true, compatible: true, version: this.version, capabilitiesVersion: 1, detail: '临时协议样本' }; }
  async start() { this.starts += 1; if (this.startFailure) throw this.startFailure; }
  async startSession() { return 'fixture-thread'; }
  async resumeSession() { return 'fixture-thread'; }
  async sendTurn() { this.turns += 1; }
  async cancelRun() {}
  async close() { this.closed += 1; }
}

async function fixture(t: TestContext, projectBudgetPolicy?: () => Partial<TaskBudgetPolicy>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'jinggong-runner-governance-')));
  const workspace = path.join(root, 'workspace'); await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'sample.ts'), 'export const value = 42;\n');
  await mkdir(path.join(workspace, 'src', 'private')); await writeFile(path.join(workspace, 'src', 'private', 'hidden.ts'), '不允许读取\n');
  const database = path.join(root, 'local.sqlite'); const store = await LocalStore.open(database);
  const projectId = 'sample-project'; const sessionId = 'sample-session';
  store.saveProject({ id: projectId, path: workspace, name: '运行器临时样本', branch: 'main' });
  store.saveSession({ id: sessionId, projectId, title: '运行器临时测试', workspacePath: workspace, status: 'idle', createdAt: new Date().toISOString(), model: 'fixture-model', runtimeKind: 'codex' });
  const runtimes: FixtureRuntime[] = []; const runtimeOptions: RuntimeOptions[] = []; let settingsReads = 0;
  const settings = { redactContent: (value: string) => value, assertCleanText: (_value: string) => undefined, profiles: () => { settingsReads += 1; return [{ id: 'fixture-provider', baseUrl: 'https://fixture.invalid', models: ['fixture-model'] }]; }, credential: () => ({ read: () => 'synthetic-fixture-key' }) } as unknown as SettingsService;
  const runner = new AgentTaskRunner({ store, settings, dataRoot: root, resourcesRoot: root, codexExecutable: process.execPath, jinggongExecutable: process.execPath, publish: () => undefined, projectBudgetPolicy, runtimeFactory: (_kind, options) => { runtimeOptions.push(options); const runtime = new FixtureRuntime(); runtimes.push(runtime); return runtime; } });
  t.after(async () => { await runner.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const current = (id = 'task-1') => store.listAgentTasks(sessionId).find(task => task.id === id)!;
  const add = (id = 'task-1', overrides: Partial<TaskContract> = {}, legacy = false, parentTaskId?: string) => {
    const task = createAgentTask({ id, sessionId, projectId, name: '运行器样本任务', role: 'testing', description: '仅用于运行器安全回归的临时样本', runtimeKind: 'codex', workspaceMode: 'read', maxAttempts: 2, ...(parentTaskId ? { parentTaskId } : {}) });
    if (legacy) store.saveAgentTasksForSession(sessionId, [...store.listAgentTasks(sessionId), task]);
    else store.saveAgentTaskContract(task, createTaskContract(task, { allowedPaths: ['src/**'], deniedPaths: ['src/private/**'], ...overrides }), 0, 'local-user');
    return current(id);
  };
  const running = (id = 'task-1') => { store.saveAgentTasksForSession(sessionId, store.listAgentTasks(sessionId).map(task => task.id === id ? transitionAgentTask(task, { status: 'RUNNING' }) : task)); return current(id); };
  return { root, workspace, database, store, runner, settings, runtimes, runtimeOptions, projectId, sessionId, current, add, running, settingsReads: () => settingsReads };
}
async function until(predicate: () => boolean, timeout = 2500) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() >= end) assert.fail('等待运行器状态超时'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('新契约任务严格门禁先于 Runtime/凭据读取/attempt，治理阻塞不能被刷新解锁', async t => {
  const f = await fixture(t); f.add(); await f.runner.startForSession(f.sessionId);
  assert.equal(f.current().status, 'BLOCKED'); assert.equal(f.current().executionStatus, 'BLOCKED');
  assert.equal(f.current().attempt, 0); assert.equal(f.runtimes.length, 0); assert.equal(f.settingsReads(), 0);
  assert.ok(f.current().error?.startsWith(TASK_GOVERNANCE_BLOCKED_PREFIX));
  assert.match(f.current().error!, /未启动、未消耗尝试次数/);
  assert.ok(f.store.getTaskAuditSnapshot(f.sessionId, 'task-1').events.some(event => event.eventType === 'governance.blocked'));
  assert.equal(reconcileTaskStates([f.current()])[0].status, 'BLOCKED');
  for (let index = 0; index < 3; index++) { await f.runner.startForSession(f.sessionId); f.runner.refreshSchedule(); }
  assert.equal(f.current().attempt, 0); assert.equal(f.current().status, 'BLOCKED'); assert.equal(f.runtimes.length, 0);
});

test('旧任务维持可启动流程，工程任务门禁不会全局禁用旧会话', async t => {
  const f = await fixture(t); f.add('legacy', {}, true); await f.runner.startForSession(f.sessionId);
  await until(() => f.runtimes[0]?.turns === 1);
  assert.equal(f.current('legacy').status, 'RUNNING'); assert.equal(f.current('legacy').attempt, 1);
  assert.equal(f.runtimeOptions[0].toolGateway, undefined);
  f.runtimes[0].listener?.({ type: 'status', threadId: 'fixture-thread', text: 'completed' });
  await until(() => f.current('legacy').status === 'COMPLETED');
});

test('继承父任务的深度预算会在消耗尝试前阻塞子任务', async t => {
  const f = await fixture(t);
  const parent = f.add('parent'); const parentContract = f.store.getAgentTaskContractVersions(f.sessionId, parent.id)[0].contract;
  f.store.saveAgentTaskContract(parent, createTaskContract(parent, { ...parentContract, contractVersion: 2, budgetPolicy: { ...parentContract.budgetPolicy, maxAgentDepth: 0 } }), 1, 'local-user');
  f.add('child', {}, false, 'parent'); await f.runner.startForSession(f.sessionId);
  assert.equal(f.current('child').status, 'BLOCKED'); assert.equal(f.current('child').attempt, 0);
  assert.match(f.current('child').error!, /budget_agent_depth/);
});

test('应用退出将仍在执行的工程任务标记 INTERRUPTED，刷新不会自动重启', async t => {
  const f = await fixture(t); f.add(); f.running(); await f.runner.close();
  assert.equal(f.current().executionStatus, 'INTERRUPTED'); assert.equal(f.current().status, 'BLOCKED'); assert.equal(f.current().attempt, 1);
  assert.equal(reconcileTaskStates([f.current()])[0].executionStatus, 'INTERRUPTED');
});

test('父任务代理总量预算覆盖整个任务树，超量时不启动代理', async t => {
  const f = await fixture(t); const parent = f.add('parent'); const contract = f.store.getAgentTaskContractVersions(f.sessionId, parent.id)[0].contract;
  f.store.saveAgentTaskContract(parent, createTaskContract(parent, { ...contract, contractVersion: 2, budgetPolicy: { ...contract.budgetPolicy, maxTotalAgentsPerTask: 1 } }), 1, 'local-user');
  f.add('child', {}, false, parent.id); await f.runner.startForSession(f.sessionId);
  assert.match(f.current('parent').error!, /budget_total_agents/); assert.match(f.current('child').error!, /budget_total_agents/);
  assert.equal(f.current('child').attempt, 0); assert.equal(f.runtimes.length, 0);
});

test('项目并发上限会等待现有任务退出，预算来源持久化为项目', async t => {
  const f = await fixture(t, () => ({ maxConcurrentAgents: 1, maxToolCalls: 5 }));
  f.add('legacy-running', {}, true); f.running('legacy-running'); f.add(); await f.runner.startForSession(f.sessionId);
  assert.equal(f.current().status, 'PENDING'); assert.equal(f.current().attempt, 0);
  f.store.saveAgentTasksForSession(f.sessionId, f.store.listAgentTasks(f.sessionId).map(task => task.id === 'legacy-running' ? transitionAgentTask(task, { status: 'COMPLETED' }) : task));
  await f.runner.startForSession(f.sessionId); assert.equal(f.current().status, 'BLOCKED');
  const inherited = f.store.getTaskAuditSnapshot(f.sessionId, 'task-1').budgetEvents.find(event => event.eventType === 'budget.inherited');
  assert.equal((inherited?.payload.policy as TaskBudgetPolicy).maxToolCalls, 5);
  assert.deepEqual((inherited?.payload.sources as Record<string, string[]>).maxToolCalls, ['project']);
});

test('开发型任务在受控执行未支持时阻塞，绝不使用父会话目录启动', async t => {
  const f = await fixture(t);
  const task = createAgentTask({ id: 'task-1', sessionId: f.sessionId, projectId: f.projectId, name: '开发型样本', role: 'developer', description: '尚未支持的受控开发执行', workspaceMode: 'worktree' });
  f.store.saveAgentTaskContract(task, createTaskContract(task, { acceptanceCriteria: ['只验证开发型门禁，不执行代码修改'] }), 0, 'local-user');
  await f.runner.startForSession(f.sessionId);
  assert.match(f.current().error!, /worktree_execution_not_supported/); assert.equal(f.current().attempt, 0); assert.equal(f.runtimes.length, 0);
});

test('真实 Runtime interrupted 事件使用工程状态 INTERRUPTED 而非失败重试', async t => {
  const f = await fixture(t); f.add(); const task = f.running(); const runtime = new FixtureRuntime();
  const active = { task, adapter: runtime, threadId: 'fixture-thread', finished: false, cancelled: false, output: '' };
  const internals = f.runner as unknown as { active: Map<string, unknown>; handleEvent(active: unknown, event: RuntimeEvent): Promise<void> };
  internals.active.set(task.id, active);
  await internals.handleEvent(active, { type: 'status', threadId: 'fixture-thread', text: 'interrupted' });
  assert.equal(f.current().executionStatus, 'INTERRUPTED'); assert.equal(f.current().attempt, 1); assert.equal(runtime.closed, 1);
});

test('动态回调固定权限映射，使用真实 ProjectReadBroker 读样本并持久化摘要审计', async t => {
  const f = await fixture(t); f.add(); const task = f.running();
  const contract = f.store.getAgentTaskContractVersions(f.sessionId, task.id)[0].contract;
  const gateway = createAgentTaskToolGateway({ store: f.store, task, workspacePath: f.workspace, budget: new TaskBudgetGuard(contract.budgetPolicy) });
  const broker = await ProjectReadBroker.create(f.workspace);
  const request = { toolName: 'read_project_file', arguments: { path: 'src/sample.ts' }, threadId: 'thread', turnId: 'turn', requestId: '1' };
  const result = await gateway(request, () => broker.call(request.toolName, request.arguments));
  assert.equal(result.content, 'export const value = 42;\n');
  const audit = f.store.getTaskAuditSnapshot(f.sessionId, task.id);
  assert.deepEqual(audit.toolEvents.map(event => event.eventType), ['tool.started', 'tool.completed']);
  assert.match(String(audit.toolEvents[0].payload.argumentsHash), /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(audit.toolEvents).includes('export const value'), false);
  assert.equal(audit.pendingToolCalls.length, 0);
});

test('动态回调拒绝未知工具、越权写入与禁止路径，真实执行函数不被调用', async t => {
  const f = await fixture(t); f.add(); const task = f.running(); const contract = f.store.getAgentTaskContractVersions(f.sessionId, task.id)[0].contract;
  const gateway = createAgentTaskToolGateway({ store: f.store, task, workspacePath: f.workspace, budget: new TaskBudgetGuard(contract.budgetPolicy) });
  let executions = 0; const execute = async () => { executions += 1; return {}; };
  for (const [index, toolName, args] of [[1, 'execute_command', { command: 'anything', requiredPermission: 'read_project' }], [2, 'write_project_file', { path: 'src/sample.ts', content: '不应写入' }], [3, 'read_project_file', { path: 'SRC/PRIVATE/hidden.ts' }]] as const) {
    await assert.rejects(gateway({ toolName, arguments: args, threadId: 'thread', turnId: 'turn', requestId: index }, execute), /unknown_tool|tool_not_allowed|permission_denied|path_denied/);
  }
  assert.equal(executions, 0); assert.equal(await readFile(path.join(f.workspace, 'src/sample.ts'), 'utf8'), 'export const value = 42;\n');
});

test('目录列表不会泄露契约禁止路径，真实磁盘别名也不能绕过自定义 deny', async t => {
  const f = await fixture(t); f.add('task-1', { allowedPaths: ['**'] }); const task = f.running(); const contract = f.store.getAgentTaskContractVersions(f.sessionId, task.id)[0].contract;
  const gateway = createAgentTaskToolGateway({ store: f.store, task, workspacePath: f.workspace, budget: new TaskBudgetGuard(contract.budgetPolicy) });
  const broker = await ProjectReadBroker.create(f.workspace);
  const listed = await gateway({ toolName: 'list_project_files', arguments: { path: '.' }, threadId: 'thread', turnId: 'turn', requestId: 'list' }, () => broker.call('list_project_files', { path: '.' }));
  assert.ok((listed.files as string[]).includes('src/sample.ts')); assert.equal((listed.files as string[]).some(file => file.includes('private')), false);
  await symlink(path.join(f.workspace, 'src', 'private'), path.join(f.workspace, 'src', 'alias'), 'junction');
  let executions = 0;
  await assert.rejects(gateway({ toolName: 'read_project_file', arguments: { path: 'src/alias/hidden.ts' }, threadId: 'thread', turnId: 'turn', requestId: 'alias' }, async () => { executions += 1; return broker.call('read_project_file', { path: 'src/alias/hidden.ts' }); }), /path_denied/);
  assert.equal(executions, 0);
});

test('真实工具调用只执行一次；重新创建回调时历史开始记录也不能重放', async t => {
  const f = await fixture(t); f.add(); const task = f.running(); const contract = f.store.getAgentTaskContractVersions(f.sessionId, task.id)[0].contract;
  const options = { store: f.store, task, workspacePath: f.workspace, budget: new TaskBudgetGuard(contract.budgetPolicy) };
  const gateway = createAgentTaskToolGateway(options); const broker = await ProjectReadBroker.create(f.workspace); let count = 0;
  const request = { toolName: 'read_project_file', arguments: { path: 'src/sample.ts' }, threadId: 'thread', turnId: 'turn', requestId: 'same' };
  const operation = async () => { count += 1; return broker.call(request.toolName, request.arguments); };
  await Promise.all([gateway(request, operation), gateway(request, operation)]); await gateway(request, operation); assert.equal(count, 1);
  const recreated = createAgentTaskToolGateway(options);
  await assert.rejects(recreated(request, operation), /manual_review/); assert.equal(count, 1);
});

test('执行期间状态版本变化会留下未确认结果并阻止重放', async t => {
  const f = await fixture(t); f.add(); const task = f.running(); const contract = f.store.getAgentTaskContractVersions(f.sessionId, task.id)[0].contract;
  const gateway = createAgentTaskToolGateway({ store: f.store, task, workspacePath: f.workspace, budget: new TaskBudgetGuard(contract.budgetPolicy) });
  const broker = await ProjectReadBroker.create(f.workspace);
  await assert.rejects(gateway({ toolName: 'read_project_file', arguments: { path: 'src/sample.ts' }, threadId: 'thread', turnId: 'turn', requestId: 'cas' }, async () => {
    const result = await broker.call('read_project_file', { path: 'src/sample.ts' });
    f.store.appendTaskAuditEvent(f.sessionId, task.id, { eventType: 'runtime.external_update', actor: 'test-fixture', payload: { reasonCode: 'version_changed' } });
    return result;
  }), /audit_unconfirmed/);
  assert.equal(f.store.getTaskAuditSnapshot(f.sessionId, task.id).pendingToolCalls.length, 1);
});

test('重启后未知工具结果会保持中断，即使尝试刷新也不自动执行', async t => {
  const f = await fixture(t); f.add(); const task = f.running();
  f.store.appendTaskAuditEvent(f.sessionId, task.id, { eventType: 'tool.started', actor: 'test-fixture', payload: { callId: 'unfinished', toolName: 'read_project_file', argumentsHash: taskContentHash({ path: 'src/sample.ts' }) } });
  f.store.backup(path.join(f.root, 'restart.sqlite'));
  const restored = await LocalStore.open(path.join(f.root, 'restart.sqlite'));
  try {
    const recovered = restored.listAgentTasks(f.sessionId)[0];
    assert.equal(recovered.executionStatus, 'INTERRUPTED'); assert.equal(recovered.status, 'BLOCKED');
    assert.equal(reconcileTaskStates([recovered])[0].executionStatus, 'INTERRUPTED');
    assert.ok(restored.getTaskAuditSnapshot(f.sessionId, task.id).toolEvents.some(event => event.eventType === 'tool.unknown_outcome'));
  } finally { restored.close(); }
});

test('失败后重试重读新状态版本，且新契约恢复后仍须先过严格门禁', async t => {
  const f = await fixture(t); f.add(); const task = f.running();
  const active = { task, finished: false, cancelled: false, output: '', retryFailure: classifyRetryFailure({ status: 503 }), submittedTurn: false };
  const internal = f.runner as unknown as { active: Map<string, unknown>; finish(active: unknown, status: 'FAILED', error: string): Promise<void> };
  internal.active.set(task.id, active); await internal.finish(active, 'FAILED', '临时服务故障');
  await until(() => f.current().status === 'BLOCKED');
  assert.equal(f.current().attempt, 1); assert.match(f.current().error!, /TASK_GOVERNANCE_BLOCKED/);
});

test('模型完成但工具没有确认结果时，finish 更新审计版本后保持 INTERRUPTED', async t => {
  const f = await fixture(t); f.add(); const task = f.running();
  f.store.appendTaskAuditEvent(f.sessionId, task.id, { eventType: 'tool.started', actor: 'test-fixture', payload: { callId: 'pending-at-completion', toolName: 'read_project_file', argumentsHash: taskContentHash({}) } });
  const active = { task, finished: false, cancelled: false, output: '模型声称完成' };
  const internal = f.runner as unknown as { active: Map<string, unknown>; finish(active: unknown, status: 'COMPLETED'): Promise<void> };
  internal.active.set(task.id, active); await internal.finish(active, 'COMPLETED');
  assert.equal(f.current().executionStatus, 'INTERRUPTED'); assert.equal(f.current().status, 'BLOCKED');
  const snapshot = f.store.getTaskAuditSnapshot(f.sessionId, task.id);
  assert.equal(snapshot.pendingToolCalls.length, 0); assert.ok(snapshot.toolEvents.some(event => event.eventType === 'tool.unknown_outcome'));
  assert.match(f.current().error!, /模型完成消息不能替代工具结果/);
});

test('熔断冷却期结束会自动唤醒等待任务，不依赖人工刷新', async t => {
  const f = await fixture(t); const task = f.add('legacy', {}, true);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const internal = f.runner as unknown as { circuit(task: AgentTask): { recordFailure(failure: ReturnType<typeof classifyRetryFailure>): void } };
  const circuit = internal.circuit(task); const failure = classifyRetryFailure({ status: 503 });
  for (let index = 0; index < 3; index++) circuit.recordFailure(failure);
  await f.runner.startForSession(f.sessionId); assert.equal(f.current('legacy').attempt, 0); assert.equal(f.runtimes.length, 0);
  t.mock.timers.tick(30001);
  for (let index = 0; index < 10; index++) await Promise.resolve();
  assert.equal(f.runtimes.length, 1); assert.equal(f.runtimes[0].turns, 1); assert.equal(f.current('legacy').attempt, 1);
  t.mock.timers.reset();
});

test('工程阻塞、中断、暂停和失败任务可显式终止，保留真实目录文件和不可变工作区映射', async t => {
  const f = await fixture(t);
  for (const state of ['BLOCKED', 'INTERRUPTED', 'PAUSED', 'FAILED'] as const) {
    const id = `cancel-${state}`; const workspace = path.join(f.root, id); await mkdir(workspace); await writeFile(path.join(workspace, 'preserved.txt'), `保留样本-${state}`);
    const task = createAgentTask({ id, sessionId: f.sessionId, projectId: f.projectId, name: '终止工作区保留样本', role: 'developer', description: '仅验证状态终止及工作区保留', runtimeKind: 'codex', workspaceMode: 'worktree' });
    f.store.saveAgentTaskContract(task, createTaskContract(task, { acceptanceCriteria: ['终止后保留临时目录与映射'] }), 0, 'local-user');
    const mapping = { taskId: id, sessionId: f.sessionId, projectId: f.projectId, path: workspace, fixture: true };
    f.store.bindTaskWorkspace(f.sessionId, id, f.current(id).stateVersion!, workspace, mapping);
    if (state !== 'BLOCKED') f.store.transitionTaskLifecycle({ sessionId: f.sessionId, taskId: id, expectedStateVersion: f.current(id).stateVersion!, dimension: 'execution', to: 'RUNNING', actor: 'test-fixture' });
    f.store.transitionTaskLifecycle({ sessionId: f.sessionId, taskId: id, expectedStateVersion: f.current(id).stateVersion!, dimension: 'execution', to: state, actor: 'test-fixture', reason: `${TASK_GOVERNANCE_BLOCKED_PREFIX} 终止测试样本` });
    await f.runner.cancel(f.sessionId, id);
    assert.equal(f.current(id).executionStatus, 'CANCELLED'); assert.equal(f.current(id).status, 'CANCELLED');
    assert.equal(f.current(id).workspacePath, workspace); assert.equal(await readFile(path.join(workspace, 'preserved.txt'), 'utf8'), `保留样本-${state}`);
    assert.deepEqual(f.store.listTaskLifecycleEvents(f.sessionId, id).find(event => event.eventType === 'workspace.created')?.payload.workspace, mapping);
    assert.equal(reconcileTaskStates(f.store.listAgentTasks(f.sessionId)).find(task => task.id === id)?.status, 'CANCELLED');
  }
  assert.equal(f.runtimes.length, 0); assert.equal(f.settingsReads(), 0);
  f.store.backup(path.join(f.root, 'cancelled-restart.sqlite'));
  const restarted = await LocalStore.open(path.join(f.root, 'cancelled-restart.sqlite'));
  try { assert.ok(restarted.listAgentTasks(f.sessionId).every(task => task.executionStatus === 'CANCELLED')); } finally { restarted.close(); }
});

test('按会话终止包含工程非终态，并保留未知工具审计而不重启 Runtime', async t => {
  const f = await fixture(t);
  for (const state of ['BLOCKED', 'INTERRUPTED', 'PAUSED', 'FAILED'] as const) {
    const id = `session-${state}`; f.add(id);
    if (state !== 'BLOCKED') f.running(id);
    f.store.transitionTaskLifecycle({ sessionId: f.sessionId, taskId: id, expectedStateVersion: f.current(id).stateVersion!, dimension: 'execution', to: state, actor: 'test-fixture', reason: `${TASK_GOVERNANCE_BLOCKED_PREFIX} 会话终止样本` });
  }
  f.store.appendTaskAuditEvent(f.sessionId, 'session-INTERRUPTED', { eventType: 'tool.started', actor: 'test-fixture', payload: { callId: 'pending-on-cancel', toolName: 'read_project_file', argumentsHash: taskContentHash({}) } });
  await f.runner.cancelForSession(f.sessionId);
  assert.ok(f.store.listAgentTasks(f.sessionId).every(task => task.executionStatus === 'CANCELLED')); assert.equal(f.runtimes.length, 0);
  const audit = f.store.getTaskAuditSnapshot(f.sessionId, 'session-INTERRUPTED');
  assert.equal(audit.pendingToolCalls.length, 0); assert.ok(audit.toolEvents.some(event => event.eventType === 'tool.unknown_outcome'));
  f.runner.refreshSchedule(); assert.ok(f.store.listAgentTasks(f.sessionId).every(task => task.executionStatus === 'CANCELLED'));
});

test('历史 legacy BLOCKED 任务仍保持原来的拒绝取消行为', async t => {
  const f = await fixture(t); f.add('legacy-blocked', {}, true);
  f.store.saveAgentTasksForSession(f.sessionId, f.store.listAgentTasks(f.sessionId).map(task => ({ ...task, status: 'BLOCKED' as const })));
  await assert.rejects(f.runner.cancel(f.sessionId, 'legacy-blocked'), /任务已结束/);
  assert.equal(f.current('legacy-blocked').status, 'BLOCKED'); assert.equal(f.runtimes.length, 0);
});

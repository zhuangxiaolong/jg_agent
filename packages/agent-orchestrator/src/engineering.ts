import { createHash } from 'node:crypto';
import type { AgentTask, AgentTaskStatus, TaskContract, TaskEvidenceRecord, TaskExecutionStatus, TaskLifecycleEvent, TaskLifecycleTransition, TaskPermission } from '../../domain/src';

export const DEFAULT_TASK_BUDGET = { maxConcurrentAgents: 3, maxAgentDepth: 1, maxTotalAgentsPerTask: 20, maxRuntimeMinutes: 30, maxModelRequests: 80, maxToolCalls: 120, maxRetriesPerTask: 0 };
const PERMISSIONS: TaskPermission[] = ['read_project', 'write_workspace', 'execute_command', 'access_network', 'install_dependency', 'read_secrets', 'database_read', 'database_write', 'git_commit', 'git_push', 'git_merge', 'delete_files'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/i;

export function stableTaskJson(value: unknown): string {
  function order(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(order);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, order(value)]));
    return item;
  }
  return JSON.stringify(order(value));
}
export function taskContentHash(value: unknown): string { return createHash('sha256').update(stableTaskJson(value)).digest('hex'); }
export function verifyTaskLifecycleEventChain(events: readonly TaskLifecycleEvent[]): boolean {
  let previousHash = '0'.repeat(64); let previousVersion = 0;
  for (const event of events) {
    const { contentHash, ...unsigned } = event;
    if (event.previousHash !== previousHash || !HASH.test(contentHash) || taskContentHash(unsigned) !== contentHash || !Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion <= previousVersion || event.taskId !== events[0].taskId || event.sessionId !== events[0].sessionId) return false;
    previousHash = contentHash; previousVersion = event.aggregateVersion;
  }
  return true;
}
export function assertTaskSafeMetadata(value: unknown): void {
  const sensitiveKeys = new Set(['apikey', 'accesstoken', 'refreshtoken', 'password', 'passwd', 'secret', 'secrets', 'authorization', 'cookie', 'webhook', 'webhookurl', 'privatekey', 'clientsecret', 'env', 'rawargs', 'rawarguments', 'rawresult']);
  const inspect = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(inspect); return; }
    if (item && typeof item === 'object') for (const [key, nested] of Object.entries(item)) {
      if (sensitiveKeys.has(key.replace(/[_-]/g, '').toLowerCase())) throw new Error('任务元数据不能包含秘密或原始敏感参数，请使用受控引用');
      inspect(nested);
    }
  };
  inspect(value);
  const encoded = stableTaskJson(value);
  if (encoded.length > 256000) throw new Error('任务元数据超过容量限制');
  if (/(?:\bBearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*["']?\s*[:=]\s*["']?[^\s"',;}]{6,}|qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=)/i.test(encoded)) throw new Error('任务元数据可能包含秘密，请使用受控配置引用');
}
function strings(value: unknown, name: string, required = false): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 200 || required && value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 4000)) throw new Error(`${name}格式无效`);
}
function text(value: unknown, name: string, maximum = 20000): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${name}格式无效`);
}
export function validateTaskContract(contract: TaskContract): TaskContract {
  if (!contract || !ID.test(contract.taskId) || !ID.test(contract.sessionId) || contract.projectId !== undefined && !ID.test(contract.projectId) || contract.parentTaskId !== undefined && !ID.test(contract.parentTaskId)) throw new Error('任务契约标识无效');
  if (!['codex', 'jinggong', 'claude_agent_sdk'].includes(contract.runtimeKind)) throw new Error('任务契约 Runtime 无效');
  if (!Number.isSafeInteger(contract.contractVersion) || contract.contractVersion < 1) throw new Error('任务契约版本无效');
  text(contract.title, '任务标题', 120); text(contract.goal, '任务目标'); text(contract.description, '任务描述');
  text(contract.createdBy, '契约创建者', 128); text(contract.permissionProfile, '权限配置', 128);
  if (Number.isNaN(Date.parse(contract.createdAt))) throw new Error('契约时间无效');
  if (!['analysis', 'design', 'implementation', 'review', 'test', 'documentation', 'integration', 'other'].includes(contract.taskType)) throw new Error('任务类型无效');
  if (!Array.isArray(contract.inputRefs) || contract.inputRefs.length > 200 || contract.inputRefs.some(item => !item || typeof item.type !== 'string' || !item.type || item.type.length > 100 || typeof item.ref !== 'string' || !item.ref || item.ref.length > 4000)) throw new Error('任务输入引用无效');
  strings(contract.outputExpectations, '期望交付', true); strings(contract.acceptanceCriteria, '验收标准', true);
  strings(contract.allowedTools, '允许工具'); strings(contract.permissions, '任务权限');
  if (contract.permissions.some(value => !PERMISSIONS.includes(value))) throw new Error('任务权限无效');
  strings(contract.allowedPaths, '允许路径'); strings(contract.deniedPaths, '禁止路径');
  for (const pattern of [...contract.allowedPaths, ...contract.deniedPaths]) if (pattern.startsWith('/') || pattern.includes('\\') || pattern.includes(':') || pattern.split('/').some(part => part === '..' || part === '.') || pattern.includes('\0')) throw new Error('任务路径规则必须为相对路径，不能包含越界路径');
  if (!['shared_readonly', 'isolated_worktree', 'no_workspace'].includes(contract.workspacePolicy)) throw new Error('任务工作区策略无效');
  if (contract.permissions.includes('write_workspace') && (contract.workspacePolicy !== 'isolated_worktree' || !contract.projectId)) throw new Error('写入型任务必须使用绑定项目的隔离工作区');
  if (contract.workspacePolicy !== 'isolated_worktree' && contract.permissions.some(permission => ['write_workspace', 'execute_command', 'install_dependency', 'database_write', 'git_commit', 'git_push', 'git_merge', 'delete_files'].includes(permission))) throw new Error('只读任务不能申请具有副作用的权限');
  if (!Array.isArray(contract.dependencies) || contract.dependencies.length > 100 || new Set(contract.dependencies.map(item => item.taskId)).size !== contract.dependencies.length || contract.dependencies.some(item => !item || !ID.test(item.taskId) || item.taskId === contract.taskId || !['completed', 'verified', 'accepted'].includes(item.condition))) throw new Error('契约依赖无效');
  if (!contract.modelPolicy || !['inherit', 'specified'].includes(contract.modelPolicy.kind) || contract.modelPolicy.kind === 'specified' && !contract.modelPolicy.model?.trim()) throw new Error('模型策略无效');
  const policy = contract.budgetPolicy;
  if (!policy || typeof policy !== 'object') throw new Error('任务预算无效');
  const bounds = { maxConcurrentAgents: [1, 100], maxAgentDepth: [0, 10], maxTotalAgentsPerTask: [1, 100], maxRuntimeMinutes: [1, 1440], maxModelRequests: [1, 100000], maxToolCalls: [1, 100000], maxRetriesPerTask: [0, 10] };
  for (const [key, [min, max]] of Object.entries(bounds)) { const value = policy[key as keyof typeof bounds]; if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`任务预算 ${key} 无效`); }
  for (const key of ['maxInputTokens', 'maxOutputTokens'] as const) if (policy[key] !== undefined && (!Number.isSafeInteger(policy[key]) || policy[key]! < 1)) throw new Error(`任务预算 ${key} 无效`);
  if (policy.maxCostAmount !== undefined && (!Number.isFinite(policy.maxCostAmount) || policy.maxCostAmount <= 0 || !/^[A-Z]{3}$/.test(policy.currency ?? ''))) throw new Error('费用预算必须包含正数金额和币种');
  assertTaskSafeMetadata(contract);
  return JSON.parse(JSON.stringify(contract)) as TaskContract;
}

export function createTaskContract(task: AgentTask, overrides: Partial<TaskContract> = {}): TaskContract {
  if (task.workspaceMode === 'worktree' && !overrides.acceptanceCriteria?.length) throw new Error('开发任务必须显式提供验收标准');
  const contract: TaskContract = {
    taskId: task.id, sessionId: task.sessionId, projectId: task.projectId, runtimeKind: task.runtimeKind ?? 'codex', parentTaskId: task.parentTaskId,
    contractVersion: (task.contractVersion ?? 0) + 1, title: task.name, goal: task.description, description: task.description,
    taskType: task.workspaceMode === 'worktree' ? 'implementation' : 'analysis', inputRefs: [],
    outputExpectations: ['提供任务结论、证据引用与未解决问题'], acceptanceCriteria: ['提供可检查的分析结论，并明确说明证据和未覆盖项'],
    allowedTools: ['read_project'], permissions: ['read_project'], permissionProfile: 'readonly',
    allowedPaths: ['**'], deniedPaths: ['.env', '.env.*', '**/.env', '**/.env.*', '**/secrets/**', '.git/**'],
    dependencies: task.dependencyIds.map(taskId => ({ taskId, condition: 'completed' })),
    workspacePolicy: task.workspaceMode === 'worktree' ? 'isolated_worktree' : task.projectId ? 'shared_readonly' : 'no_workspace',
    modelPolicy: { kind: 'inherit' }, budgetPolicy: { ...DEFAULT_TASK_BUDGET, maxRuntimeMinutes: Math.max(1, Math.ceil((task.timeoutMs ?? 1800000) / 60000)), maxRetriesPerTask: task.maxAttempts - 1 },
    createdBy: 'local-user', createdAt: new Date().toISOString(), ...overrides,
  };
  return validateTaskContract(contract);
}
export function executionStatusOf(task: AgentTask): TaskExecutionStatus {
  return task.executionStatus ?? (task.status === 'WAITING' ? 'PENDING' : task.status === 'PENDING' ? 'READY' : task.status);
}
export function legacyTaskStatus(status: TaskExecutionStatus): AgentTaskStatus {
  if (status === 'READY') return 'PENDING';
  if (status === 'PENDING') return 'WAITING';
  if (status === 'PAUSED' || status === 'INTERRUPTED') return 'BLOCKED';
  return status;
}
export function taskDependenciesSatisfied(task: AgentTask, graph: readonly AgentTask[]): boolean {
  return task.dependencyIds.every(id => {
    const dependency = graph.find(item => item.id === id);
    if (!dependency || executionStatusOf(dependency) !== 'COMPLETED') return false;
    const condition = task.dependencyConditions?.[id] ?? 'completed';
    return condition === 'completed' || condition === 'verified' && dependency.verificationStatus === 'PASSED' || condition === 'accepted' && dependency.acceptanceStatus === 'ACCEPTED';
  });
}
export function validateTaskEvidence(evidence: TaskEvidenceRecord): TaskEvidenceRecord {
  if (!evidence || !ID.test(evidence.id) || !ID.test(evidence.taskId) || !ID.test(evidence.sessionId) || !HASH.test(evidence.contentHash)) throw new Error('任务证据标识或内容Hash无效');
  if (!['build', 'test', 'typecheck', 'lint', 'git', 'manual', 'other'].includes(evidence.evidenceType) || !['runtime', 'process', 'test_runner', 'git', 'user', 'platform'].includes(evidence.source) || !['passed', 'failed', 'inconclusive'].includes(evidence.status)) throw new Error('任务证据类型或状态无效');
  if (Number.isNaN(Date.parse(evidence.startedAt)) || Number.isNaN(Date.parse(evidence.finishedAt)) || Number.isNaN(Date.parse(evidence.createdAt)) || Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt) || !Number.isFinite(evidence.durationMs) || evidence.durationMs < 0) throw new Error('任务证据时间无效');
  if (evidence.exitCode !== null && !Number.isInteger(evidence.exitCode)) throw new Error('任务证据退出码无效');
  if (typeof evidence.integrityVerified !== 'boolean') throw new Error('任务证据完整性标记无效');
  text(evidence.workingDirectory, '证据工作目录', 4000);
  if (evidence.contractVersion !== undefined && (!Number.isSafeInteger(evidence.contractVersion) || evidence.contractVersion < 1)) throw new Error('证据契约版本无效');
  if (evidence.status === 'passed' && (!['process', 'test_runner'].includes(evidence.source) || !['build', 'test', 'typecheck', 'lint'].includes(evidence.evidenceType) || evidence.exitCode !== 0 || !evidence.integrityVerified || !HASH.test(evidence.codeFingerprint ?? '') || !evidence.logRef || !evidence.manifestRef)) throw new Error('通过证据必须来自真实执行器，包含有效日志、Manifest、代码指纹和完整性校验');
  if (evidence.status === 'passed') { text(evidence.command, '真实执行命令', 4000); text(evidence.logRef, '日志引用', 4000); text(evidence.manifestRef, 'Manifest 引用', 4000); }
  if (evidence.status === 'passed' && evidence.evidenceType === 'test' && (!Number.isSafeInteger(evidence.testCount) || evidence.testCount! < 1 || !evidence.reportRef)) throw new Error('测试通过证据必须包含非空真实测试报告');
  if (evidence.status === 'passed' && evidence.evidenceType === 'test') text(evidence.reportRef, '真实测试报告引用', 4000);
  assertTaskSafeMetadata(evidence);
  return JSON.parse(JSON.stringify(evidence)) as TaskEvidenceRecord;
}

const EXECUTION_TRANSITIONS: Record<TaskExecutionStatus, TaskExecutionStatus[]> = {
  PENDING: ['READY', 'BLOCKED', 'CANCELLED'], READY: ['RUNNING', 'PENDING', 'BLOCKED', 'CANCELLED'],
  RUNNING: ['PAUSED', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  PAUSED: ['READY', 'RUNNING', 'CANCELLED', 'INTERRUPTED'], BLOCKED: ['READY', 'RUNNING', 'PENDING', 'CANCELLED', 'INTERRUPTED'],
  INTERRUPTED: ['READY', 'CANCELLED', 'BLOCKED'], FAILED: ['READY', 'CANCELLED'], COMPLETED: [], CANCELLED: [],
};
export function applyTaskLifecycleTransition(task: AgentTask, input: TaskLifecycleTransition, evidence: readonly TaskEvidenceRecord[]): AgentTask {
  text(input.actor, '操作者', 128);
  if (!task.contractVersion) throw new Error('历史任务没有任务契约，请先建立契约，不能补造验证状态');
  if (task.id !== input.taskId || task.sessionId !== input.sessionId || (task.stateVersion ?? 0) !== input.expectedStateVersion) throw new Error('任务状态版本已变化，请刷新后重试');
  const next: AgentTask = { ...task, updatedAt: new Date().toISOString(), stateVersion: (task.stateVersion ?? 0) + 1 };
  if (input.dimension === 'execution') {
    const current = executionStatusOf(task);
    if (!EXECUTION_TRANSITIONS[current].includes(input.to as TaskExecutionStatus)) throw new Error(`不允许的执行状态迁移：${current} -> ${input.to}`);
    next.executionStatus = input.to as TaskExecutionStatus; next.status = legacyTaskStatus(next.executionStatus);
    if (next.executionStatus === 'READY' && task.attempt >= task.maxAttempts) throw new Error('任务已达到最大尝试次数');
    if (next.executionStatus === 'RUNNING') { next.startedAt = next.updatedAt; if (current !== 'PAUSED' && current !== 'BLOCKED') next.attempt += 1; }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(next.executionStatus)) next.completedAt = next.updatedAt;
    if (input.reason) next.error = input.reason;
  } else if (input.dimension === 'verification') {
    const allowed = { NOT_STARTED: ['RUNNING', 'NOT_REQUIRED', 'INCONCLUSIVE'], RUNNING: ['PASSED', 'FAILED', 'PARTIAL', 'INCONCLUSIVE'], PASSED: ['RUNNING', 'INCONCLUSIVE'], FAILED: ['RUNNING', 'INCONCLUSIVE'], PARTIAL: ['RUNNING', 'INCONCLUSIVE'], INCONCLUSIVE: ['RUNNING', 'NOT_REQUIRED'], NOT_REQUIRED: ['RUNNING', 'INCONCLUSIVE'] };
    if (!(allowed[task.verificationStatus ?? 'NOT_STARTED'] as string[]).includes(input.to)) throw new Error('不允许的验证状态迁移');
    if (input.to === 'NOT_REQUIRED' && !input.reason?.trim()) throw new Error('无需验证必须记录原因与策略来源');
    const selected = evidence.filter(item => input.evidenceIds?.includes(item.id));
    if (input.evidenceIds && (!Array.isArray(input.evidenceIds) || selected.length !== new Set(input.evidenceIds).size || selected.some(item => item.taskId !== task.id || item.sessionId !== task.sessionId || item.contractVersion !== task.contractVersion))) throw new Error('验证证据引用必须属于当前任务及契约');
    if (input.to === 'PASSED') {
      for (const item of selected) validateTaskEvidence(item);
      if (executionStatusOf(task) !== 'COMPLETED' || !input.evidenceIds?.length || selected.length !== new Set(input.evidenceIds).size || selected.some(item => item.taskId !== task.id || item.sessionId !== task.sessionId || item.contractVersion !== task.contractVersion || item.status !== 'passed' || !item.integrityVerified) || new Set(selected.map(item => item.codeFingerprint)).size !== 1) throw new Error('验证通过需要当前代码版本及契约的真实完整证据，不能根据 Agent 自报通过');
    }
    next.verificationStatus = input.to as AgentTask['verificationStatus'];
    if (input.reason) next.verificationReason = input.reason;
    if (input.evidenceIds) next.evidenceIds = [...new Set(input.evidenceIds)];
    if (input.to === 'NOT_REQUIRED') next.evidenceIds = [];
    if (task.acceptanceStatus === 'ACCEPTED') { next.acceptanceStatus = 'PENDING_REVIEW'; next.acceptance = undefined; }
  } else if (input.dimension === 'acceptance') {
    const allowed = { NOT_SUBMITTED: ['PENDING_REVIEW', 'NOT_REQUIRED'], PENDING_REVIEW: ['ACCEPTED', 'REJECTED'], ACCEPTED: ['PENDING_REVIEW'], REJECTED: ['PENDING_REVIEW'], NOT_REQUIRED: ['PENDING_REVIEW'] };
    if (!(allowed[task.acceptanceStatus ?? 'NOT_SUBMITTED'] as string[]).includes(input.to)) throw new Error('不允许的验收状态迁移');
    if (input.to === 'NOT_REQUIRED' && !input.reason?.trim()) throw new Error('无需验收必须记录原因与策略来源');
    if (input.to === 'ACCEPTED') {
      const acceptance = input.acceptance;
      if (executionStatusOf(task) !== 'COMPLETED' || !['PASSED', 'NOT_REQUIRED'].includes(task.verificationStatus ?? '') || !acceptance || acceptance.reviewer !== input.actor || !acceptance.comment?.trim() || !acceptance.codeRef?.trim() || acceptance.contractVersion !== task.contractVersion || Number.isNaN(Date.parse(acceptance.reviewedAt)) || !Array.isArray(acceptance.evidenceIds) || acceptance.evidenceIds.some(id => !evidence.some(item => item.id === id && item.contractVersion === task.contractVersion && task.evidenceIds?.includes(id))) || task.verificationStatus === 'PASSED' && !acceptance.evidenceIds.length) throw new Error('人工验收需授权人员、意见、当前代码版本和对应契约/证据版本');
      next.acceptance = JSON.parse(JSON.stringify(acceptance));
    }
    next.acceptanceStatus = input.to as AgentTask['acceptanceStatus'];
    if (input.reason) next.acceptanceReason = input.reason;
  } else throw new Error('任务状态维度无效');
  assertTaskSafeMetadata(input);
  return next;
}

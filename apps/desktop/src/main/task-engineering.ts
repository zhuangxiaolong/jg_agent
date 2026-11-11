import { z } from 'zod';
import type { AgentTask, Session, TaskBudgetPolicy, TaskEngineeringDetail, TaskEvidenceRecord } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { createTaskContract, executionStatusOf, taskContentHash } from '../../../../packages/agent-orchestrator/src';
import { resolveTaskBudgetPolicy, runtimeCapabilityMatrix } from '../../../../packages/agent-orchestrator/src/governance';
import { resolveTaskVerification } from './task-evidence';
import { currentWorkspaceFingerprint } from './verification-service';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const target = { sessionId: id, taskId: id };
const version = z.number().int().min(0);
const transition = { ...target, expectedStateVersion: version };
const actor = 'local-user';
const text = z.string().trim().min(1).max(4000);

export class TaskEngineeringService {
  constructor(private readonly store: LocalStore, private readonly evidenceRoot: string) {}

  private context(sessionId: string, taskId: string): { session: Session; task: AgentTask } {
    const session = this.store.listSessions().find(item => item.id === id.parse(sessionId));
    const task = this.store.listAgentTasks(sessionId).find(item => item.id === id.parse(taskId));
    if (!session || !task || session.projectId !== task.projectId) throw new Error('工程任务不存在或不属于当前会话');
    return { session, task };
  }

  detail(sessionId: string, taskId: string): TaskEngineeringDetail {
    const { task } = this.context(sessionId, taskId);
    const contracts = this.store.getAgentTaskContractVersions(sessionId, taskId);
    const events = this.store.listTaskLifecycleEvents(sessionId, taskId);
    const contract = contracts.at(-1)?.contract;
    let parentBudget: TaskBudgetPolicy | undefined;
    let budgetUnavailable = false;
    let parentId = task.parentTaskId;
    const seen = new Set([task.id]);
    while (contract && parentId) {
      if (seen.has(parentId)) throw new Error('任务父链存在循环，无法核对有效预算');
      seen.add(parentId);
      const parent = this.store.getAgentTaskContractVersions(sessionId, parentId).at(-1)?.contract;
      if (!parent) { budgetUnavailable = true; break; }
      parentBudget = { ...resolveTaskBudgetPolicy({ parent: parentBudget, task: parent.budgetPolicy }).policy };
      parentId = parent.parentTaskId;
    }
    const audit = contract ? this.store.getTaskAuditSnapshot(sessionId, taskId) : undefined;
    const unresolved = new Set([...(audit?.pendingToolCalls ?? []), ...(audit?.toolEvents.filter(event => event.eventType === 'tool.unknown_outcome') ?? [])].map(event => String(event.payload.callId ?? event.correlationId))).size;
    return { task, contracts, events, evidence: this.store.listTaskEvidence(sessionId, taskId), governance: {
      capabilities: runtimeCapabilityMatrix(contract?.runtimeKind ?? task.runtimeKind ?? 'codex'),
      ...(contract && !budgetUnavailable ? { budget: resolveTaskBudgetPolicy({ task: contract.budgetPolicy, parent: parentBudget }) } : {}),
      platformModelTurns: events.filter(event => event.eventType === 'model.turn_started').length,
      platformToolCalls: events.filter(event => event.eventType === 'tool.started').length,
      nativeModelRequests: 'unknown', nativeToolCalls: 'unknown', tokenUsage: 'unknown', costUsage: 'unknown',
      unresolvedToolCalls: unresolved,
      recoveryNotes: [
        ...(budgetUnavailable ? ['父任务缺少契约，无法计算有效预算；不能按缺失值放宽执行上限。'] : []),
        ...(executionStatusOf(task) === 'INTERRUPTED' ? ['上次执行已中断，原工具调用不会自动重放；继续需要本机用户确认。'] : []),
        ...(unresolved ? [`有 ${unresolved} 次工具调用结果未知，需先人工核对实际副作用。`] : []),
        ...(task.attempt >= task.maxAttempts ? ['已达到契约允许的尝试次数，不能通过恢复操作清零预算。'] : []),
        ...(!contract ? ['历史任务尚未建立工程契约，不能宣称已受严格预算和工具网关保护。'] : []),
      ],
    } };
  }

  async inspect(sessionId: string, taskId: string): Promise<TaskEngineeringDetail> {
    const detail = this.detail(sessionId, taskId);
    const { session, task } = this.context(sessionId, taskId);
    const evidenceIds = new Set(task.evidenceIds ?? []);
    if (!evidenceIds.size) return { ...detail, evidenceFreshness: { status: 'not_checked' } };
    const selected = detail.evidence.filter(record => evidenceIds.has(record.id));
    const result = (status: 'current' | 'stale' | 'unavailable', reason?: string): TaskEngineeringDetail => {
      const latest = this.detail(sessionId, taskId);
      const current = this.context(sessionId, taskId);
      if (latest.task.stateVersion !== task.stateVersion || latest.task.contractVersion !== task.contractVersion || current.session.workspacePath !== session.workspacePath || latest.task.workspacePath !== task.workspacePath) return { ...latest, evidenceFreshness: { status: 'unavailable', checkedAt: new Date().toISOString(), reason: '复核期间任务或工作区已变化，请刷新后重试' } };
      return { ...latest, evidenceFreshness: { status, checkedAt: new Date().toISOString(), ...(reason ? { reason } : {}) } };
    };
    if (selected.length !== evidenceIds.size) return result('unavailable', '当前活动证据记录不完整，无法复核');
    try {
      const fingerprint = await currentWorkspaceFingerprint(task.workspacePath ?? session.workspacePath);
      for (const record of selected) {
        if (record.contractVersion !== task.contractVersion || record.codeFingerprint !== fingerprint) return result('stale', '证据与当前任务契约或代码版本不一致，请重新验证');
        const runId = record.manifestRef?.split('/').at(-2);
        if (!runId) return result('unavailable', '当前证据缺少有效执行引用，无法复核');
        const resolved = await this.trustedVerification(session, task, runId);
        if (resolved.status !== 'PASSED' || resolved.contentHash !== record.contentHash || resolved.currentFingerprint !== fingerprint) return result('stale', '当前证据结果或代码版本已经变化，请重新验证');
      }
      return result('current');
    } catch {
      return result('unavailable', '当前证据文件、执行登记或工作区无法完成复核，请重新验证');
    }
  }

  private async trustedVerification(session: Session, task: AgentTask, runId: string) {
    const resolved = await resolveTaskVerification(this.evidenceRoot, session, task, runId);
    const execution = this.store.getVerificationExecution(session.id, runId);
    if (!execution || execution.projectId !== task.projectId || execution.recordHash !== taskContentHash(resolved.record) || execution.manifestHash !== taskContentHash(resolved.manifest)) throw new Error('验证缺少平台真实执行登记或元数据已经变化，请重新执行验证');
    return resolved;
  }

  revise(value: unknown): TaskEngineeringDetail {
    const input = z.object({ ...target, expectedContractVersion: version, goal: z.string().trim().min(1).max(20000), outputExpectations: z.array(text).min(1).max(100), acceptanceCriteria: z.array(text).min(1).max(100) }).strict().parse(value);
    const { task } = this.context(input.sessionId, input.taskId);
    if (['RUNNING', 'PAUSED'].includes(executionStatusOf(task))) throw new Error('请先停止当前执行，再修改任务契约');
    const previous = this.store.getAgentTaskContractVersions(task.sessionId, task.id).at(-1)?.contract;
    const contract = createTaskContract(task, { ...previous, contractVersion: (task.contractVersion ?? 0) + 1, goal: input.goal, outputExpectations: input.outputExpectations, acceptanceCriteria: input.acceptanceCriteria, createdBy: actor, createdAt: new Date().toISOString() });
    this.store.saveAgentTaskContract(task, contract, input.expectedContractVersion, actor);
    return this.detail(task.sessionId, task.id);
  }

  async linkVerification(value: unknown): Promise<TaskEngineeringDetail> {
    const input = z.object({ ...transition, runId: id }).strict().parse(value);
    const { session, task } = this.context(input.sessionId, input.taskId);
    if (task.stateVersion !== input.expectedStateVersion) throw new Error('任务状态已变化，请刷新后重试');
    if (executionStatusOf(task) !== 'COMPLETED') throw new Error('任务执行完成后才能关联最终验证');
    const resolved = await this.trustedVerification(session, task, input.runId);
    const contract = this.store.getAgentTaskContractVersions(task.sessionId, task.id).at(-1);
    if (!contract || Date.parse(resolved.record.startedAt) < Date.parse(contract.createdAt)) throw new Error('验证早于当前契约，请按新契约重新执行验证');
    if (this.context(task.sessionId, task.id).task.stateVersion !== input.expectedStateVersion) throw new Error('验证期间任务状态已变化，请刷新后重试');
    const run = resolved.record;
    const evidence: TaskEvidenceRecord = {
      id: `verification-${taskContentHash({ sessionId: task.sessionId, taskId: task.id, runId: run.runId, contractVersion: task.contractVersion, observedStatus: resolved.status, currentFingerprint: resolved.currentFingerprint })}`, taskId: task.id, sessionId: task.sessionId, projectId: task.projectId, contractVersion: task.contractVersion,
      evidenceType: run.runType === 'custom' ? 'other' : run.runType, source: run.runType === 'test' ? 'test_runner' : 'process',
      status: resolved.status === 'PASSED' ? 'passed' : resolved.status === 'FAILED' ? 'failed' : 'inconclusive',
      command: [run.executable, ...run.args].join(' '), workingDirectory: run.cwd, runtimeVersion: session.runtimeVersion,
      startedAt: run.startedAt, finishedAt: run.finishedAt, durationMs: run.durationMs, exitCode: run.exitCode,
      logRef: resolved.logRef, artifactRef: resolved.artifactRef, manifestRef: `${task.projectId}/${task.sessionId}/${run.runId}/manifest.json`,
      commitSha: run.headSha, codeFingerprint: run.fingerprintAfter, contentHash: resolved.contentHash, createdAt: new Date().toISOString(), integrityVerified: true,
      ...(run.testReport ? { testCount: run.testReport.total, reportRef: resolved.artifactRef } : {}), limitations: run.limitations,
    };
    const existing = this.store.listTaskEvidence(task.sessionId, task.id).find(item => item.id === evidence.id);
    if (existing && existing.contentHash !== evidence.contentHash) throw new Error('同一运行的证据内容已变化，请检查原始制品');
    if (!existing) this.store.appendTaskEvidence(task.sessionId, task.id, evidence);
    const current = this.context(task.sessionId, task.id).task;
    this.store.finalizeTaskVerification({ ...targetOf(task), expectedStateVersion: current.stateVersion ?? 0, dimension: 'verification', to: resolved.status, actor, evidenceIds: [evidence.id], reason: resolved.status === 'INCONCLUSIVE' ? '证据不完整、进程结果不确定或当前代码已变化' : '真实执行结果与当前代码指纹复核完成' });
    return this.detail(task.sessionId, task.id);
  }

  submitAcceptance(value: unknown): TaskEngineeringDetail {
    const input = z.object(transition).strict().parse(value);
    const { task } = this.context(input.sessionId, input.taskId);
    if (executionStatusOf(task) !== 'COMPLETED') throw new Error('执行完成后才能提交人工验收');
    this.store.transitionTaskLifecycle({ ...input, dimension: 'acceptance', to: 'PENDING_REVIEW', actor, reason: '本机用户提交人工验收' });
    return this.detail(task.sessionId, task.id);
  }

  async resolveAcceptance(value: unknown): Promise<TaskEngineeringDetail> {
    const input = z.object({ ...transition, decision: z.enum(['accept', 'reject']), comment: text }).strict().parse(value);
    const { session, task } = this.context(input.sessionId, input.taskId);
    if (input.decision === 'reject') {
      this.store.transitionTaskLifecycle({ ...targetOf(task), expectedStateVersion: input.expectedStateVersion, dimension: 'acceptance', to: 'REJECTED', actor, reason: input.comment });
    } else {
      if (task.verificationStatus !== 'PASSED') throw new Error('尚无当前代码的真实通过证据，不能验收通过');
      const evidence = this.store.listTaskEvidence(task.sessionId, task.id).filter(item => task.evidenceIds?.includes(item.id));
      if (!evidence.length) throw new Error('任务缺少已关联证据');
      const currentFingerprint = await currentWorkspaceFingerprint(task.workspacePath ?? session.workspacePath);
      for (const record of evidence) {
        const runId = record.manifestRef?.split('/').at(-2);
        if (!runId || record.contractVersion !== task.contractVersion) throw new Error('证据与当前任务契约版本不一致');
        const resolved = await this.trustedVerification(session, task, runId);
        if (resolved.status !== 'PASSED' || resolved.contentHash !== record.contentHash || record.codeFingerprint !== currentFingerprint) throw new Error('证据已经过期或变化，请重新验证后再验收');
      }
      this.store.transitionTaskLifecycle({ ...targetOf(task), expectedStateVersion: input.expectedStateVersion, dimension: 'acceptance', to: 'ACCEPTED', actor, acceptance: { reviewer: actor, comment: input.comment, codeRef: currentFingerprint, evidenceIds: evidence.map(item => item.id), contractVersion: task.contractVersion!, reviewedAt: new Date().toISOString() } });
    }
    return this.detail(task.sessionId, task.id);
  }

  resume(value: unknown): TaskEngineeringDetail {
    const input = z.object(transition).strict().parse(value);
    const { task } = this.context(input.sessionId, input.taskId);
    if (executionStatusOf(task) !== 'INTERRUPTED' || task.workspaceMode !== 'read') throw new Error('当前仅支持人工恢复中断的只读任务；不会重放原工具调用');
    if (task.attempt >= task.maxAttempts) throw new Error('任务尝试预算已耗尽，不能通过恢复操作清零预算');
    const audit = this.store.getTaskAuditSnapshot(task.sessionId, task.id);
    if (audit.pendingToolCalls.length || audit.toolEvents.some(event => event.eventType === 'tool.unknown_outcome')) throw new Error('存在结果未知的工具调用，请先人工核对副作用；当前禁止恢复');
    this.store.transitionTaskLifecycle({ ...input, dimension: 'execution', to: 'READY', actor, reason: '本机用户明确恢复中断任务，重新启动一次执行，不重放工具调用' });
    return this.detail(task.sessionId, task.id);
  }
}

function targetOf(task: AgentTask) { return { sessionId: task.sessionId, taskId: task.id }; }

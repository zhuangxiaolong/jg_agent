import { useEffect, useState } from 'react';
import type { AgentTask, TaskEngineeringApi, TaskEngineeringDetail } from '../../../../packages/domain/src';
import { TaskWorkspacePanel } from './TaskWorkspacePanel';

const executionLabels: Record<string, string> = { PENDING: '等待依赖', READY: '待执行', RUNNING: '运行中', PAUSED: '已暂停', BLOCKED: '已阻塞', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断' };
const verificationLabels: Record<string, string> = { NOT_STARTED: '未验证', NOT_REQUIRED: '无需验证', RUNNING: '验证中', PASSED: '已验证通过', FAILED: '验证失败', PARTIAL: '部分通过', INCONCLUSIVE: '无法判定' };
const acceptanceLabels: Record<string, string> = { NOT_SUBMITTED: '未提交', PENDING_REVIEW: '待人工验收', ACCEPTED: '人工已接受', REJECTED: '人工已退回', NOT_REQUIRED: '无需验收' };
const workspacePolicyLabels: Record<string, string> = { shared_readonly: '共享项目目录', isolated_worktree: '独立项目目录', no_workspace: '不关联项目目录' };
const permissionLabels: Record<string, string> = { read_project: '读取项目', write_workspace: '写入项目目录', execute_command: '执行命令', access_network: '访问网络', install_dependency: '安装依赖', read_secrets: '读取凭据', database_read: '读取数据库', database_write: '写入数据库', git_commit: '提交 Git', git_push: '推送 Git', git_merge: '合并 Git', delete_files: '删除文件' };

export function TaskEngineeringPanel({ api, task, onChange, onError }: { api: TaskEngineeringApi; task: AgentTask; onChange: () => Promise<void>; onError: (text: string) => void }) {
  const [detail, setDetail] = useState<TaskEngineeringDetail>();
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState('');
  const [outputs, setOutputs] = useState('');
  const [criteria, setCriteria] = useState('');
  const [runId, setRunId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  useEffect(() => {
    let live = true;
    setDetail(undefined); setEditing(false); setRunId(''); setComment('');
    void api.detail(task.sessionId, task.id).then(value => { if (live) setDetail(value); }).catch(error => { if (live) onError(String(error)); });
    return () => { live = false; };
  }, [api, task.id, task.stateVersion, task.contractVersion]);
  const current = detail?.task ?? task;
  const contract = detail?.contracts.at(-1)?.contract;
  const governance = detail?.governance;
  const freshness = detail?.evidenceFreshness;
  const evidenceCurrent = freshness?.status === 'current';
  const target = { sessionId: current.sessionId, taskId: current.id, expectedStateVersion: current.stateVersion ?? 0 };
  async function act(action: () => Promise<TaskEngineeringDetail>) {
    setBusy(true);
    try { const result = await action(); setDetail(await api.detail(result.task.sessionId, result.task.id)); setEditing(false); await onChange(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function beginEdit() { setGoal(contract?.goal ?? task.description); setOutputs(contract?.outputExpectations.join('\n') ?? '提供任务结论和证据'); setCriteria(contract?.acceptanceCriteria.join('\n') ?? '结论有可检查的证据和未覆盖项'); setEditing(true); }
  const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
  return <section className="task-engineering" aria-label="工程任务契约与证据">
    <div className="task-state-dimensions"><span>执行：{executionLabels[current.executionStatus ?? current.status] ?? current.status}</span><span>验证：{current.verificationStatus === 'PASSED' && !evidenceCurrent ? '历史通过，当前证据待复核' : verificationLabels[current.verificationStatus ?? 'NOT_STARTED']}</span><span>验收：{current.acceptanceStatus === 'ACCEPTED' && !evidenceCurrent ? '历史已接受，当前证据待复核' : acceptanceLabels[current.acceptanceStatus ?? 'NOT_SUBMITTED']}</span></div>
    {freshness && ['stale', 'unavailable'].includes(freshness.status) && <p role="status">当前证据{freshness.status === 'stale' ? '已失效' : '无法复核'}：{freshness.reason}；已保存的历史状态保留用于审计，请重新执行验证。</p>}
    <small>以上为已记录状态；人工验收时重新核对当前代码和原始证据。Agent 执行完成不等于验证或验收通过。</small>
    {current.error && <p role="status">{current.error.replace('[TASK_GOVERNANCE_BLOCKED]', '')}</p>}
    {governance && <details><summary>Runtime 能力、预算与恢复</summary>
      {governance.budget && <small>有效预算（取父任务与当前任务的较小值）：并发 {governance.budget.policy.maxConcurrentAgents}；深度 {governance.budget.policy.maxAgentDepth}；Agent 总数 {governance.budget.policy.maxTotalAgentsPerTask}；时长 {governance.budget.policy.maxRuntimeMinutes} 分钟；模型请求 {governance.budget.policy.maxModelRequests}；工具调用 {governance.budget.policy.maxToolCalls}；重试 {governance.budget.policy.maxRetriesPerTask}。<br />预算来源：{Object.entries(governance.budget.sources).map(([key, values]) => `${key}=${values?.join('/')}`).join('；')}</small>}
      <p>平台已记录：{governance.platformModelTurns} 次 Turn、{governance.platformToolCalls} 次受控工具调用。原生模型请求与工具总次数：未知；Token：未知；费用：未知。</p>
      {Object.entries(governance.capabilities).map(([name, capability]) => <div className="task-evidence-item" key={name}><strong>{name}：{capability.supported === true ? '已接入' : capability.supported === 'partial' ? '部分接入' : '不支持'}</strong><small>执行层：{capability.enforcementLayer} · {capability.notes}</small></div>)}
      {governance.recoveryNotes.map(note => <p key={note}>{note}</p>)}
    </details>}
    <details><summary>任务契约 {contract ? `v${contract.contractVersion}` : '（历史任务未建立）'}</summary>
      {contract && <><p>{contract.goal}</p><strong>交付与验收标准</strong><ul>{contract.outputExpectations.map((item, index) => <li key={`o${index}`}>{item}</li>)}{contract.acceptanceCriteria.map((item, index) => <li key={`a${index}`}>{item}</li>)}</ul><small>权限：{contract.permissions.map(item => permissionLabels[item] || item).join('、')} · 目录策略：{workspacePolicyLabels[contract.workspacePolicy] || '未指定'}<br />Runtime：{contract.runtimeKind} · 运行上限 {contract.budgetPolicy.maxRuntimeMinutes} 分钟<br />允许路径：{contract.allowedPaths.join('、')}<br />禁止路径：{contract.deniedPaths.join('、')}</small></>}
      <button type="button" disabled={busy || current.status === 'RUNNING'} onClick={beginEdit}>{contract ? '修订目标与标准' : '建立历史任务契约'}</button>
      {editing && <div className="agent-task-form"><label>目标<textarea value={goal} onChange={event => setGoal(event.target.value)} rows={2} /></label><label>期望交付（每行一项）<textarea value={outputs} onChange={event => setOutputs(event.target.value)} rows={2} /></label><label>验收标准（每行一项）<textarea value={criteria} onChange={event => setCriteria(event.target.value)} rows={3} /></label><button type="button" disabled={busy || !goal.trim() || !lines(outputs).length || !lines(criteria).length} onClick={() => { void act(() => api.revise({ sessionId: current.sessionId, taskId: current.id, expectedContractVersion: current.contractVersion ?? 0, goal, outputExpectations: lines(outputs), acceptanceCriteria: lines(criteria) })); }}>保存新版本并重置验证／验收</button></div>}
    </details>
    <TaskWorkspacePanel key={current.id} api={api} task={current} onChange={async () => { setDetail(await api.detail(current.sessionId, current.id)); await onChange(); }} onError={onError} />
    {contract && current.executionStatus === 'COMPLETED' && <div className="task-evidence-actions"><label>关联真实验证 Run ID<input value={runId} onChange={event => setRunId(event.target.value)} maxLength={128} placeholder="从 Git 面板的验证记录复制" /></label><button type="button" disabled={busy || !runId.trim()} onClick={() => { void act(() => api.linkVerification({ ...target, runId: runId.trim() })); }}>复核并关联证据</button>{['NOT_SUBMITTED', 'REJECTED', 'NOT_REQUIRED'].includes(current.acceptanceStatus ?? 'NOT_SUBMITTED') && <button type="button" disabled={busy} onClick={() => { void act(() => api.submitAcceptance(target)); }}>提交人工验收</button>}{current.acceptanceStatus === 'PENDING_REVIEW' && <><label>人工验收意见<textarea value={comment} onChange={event => setComment(event.target.value)} rows={2} maxLength={4000} /></label><button type="button" disabled={busy || !comment.trim() || current.verificationStatus !== 'PASSED'} onClick={() => { void act(() => api.resolveAcceptance({ ...target, decision: 'accept', comment })); }}>本人确认验收通过</button><button type="button" disabled={busy || !comment.trim()} onClick={() => { void act(() => api.resolveAcceptance({ ...target, decision: 'reject', comment })); }}>退回</button></>}</div>}
    {current.executionStatus === 'INTERRUPTED' && <button type="button" disabled={busy || current.attempt >= current.maxAttempts || Boolean(governance?.unresolvedToolCalls)} onClick={() => { void act(() => api.resume(target)); }}>人工重新启动任务（不重放工具）</button>}
    {detail && <><div className="agent-task-events-heading">证据索引 · {detail.evidence.length} 条</div>{detail.evidence.map(item => <article key={item.id} className="task-evidence-item"><strong>{item.evidenceType} · {item.status}</strong><small>契约 v{item.contractVersion ?? '旧版'} · Exit {item.exitCode ?? '未记录'} · {item.durationMs} ms<br />{item.workingDirectory}<br />{item.command}<br />日志：{item.logRef ?? '无'}<br />代码指纹：{item.codeFingerprint ?? '无'}<br />SHA-256：{item.contentHash}</small></article>)}<button type="button" onClick={() => setShowAudit(!showAudit)}>{showAudit ? '收起' : '查看'}不可变审计事件（{detail.events.length}）</button>{showAudit && <div className="agent-task-events">{detail.events.map(item => <article key={item.id} className="task-evidence-item"><strong>#{item.aggregateVersion} {item.eventType}</strong><small>{item.createdAt} · {item.actor}<br />{item.contentHash}</small><pre>{JSON.stringify(item.payload, null, 2)}</pre></article>)}</div>}</>}
  </section>;
}

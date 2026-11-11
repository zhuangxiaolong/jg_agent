import { useEffect, useState } from 'react';
import type { AgentTask, TaskEngineeringApi, TaskWorkspaceDetail } from '../../../../packages/domain/src';

export function TaskWorkspacePanel({ api, task, onChange, onError }: { api: TaskEngineeringApi; task: AgentTask; onChange: () => Promise<void>; onError: (text: string) => void }) {
  const [value, setValue] = useState<TaskWorkspaceDetail>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    if (task.workspaceMode === 'worktree') void api.workspace?.(task.sessionId, task.id).then(detail => { if (live) setValue(current => current && current.stateVersion === detail.stateVersion && current.integration ? { ...detail, integration: current.integration } : detail); }).catch(error => { if (live) onError(String(error)); });
    return () => { live = false; };
  }, [api, task.id, task.workspacePath, task.stateVersion]);
  if (task.workspaceMode !== 'worktree' || !api.workspace) return null;
  async function act(action: () => Promise<TaskWorkspaceDetail>) {
    setBusy(true);
    try { setValue(await action()); await onChange(); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  const target = { sessionId: task.sessionId, taskId: task.id, expectedStateVersion: task.stateVersion ?? 0 };
  return <details className="task-workspace-panel"><summary>任务隔离目录与人工集成</summary>
    <p>任务目录和代码成果默认保留。预检读取真实 Git 状态，实际集成需要人工检查并操作。</p>
    {!value && <p>正在核对持久目录映射…</p>}
    {value && !value.workspace && !task.workspacePath && <button type="button" disabled={busy || !api.createWorkspace || task.status === 'RUNNING'} onClick={() => { if (api.createWorkspace) void act(() => api.createWorkspace!(target)); }}>创建独立目录</button>}
    {value?.workspace && <><small>目录：{value.workspace.path}<br />分支：{value.workspace.branch}<br />冻结基准：{value.workspace.baseCommit}<br />成果保留：是 · 检查时状态：{value.stable ? '稳定' : '发生变化，请重新检查'}</small>
      <button type="button" disabled={busy} onClick={() => { void act(() => api.workspace!(task.sessionId, task.id)); }}>刷新任务变更</button>
      <button type="button" disabled={busy || !api.prepareIntegration || task.status === 'RUNNING'} onClick={() => { if (api.prepareIntegration) void act(() => api.prepareIntegration!(target)); }}>生成人工集成预检</button>
      {value.changes?.map((change, index) => <details className="task-evidence-item" key={`${change.layer}:${change.path}:${index}`}><summary>{change.layer} · {change.status} · {change.path}{change.truncated ? '（已截断，禁止据此集成）' : ''}</summary><pre>{change.diff}</pre><small>变更 Hash：{change.contentHash}</small></details>)}
      {!value.changes?.length && <p>冻结基准以来暂无变更。</p>}
    </>}
    {value?.integration && <article className="task-evidence-item"><strong>Git 预检：{value.stateVersion !== task.stateVersion ? '任务已变化，请重新预检' : value.integration.ready ? '结构检查通过，待人工审核' : '已阻塞'}</strong><small>{value.integration.checkedAt}<br />源：{value.integration.source.branch} · {value.integration.source.head}<br />源 dirty：{String(value.integration.source.dirty)} · 内容指纹：{value.integration.source.fingerprint ?? '不可用'}<br />目标：{value.integration.target.branch} · {value.integration.target.head}<br />目标 dirty：{String(value.integration.target.dirty)} · 内容指纹：{value.integration.target.fingerprint ?? '不可用'}<br />计划指纹：{value.integration.fingerprint}</small><p>{value.integration.approvalReason}</p>{value.integration.blockers.map((blocker, index) => <p key={`${blocker.code}:${index}`}>{blocker.code}：{blocker.message}{blocker.paths?.length ? `（${blocker.paths.join('、')}）` : ''}</p>)}{value.integration.limitations.map(item => <small key={item}>{item}</small>)}</article>}
  </details>;
}

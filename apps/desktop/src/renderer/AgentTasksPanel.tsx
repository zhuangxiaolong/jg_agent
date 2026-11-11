import { useEffect, useState, type FormEvent } from 'react';
import type { AgentTask, AgentTaskEvent, AgentTaskRole, Session } from '../../../../packages/domain/src';
import type { DesktopApi } from '../../../../packages/domain/src';
import { Icon } from './ui';
import { TaskEngineeringPanel } from './TaskEngineeringPanel';

const roleLabels: Record<AgentTaskRole, string> = {
  requirement: '需求分析', architecture: '架构分析', developer: '代码分析', review: '代码审查',
  testing: '测试分析', documentation: '文档整理', custom: '自定义分析',
};
const statusLabels: Record<AgentTask['status'], string> = {
  PENDING: '等待运行', RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', WAITING: '等待依赖', BLOCKED: '已阻塞',
};

export function AgentTasksPanel({ api, session, onError }: { api: DesktopApi; session?: Session; onError: (text: string) => void }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [events, setEvents] = useState<AgentTaskEvent[]>([]);
  const [selectedTask, setSelectedTask] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AgentTaskRole>('requirement');
  const [description, setDescription] = useState('');
  const [outputs, setOutputs] = useState('');
  const [criteria, setCriteria] = useState('');
  const [input, setInput] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [maxAttempts, setMaxAttempts] = useState(1);
  const [workspaceMode, setWorkspaceMode] = useState<'read' | 'worktree'>('read');
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(true);

  async function refreshTasks(sessionId: string) {
    const rows = await api.listAgentTasks(sessionId);
    setTasks(rows);
    setSelectedTask(current => rows.some(item => item.id === current) ? current : rows[0]?.id ?? '');
  }
  useEffect(() => {
    if (!session) { setTasks([]); setEvents([]); setSelectedTask(''); return; }
    let live = true;
    void api.listAgentTasks(session.id).then(rows => {
      if (!live) return;
      setTasks(rows); setShowCreate(rows.length === 0); setSelectedTask(current => rows.some(item => item.id === current) ? current : rows[0]?.id ?? '');
    }).catch(error => { if (live) onError(error instanceof Error ? error.message : String(error)); });
    const unsubscribe = api.onAgentTaskEvent(event => {
      if (event.sessionId !== session.id) return;
      setEvents(current => current.some(item => item.id === event.id) ? current : [...current, event].slice(-500));
      void refreshTasks(session.id).catch(error => onError(error instanceof Error ? error.message : String(error)));
    });
    return () => { live = false; unsubscribe(); };
  }, [api, session?.id]);

  useEffect(() => {
    if (!session || !selectedTask) { setEvents([]); return; }
    let live = true;
    void api.listAgentTaskEvents(session.id, selectedTask).then(rows => { if (live) setEvents(rows.slice(-500)); }).catch(error => { if (live) onError(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, [api, session?.id, selectedTask]);

  const selected = tasks.find(task => task.id === selectedTask);
  const selectedEvents = events.filter(event => event.taskId === selectedTask && event.type !== 'approval');
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!session?.projectId || busy) return;
    setBusy(true);
    try {
      const created = await api.createAgentTask({ sessionId: session.id, name, role, description, workspaceMode, outputExpectations: outputs.split('\n').map(line => line.trim()).filter(Boolean), acceptanceCriteria: criteria.split('\n').map(line => line.trim()).filter(Boolean), ...(input.trim() ? { input } : {}), ...(dependencies.length ? { dependencyIds: dependencies } : {}), maxAttempts });
      setName(''); setDescription(''); setOutputs(''); setCriteria(''); setInput(''); setDependencies([]); setShowCreate(false); setSelectedTask(created.id);
      await refreshTasks(session.id);
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function cancel(taskId: string) {
    if (!session) return;
    setBusy(true);
    try { await api.cancelAgentTask(session.id, taskId); await refreshTasks(session.id); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <div className="agent-tasks-panel">
    <div className="agent-tasks-heading"><div><strong>子 Agent</strong><span>{tasks.filter(task => task.status === 'RUNNING').length} 个运行中 · 最多并行 3 个</span></div><button className="icon-button" type="button" title="刷新子任务" aria-label="刷新子任务" disabled={!session || busy} onClick={() => { if (session) void refreshTasks(session.id).catch(error => onError(error instanceof Error ? error.message : String(error))); }}><Icon name="refresh" /></button></div>
    {!session ? <div className="agent-tasks-empty">选择一个会话后创建和查看子 Agent 任务。</div> : <>
      <details className="agent-task-create" open={showCreate} onToggle={event => setShowCreate(event.currentTarget.open)}><summary>新建工程任务</summary><form className="agent-task-form" onSubmit={event => { void create(event); }}>
        <label>任务名称<input value={name} onChange={event => setName(event.target.value)} maxLength={120} required placeholder="例如：梳理订单导入模块" disabled={busy} /></label>
        <label>专业角色<select value={role} onChange={event => setRole(event.target.value as AgentTaskRole)} disabled={busy}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>任务目录<select value={workspaceMode} onChange={event => setWorkspaceMode(event.target.value as 'read' | 'worktree')} disabled={busy}><option value="read">共享项目目录</option><option value="worktree">独立项目目录（按 Runtime 能力运行）</option></select></label>
        <label>任务描述<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={20000} required rows={3} placeholder="说明目标、关注范围和期望输出" disabled={busy} /></label>
        <label>期望交付（每行一项）<textarea value={outputs} onChange={event => setOutputs(event.target.value)} maxLength={20000} required rows={2} placeholder="例如：给出模块调用链与对应代码位置" disabled={busy} /></label>
        <label>验收标准（每行一项）<textarea value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={20000} required rows={2} placeholder="例如：每项结论附文件路径；明确未覆盖项" disabled={busy} /></label>
        <label>补充输入<textarea value={input} onChange={event => setInput(event.target.value)} maxLength={50000} rows={2} placeholder="可选：补充需求或已知信息" disabled={busy} /></label>
        {tasks.length > 0 && <label>依赖任务<select multiple value={dependencies} onChange={event => setDependencies(Array.from(event.target.selectedOptions, option => option.value))} disabled={busy} aria-label="选择依赖任务">{tasks.filter(task => task.status !== 'CANCELLED' && task.status !== 'BLOCKED').map(task => <option key={task.id} value={task.id}>{task.name} · {statusLabels[task.status]}</option>)}</select><small>按住 Ctrl 可多选；依赖完成后自动启动。</small></label>}
        <div className="agent-task-form-row"><label>最多尝试<select value={maxAttempts} onChange={event => setMaxAttempts(Number(event.target.value))} disabled={busy}><option value={1}>1 次</option><option value={2}>2 次</option><option value={3}>3 次</option></select></label><button className="primary-button" disabled={busy || !session.projectId || !name.trim() || !description.trim() || !outputs.trim() || !criteria.trim()} title={!session.projectId ? '请先将会话关联到项目' : undefined}><Icon name="plus" />{busy ? '处理中…' : workspaceMode === 'read' ? '创建任务' : '创建隔离任务'}</button></div>
        <p className="agent-task-security-note"><Icon name="shield" />{session.projectId ? '创建版本化契约；严格模型与工具限额需 Runtime 支持，否则任务将阻塞并显示能力缺口。' : '子 Agent 必须绑定项目，请先将当前会话关联到项目'}</p>
      </form></details>
      <div className="agent-task-list" aria-label="子 Agent 任务列表">{tasks.length ? tasks.map(task => <button type="button" key={task.id} className={`agent-task-row ${selectedTask === task.id ? 'selected' : ''}`} onClick={() => setSelectedTask(task.id)}><span className={`agent-task-dot task-${task.status.toLowerCase()}`} /><span><strong>{task.name}</strong><small>{roleLabels[task.role]} · 第 {task.attempt}/{task.maxAttempts} 次</small></span><b>{statusLabels[task.status]}</b></button>) : <div className="agent-tasks-empty">尚无子任务。</div>}</div>
      {selected && <section className="agent-task-detail" aria-label="子 Agent 任务详情"><div className="agent-task-detail-heading"><strong>{selected.name}</strong>{selected.status === 'PENDING' || selected.status === 'WAITING' || selected.status === 'RUNNING' || Boolean(selected.contractVersion && !['COMPLETED', 'CANCELLED'].includes(selected.executionStatus ?? selected.status)) ? <button className="cancel-button" type="button" disabled={busy} onClick={() => { void cancel(selected.id); }}><Icon name="stop" />{selected.status === 'RUNNING' ? '停止' : '终止并保留成果'}</button> : null}</div><p>{selected.description}</p>{selected.result?.summary && <pre className="agent-task-result">{selected.result.summary}</pre>}{selected.error && <pre className="agent-task-error">{selected.error}</pre>}
        {api.taskEngineering && <TaskEngineeringPanel api={api.taskEngineering} task={selected} onChange={() => refreshTasks(selected.sessionId)} onError={onError} />}
        <div className="agent-task-events-heading">执行日志 · {selectedEvents.length} 条</div><div className="agent-task-events">{selectedEvents.map(event => <article key={event.id} className={`agent-task-event event-${event.type}`}><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>{event.type === 'user' ? '输入' : event.type === 'status' ? '状态' : event.type === 'tool' ? '工具' : event.type === 'error' ? '错误' : '输出'}</span><pre>{event.text}</pre></article>)}{!selectedEvents.length && <span className="agent-task-no-events">暂无执行日志。</span>}</div>
      </section>}
    </>}
  </div>;
}

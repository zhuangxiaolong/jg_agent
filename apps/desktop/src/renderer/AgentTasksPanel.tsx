import { useEffect, useRef, useState } from 'react';
import type { AgentTask, AgentTaskEvent, AgentTaskRole, DesktopApi, Session } from '../../../../packages/domain/src';
import { automaticAgentTaskAvailability } from '../../../../packages/agent-orchestrator/src/runtime-capabilities';
import { agentTasksForSession, mergeAgentTaskEvents, selectedAgentTask } from './agent-task-state';
import { Icon } from './ui';
import { TaskEngineeringPanel } from './TaskEngineeringPanel';

const roleLabels: Record<AgentTaskRole, string> = {
  requirement: '需求分析', architecture: '架构分析', developer: '代码分析', review: '代码审查',
  testing: '测试分析', documentation: '文档整理', custom: '自定义分析',
};
const statusLabels: Record<AgentTask['status'], string> = {
  PENDING: '等待运行', RUNNING: '运行中', COMPLETED: '已完成', FAILED: '失败', CANCELLED: '已取消', WAITING: '等待依赖', BLOCKED: '已阻塞',
};
const taskName = (task: AgentTask) => task.name.replace(/^自动子Agent\[[a-f0-9]{12}\]\s*/, '');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function AgentTasksPanel(props: { api: DesktopApi; session?: Session; onError: (text: string) => void }) {
  // key 使会话更换与旧选中任务一起原子卸载，避免新会话请求旧任务。
  return props.session
    ? <SessionAgentTasksPanel key={props.session.id} {...props} session={props.session} />
    : <div className="agent-tasks-panel"><div className="agent-tasks-heading"><strong>子 Agent</strong></div><div className="agent-tasks-empty">选择会话后，按任务需要自动显示子 Agent。</div></div>;
}

function SessionAgentTasksPanel({ api, session, onError }: { api: DesktopApi; session: Session; onError: (text: string) => void }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [events, setEvents] = useState<AgentTaskEvent[]>([]);
  const [selectedTask, setSelectedTask] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const refreshVersion = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  async function refreshTasks() {
    const version = ++refreshVersion.current;
    const rows = agentTasksForSession(await api.listAgentTasks(session.id), session.id);
    if (!mounted.current || version !== refreshVersion.current) return;
    setTasks(rows);
    setSelectedTask(current => selectedAgentTask(rows, session.id, current)?.id ?? rows[0]?.id ?? '');
  }

  useEffect(() => {
    mounted.current = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    void refreshTasks().catch(error => { if (mounted.current) onErrorRef.current(errorMessage(error)); });
    const unsubscribe = api.onAgentTaskEvent(event => {
      if (!mounted.current || event.sessionId !== session.id) return;
      setEvents(current => current.some(item => item.id === event.id) ? current : [...current, event].slice(-500));
      // 流式输出合并刷新，避免每个 delta 都往返主进程读取任务列表。
      if (!refreshTimer) refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refreshTasks().catch(error => { if (mounted.current) onErrorRef.current(errorMessage(error)); });
      }, 150);
    });
    return () => { mounted.current = false; refreshVersion.current++; if (refreshTimer) clearTimeout(refreshTimer); unsubscribe(); };
  }, [api, session.id]);

  const selected = selectedAgentTask(tasks, session.id, selectedTask);
  useEffect(() => {
    if (!selected) { setEvents([]); return; }
    let live = true;
    const taskId = selected.id;
    void api.listAgentTaskEvents(session.id, taskId)
      .then(rows => { if (live && mounted.current) setEvents(current => mergeAgentTaskEvents(rows, current, session.id, taskId)); })
      .catch(error => { if (live && mounted.current) onErrorRef.current(errorMessage(error)); });
    return () => { live = false; };
  }, [api, session.id, selected?.id]);

  async function cancel(taskId: string) {
    if (!selectedAgentTask(tasks, session.id, taskId)) return;
    setBusy(true);
    try { await api.cancelAgentTask(session.id, taskId); await refreshTasks(); }
    catch (error) { if (mounted.current) onErrorRef.current(errorMessage(error)); }
    finally { if (mounted.current) setBusy(false); }
  }

  const availability = automaticAgentTaskAvailability(session.runtimeKind ?? 'codex');
  const selectedEvents = selected ? events.filter(event => event.sessionId === session.id && event.taskId === selected.id && event.type !== 'approval') : [];
  return <div className="agent-tasks-panel">
    <div className="agent-tasks-heading"><div><strong>子 Agent</strong><span>{tasks.filter(task => task.status === 'RUNNING').length} 个运行中 · 按任务需要自动分工</span></div><button className="icon-button" type="button" title="刷新子任务" aria-label="刷新子任务" disabled={busy} onClick={() => { void refreshTasks().catch(error => { if (mounted.current) onErrorRef.current(errorMessage(error)); }); }}><Icon name="refresh" /></button></div>
    {!availability.available && <p className="agent-task-security-note" role="status"><Icon name="shield" />{availability.reason}</p>}
    <div className="agent-task-list" aria-label="子 Agent 任务列表">{tasks.length ? tasks.map(task => <button type="button" key={task.id} className={`agent-task-row ${selectedTask === task.id ? 'selected' : ''}`} onClick={() => setSelectedTask(task.id)}><span className={`agent-task-dot task-${task.status.toLowerCase()}`} /><span><strong>{taskName(task)}</strong><small>{roleLabels[task.role]} · 第 {task.attempt}/{task.maxAttempts} 次</small></span><b>{statusLabels[task.status]}</b></button>) : <div className="agent-tasks-empty">{availability.available ? '当前任务尚未需要子 Agent；需要分工时会自动显示。' : '暂无可执行的自动子 Agent。'}</div>}</div>
    {selected && <section className="agent-task-detail" aria-label="子 Agent 任务详情"><div className="agent-task-detail-heading"><strong>{taskName(selected)}</strong>{selected.status === 'PENDING' || selected.status === 'WAITING' || selected.status === 'RUNNING' || Boolean(selected.contractVersion && !['COMPLETED', 'CANCELLED'].includes(selected.executionStatus ?? selected.status)) ? <button className="cancel-button" type="button" disabled={busy} onClick={() => { void cancel(selected.id); }}><Icon name="stop" />{selected.status === 'RUNNING' ? '停止' : '终止并保留成果'}</button> : null}</div>
      <details><summary>任务目标</summary><p>{selected.description}</p></details>
      {selected.result?.summary && <pre className="agent-task-result">{selected.result.summary}</pre>}{selected.error && <pre className="agent-task-error">{selected.error}</pre>}
      {api.taskEngineering && <details><summary>工程契约与证据</summary><TaskEngineeringPanel key={`${session.id}:${selected.id}`} api={api.taskEngineering} task={selected} onChange={refreshTasks} onError={text => { if (mounted.current) onErrorRef.current(text); }} /></details>}
      <details><summary className="agent-task-events-heading">执行日志 · {selectedEvents.length} 条</summary><div className="agent-task-events">{selectedEvents.map(event => <article key={event.id} className={`agent-task-event event-${event.type}`}><time>{new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time><span>{event.type === 'user' ? '输入' : event.type === 'status' ? '状态' : event.type === 'tool' ? '工具' : event.type === 'error' ? '错误' : '输出'}</span><pre>{event.text}</pre></article>)}{!selectedEvents.length && <span className="agent-task-no-events">暂无执行日志。</span>}</div></details>
    </section>}
  </div>;
}

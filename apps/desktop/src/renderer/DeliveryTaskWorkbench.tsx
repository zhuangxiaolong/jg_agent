import { useEffect, useMemo, useState } from 'react';
import type { AgentEvent, DeliveryTaskProject, DesktopApi, Session, SessionStatus } from '../../../../packages/domain/src';
import { Icon } from './ui';
import './delivery-workbench.css';

const statusLabels: Record<SessionStatus, string> = {
  idle: '待开始', running: '运行中', 'waiting-approval': '等待确认', completed: '已完成', failed: '失败', interrupted: '已中断',
};

interface DeliveryTaskWorkbenchProps {
  api: DesktopApi;
  projects: DeliveryTaskProject[];
  sessions: Session[];
  statuses: Readonly<Record<string, SessionStatus>>;
  onOpenSession: (session: Session) => void;
  onCreateSession: (projectId?: string) => void;
  onCreateProject: () => void;
}

function lastUserRequest(events: AgentEvent[]): string | undefined {
  const request = [...events].reverse().find(event => event.type === 'user')?.text.trim();
  if (!request) return undefined;
  return request.length > 180 ? `${request.slice(0, 180)}…` : request;
}

export function DeliveryTaskWorkbench({ api, projects, sessions, statuses, onOpenSession, onCreateSession, onCreateProject }: DeliveryTaskWorkbenchProps) {
  const [requestsBySession, setRequestsBySession] = useState<Record<string, string>>({});
  const [contentWarning, setContentWarning] = useState('');
  const latestSessions = useMemo(() => [...sessions].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 12), [sessions]);
  const contentSessionKey = latestSessions.map(session => session.id).join('|');

  useEffect(() => {
    let active = true;
    setContentWarning('');
    if (!latestSessions.length) { setRequestsBySession({}); return () => { active = false; }; }
    void Promise.allSettled(latestSessions.map(async session => [session.id, lastUserRequest(await api.getEvents(session.id))] as const)).then(results => {
      if (!active) return;
      const next: Record<string, string> = {};
      results.forEach(result => { if (result.status === 'fulfilled' && result.value[1]) next[result.value[0]] = result.value[1]; });
      setRequestsBySession(next);
      setContentWarning(results.some(result => result.status === 'rejected') ? '部分近期会话内容暂时无法读取。' : '');
    });
    return () => { active = false; };
  }, [api, contentSessionKey]);

  const summaries = useMemo(() => {
    return {
      total: sessions.length,
      active: sessions.filter(session => ['running', 'waiting-approval'].includes(statuses[session.id] ?? session.status)).length,
      completed: sessions.filter(session => (statuses[session.id] ?? session.status) === 'completed').length,
      attention: sessions.filter(session => ['failed', 'interrupted'].includes(statuses[session.id] ?? session.status)).length,
    };
  }, [sessions, statuses]);

  const sessionsByProject = useMemo(() => {
    const result = new Map<string, Session[]>();
    for (const session of sessions) {
      const projectId = session.deliveryProjectId ?? '';
      const bucket = result.get(projectId) ?? [];
      bucket.push(session);
      result.set(projectId, bucket);
    }
    return result;
  }, [sessions]);

  function renderSession(session: Session) {
    const status = statuses[session.id] ?? session.status;
    return <button type="button" className="delivery-session" key={session.id} onClick={() => onOpenSession(session)}>
      <span className={`task-workbench-status status-${status}`} aria-label={statusLabels[status]} />
      <span className="delivery-session-main"><strong>{session.alias || session.title || '未命名任务'}</strong><small>{requestsBySession[session.id] || '暂无会话内容摘要'}</small></span>
      <span className="delivery-session-meta"><b>{statusLabels[status]}</b><small>{new Date(session.createdAt).toLocaleDateString('zh-CN')}</small></span>
    </button>;
  }

  return <div className="task-workbench delivery-workbench">
    <header className="task-workbench-header">
      <div><h1>交付任务工作台</h1><span>交付会话与任务进展</span></div>
      <div className="task-workbench-actions">
        <button type="button" className="secondary-button" onClick={onCreateProject}><Icon name="folder" />新建交付项目</button>
        <button type="button" className="primary-button" onClick={() => onCreateSession()}><Icon name="plus" />新建会话</button>
      </div>
    </header>

    <section className="task-workbench-stats" aria-label="交付任务统计">
      <article><span>全部会话</span><strong>{summaries.total}</strong></article>
      <article><span>正在处理</span><strong>{summaries.active}</strong></article>
      <article><span>需要关注</span><strong>{summaries.attention}</strong></article>
      <article><span>已完成</span><strong>{summaries.completed}</strong></article>
    </section>

    {contentWarning && <p className="task-workbench-warning" role="status">{contentWarning}</p>}
    <section className="delivery-projects" aria-label="按项目汇总交付会话">
      <div className="task-workbench-section-heading"><h2>项目进展</h2><span>{projects.length} 个项目 · {sessions.length} 个会话</span></div>
      {projects.map(project => {
        const projectSessions = sessionsByProject.get(project.id) ?? [];
        const attention = projectSessions.filter(session => ['failed', 'interrupted'].includes(statuses[session.id] ?? session.status)).length;
        const active = projectSessions.filter(session => ['running', 'waiting-approval'].includes(statuses[session.id] ?? session.status)).length;
        const completed = projectSessions.filter(session => (statuses[session.id] ?? session.status) === 'completed').length;
        const recentRequests = projectSessions
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(session => requestsBySession[session.id])
          .filter((request): request is string => !!request)
          .slice(0, 2);
        return <article className="delivery-project-card" key={project.id}>
          <header><div><h3>{project.name}</h3><span>{projectSessions.length} 个会话 · 处理中 {active} · 已完成 {completed}{attention ? ` · 需关注 ${attention}` : ''}</span></div><button type="button" className="secondary-button" onClick={() => onCreateSession(project.id)}><Icon name="plus" />新建会话</button></header>
          {recentRequests.length ? <p className="delivery-project-summary">近期任务：{recentRequests.join('；')}</p> : <p className="delivery-project-summary task-workbench-muted">暂无可用任务内容摘要。</p>}
          {projectSessions.length ? <div className="delivery-session-list">{[...projectSessions].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 4).map(renderSession)}</div> : <p className="task-workbench-muted">该项目暂无交付会话。</p>}
        </article>;
      })}
      {!projects.length && <div className="task-workbench-empty"><strong>还没有交付项目</strong><span>创建项目后，可以把交付会话归入对应项目。</span><button type="button" className="text-button" onClick={onCreateProject}>新建交付项目</button></div>}
      {!!(sessionsByProject.get('')?.length) && <article className="delivery-project-card"><header><div><h3>未归属项目</h3><span>{sessionsByProject.get('')!.length} 个会话</span></div></header><div className="delivery-session-list">{sessionsByProject.get('')!.slice(0, 4).map(renderSession)}</div></article>}
    </section>

    <section className="delivery-recent" aria-label="近期交付会话内容">
      <div className="task-workbench-section-heading"><h2>近期会话内容</h2><span>最近 {latestSessions.length} 个会话</span></div>
      {latestSessions.length ? <div className="delivery-session-list">{latestSessions.map(renderSession)}</div> : <p className="task-workbench-muted">暂无交付会话。</p>}
    </section>
  </div>;
}

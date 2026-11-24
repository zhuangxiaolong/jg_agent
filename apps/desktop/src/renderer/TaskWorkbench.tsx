import { useEffect, useMemo, useState } from 'react';
import type { DesktopApi, Project, Session, SessionStatus, VerificationRunSummary } from '../../../../packages/domain/src';
import type { ExpertProfile, ExpertUsage } from '../../../../packages/domain/src/expert';
import type { KnowledgeSource } from '../../../../packages/domain/src/knowledge';
import { Icon } from './ui';
import { filterWorkbenchSessions, selectWorkbenchExperts, selectWorkbenchKnowledgeSources, summarizeWorkbenchSessions, type WorkbenchFilters } from './task-workbench-state';

const statusLabels: Record<SessionStatus, string> = {
  idle: '待开始', running: '运行中', 'waiting-approval': '等待确认', completed: '已完成', failed: '失败', interrupted: '已中断',
};
const taskTypeLabels: Record<string, string> = {
  bug: 'Bug 修复', feature: '功能开发', integration: '接口集成', schema: '数据结构', report: '交付分析', ui: '界面开发',
  config: '配置调整', refactor: '重构', unknown: '未分类',
};
const verificationLabels: Record<VerificationRunSummary['status'], string> = {
  passed: '通过', failed: '失败', not_run: '未运行', indeterminate: '无法判定', stale: '已过期',
};
const verificationTypeLabels: Record<VerificationRunSummary['runType'], string> = { build: '构建', test: '测试', typecheck: '类型检查' };

interface TaskWorkbenchProps {
  api: DesktopApi;
  projects: Project[];
  sessions: Session[];
  statuses: Readonly<Record<string, SessionStatus>>;
  onOpenSession: (session: Session) => void;
  onCreateSession: (projectId?: string) => void;
  onAddProject: () => void;
  onOpenJira: () => void;
  onOpenIteration: () => void;
  onOpenExperts: () => void;
  onOpenKnowledge: () => void;
}

export function TaskWorkbench({ api, projects, sessions, statuses, onOpenSession, onCreateSession, onAddProject, onOpenJira, onOpenIteration, onOpenExperts, onOpenKnowledge }: TaskWorkbenchProps) {
  const [filters, setFilters] = useState<WorkbenchFilters>({ projectId: 'all', status: 'all', taskType: 'all', time: '30d' });
  const [verificationRuns, setVerificationRuns] = useState<VerificationRunSummary[]>([]);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([]);
  const [expertProfiles, setExpertProfiles] = useState<ExpertProfile[]>([]);
  const [expertUsage, setExpertUsage] = useState<ExpertUsage[]>([]);
  const [verificationLoading, setVerificationLoading] = useState(false);
  const [verificationWarning, setVerificationWarning] = useState('');
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeWarning, setKnowledgeWarning] = useState('');
  const [expertsLoading, setExpertsLoading] = useState(false);
  const [expertsWarning, setExpertsWarning] = useState('');
  const summaries = summarizeWorkbenchSessions(sessions, statuses);
  const visibleSessions = useMemo(() => filterWorkbenchSessions(sessions, statuses, filters), [sessions, statuses, filters]);
  const projectNames = new Map(projects.map(project => [project.id, project.name]));
  const verificationProjects = filters.projectId === 'all' ? projects : projects.filter(project => project.id === filters.projectId);
  const verificationProjectKey = verificationProjects.map(project => project.id).join('|');
  const recentKnowledge = selectWorkbenchKnowledgeSources(knowledgeSources, filters.projectId);
  const commonExperts = selectWorkbenchExperts(expertProfiles, expertUsage);

  useEffect(() => {
    let active = true;
    if (!verificationProjects.length) {
      setVerificationRuns([]);
      setVerificationWarning('');
      setVerificationLoading(false);
      return () => { active = false; };
    }
    setVerificationLoading(true);
    setVerificationWarning('');
    void Promise.allSettled(verificationProjects.map(project => api.listProjectVerificationRuns(project.id)))
      .then(results => {
        if (!active) return;
        const runs = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
        setVerificationRuns(runs.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt)).slice(0, 6));
        if (results.some(result => result.status === 'rejected')) setVerificationWarning('部分项目的验证记录读取失败。');
      })
      .finally(() => { if (active) setVerificationLoading(false); });
    return () => { active = false; };
  }, [api, verificationProjectKey]);

  useEffect(() => {
    let active = true;
    if (api.knowledge) {
      setKnowledgeLoading(true);
      setKnowledgeWarning('');
      void api.knowledge.listSources()
        .then(sources => { if (active) setKnowledgeSources(sources); })
        .catch(() => { if (active) setKnowledgeWarning('知识来源读取失败。'); })
        .finally(() => { if (active) setKnowledgeLoading(false); });
    }
    if (api.experts) {
      setExpertsLoading(true);
      setExpertsWarning('');
      void Promise.all([api.experts.profiles(), api.experts.usage()])
        .then(([profiles, usage]) => { if (active) { setExpertProfiles(profiles); setExpertUsage(usage); } })
        .catch(() => { if (active) setExpertsWarning('专家档案读取失败。'); })
        .finally(() => { if (active) setExpertsLoading(false); });
    }
    return () => { active = false; };
  }, [api]);

  function updateFilter<K extends keyof WorkbenchFilters>(key: K, value: WorkbenchFilters[K]) {
    setFilters(current => ({ ...current, [key]: value }));
  }

  return <div className="task-workbench">
    <header className="task-workbench-header">
      <div><h1>研发任务工作台</h1><span>项目、会话与验证结果</span></div>
      <div className="task-workbench-actions">
        <button type="button" className="secondary-button" onClick={onOpenIteration}><Icon name="layers" />项目工作台</button>
        <button type="button" className="secondary-button" onClick={onOpenJira}>从 Jira 创建</button>
        <button type="button" className="primary-button" onClick={() => onCreateSession(filters.projectId === 'all' ? undefined : filters.projectId)}><Icon name="plus" />新建会话</button>
      </div>
    </header>

    <section className="task-workbench-stats" aria-label="真实会话统计">
      <article><span>全部任务会话</span><strong>{summaries.total}</strong></article>
      <article><span>正在处理</span><strong>{summaries.active}</strong></article>
      <article><span>需要关注</span><strong>{summaries.needsAttention}</strong></article>
      <article><span>近 7 天新增</span><strong>{summaries.createdThisWeek}</strong></article>
    </section>

    <div className="task-workbench-filterbar" role="group" aria-label="筛选任务会话">
      <label>项目<select value={filters.projectId} onChange={event => updateFilter('projectId', event.target.value)}><option value="all">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>状态<select value={filters.status} onChange={event => updateFilter('status', event.target.value as WorkbenchFilters['status'])}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
      <label>任务类型<select value={filters.taskType} onChange={event => updateFilter('taskType', event.target.value as WorkbenchFilters['taskType'])}><option value="all">全部类型</option>{Object.entries(taskTypeLabels).map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label>
      <label>创建时间<select value={filters.time} onChange={event => updateFilter('time', event.target.value as WorkbenchFilters['time'])}><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="90d">最近 90 天</option><option value="all">全部时间</option></select></label>
    </div>

    <div className="task-workbench-content">
      <section className="task-workbench-session-section" aria-label="任务会话列表">
        <div className="task-workbench-section-heading"><h2>研发任务</h2><span>{visibleSessions.length} / {sessions.length}</span></div>
        {visibleSessions.length ? <div className="task-workbench-session-list">{visibleSessions.map(session => {
          const status = statuses[session.id] ?? session.status;
          const taskType = session.requirementAdmission?.taskType ?? 'unknown';
          return <button type="button" key={session.id} className="task-workbench-session" onClick={() => onOpenSession(session)}>
            <span className={`task-workbench-status status-${status}`} aria-label={statusLabels[status]} />
            <span className="task-workbench-session-main"><strong>{session.alias || session.title || '未命名任务'}</strong><small>{projectNames.get(session.projectId ?? '') ?? '独立会话'} · {session.system ?? '通用'} · {taskTypeLabels[taskType] ?? taskTypeLabels.unknown}</small></span>
            <span className="task-workbench-session-meta"><b>{statusLabels[status]}</b><small>{new Date(session.createdAt).toLocaleDateString('zh-CN')}{session.jiraIssue ? ` · ${session.jiraIssue.key}` : ''}</small></span>
          </button>;
        })}</div> : <div className="task-workbench-empty"><strong>没有符合筛选条件的任务</strong><button type="button" className="text-button" onClick={() => setFilters({ projectId: 'all', status: 'all', taskType: 'all', time: 'all' })}>清除筛选</button></div>}
      </section>

      <section className="task-workbench-verification" aria-label="近期验证记录">
        <div className="task-workbench-section-heading"><h2>近期验证</h2><span>{verificationRuns.length}</span></div>
        {verificationLoading && <p className="task-workbench-muted">正在读取平台记录…</p>}
        {!verificationLoading && verificationWarning && <p className="task-workbench-warning" role="status">{verificationWarning}</p>}
        {!verificationLoading && !verificationRuns.length && <p className="task-workbench-muted">近期项目会话没有平台采集的验证记录。</p>}
        {verificationRuns.map(run => <button type="button" key={run.runId} className="task-workbench-verification-row" onClick={() => { const session = sessions.find(item => item.id === run.sessionId); if (session) onOpenSession(session); }}>
          <span className={`task-workbench-verification-status verify-${run.status}`} />
          <span><strong>{verificationTypeLabels[run.runType]} · {verificationLabels[run.status]}</strong><small>{projectNames.get(run.projectId) ?? run.projectName} · {new Date(run.startedAt).toLocaleString('zh-CN')}</small>{run.limitations[0] && <small>{run.limitations[0]}</small>}</span>
        </button>)}
        <div className="task-workbench-shortcuts"><button type="button" className="text-button" onClick={onAddProject}><Icon name="folder" />添加项目</button><button type="button" className="text-button" onClick={onOpenJira}>打开 Jira 任务</button></div>
      </section>
    </div>

    <div className="task-workbench-support">
      <section aria-label="常用专家">
        <div className="task-workbench-section-heading"><h2>常用专家</h2><button type="button" className="text-button" onClick={onOpenExperts}>专家中心</button></div>
        {expertsLoading && <p className="task-workbench-muted">正在读取专家调用记录…</p>}
        {!expertsLoading && expertsWarning && <p className="task-workbench-warning" role="status">{expertsWarning}</p>}
        {!expertsLoading && !expertsWarning && !commonExperts.length && <p className="task-workbench-muted">暂无启用的专家档案。</p>}
        {commonExperts.map(({ profile, usageCount, lastUsedAt }) => <button type="button" key={profile.id} className="task-workbench-support-row" onClick={onOpenExperts}>
          <span><strong>{profile.name}</strong><small>{profile.skillTags.slice(0, 3).join(' · ') || '专家角色'}</small></span>
          <small>{usageCount ? `调用 ${usageCount} 次 · ${new Date(lastUsedAt).toLocaleDateString('zh-CN')}` : '默认专家'}</small>
        </button>)}
      </section>

      <section aria-label="近期知识更新">
        <div className="task-workbench-section-heading"><h2>近期知识更新</h2><button type="button" className="text-button" onClick={onOpenKnowledge}>知识中心</button></div>
        {knowledgeLoading && <p className="task-workbench-muted">正在读取知识来源…</p>}
        {!knowledgeLoading && knowledgeWarning && <p className="task-workbench-warning" role="status">{knowledgeWarning}</p>}
        {!knowledgeLoading && !knowledgeWarning && !recentKnowledge.length && <p className="task-workbench-muted">当前范围没有知识来源记录。</p>}
        {recentKnowledge.map(source => <button type="button" key={source.id} className="task-workbench-support-row" onClick={onOpenKnowledge}>
          <span><strong>{source.name}</strong><small>{source.projectId ? projectNames.get(source.projectId) ?? '项目知识' : source.system ?? '共享知识'}</small></span>
          <small>{new Date(source.updatedAt).toLocaleDateString('zh-CN')}</small>
        </button>)}
      </section>
    </div>
  </div>;
}

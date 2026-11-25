import type { ReactNode } from 'react';
import type { DeliveryDashboardException, DeliveryOverview, DeliveryProject, DeliveryPortfolioItem, DeliveryProjectBundle } from '../../../../../packages/domain/src/delivery-workbench';
import { Icon } from '../ui';

export type DeliveryTodoFilter = 'all' | 'overdue' | 'today' | '7days' | 'completed';
export type DeliveryTodoType = 'all' | 'task' | 'issue' | 'milestone';
export type DeliveryRecordKind = 'task' | 'issue' | 'milestone';

const healthLabels = { red: '高风险', yellow: '需关注', green: '正常', gray: '数据不足' } as const;
const healthRank = { red: 0, yellow: 1, gray: 2, green: 3 } as const;
const taskStatusLabels = { todo: '待办', in_progress: '进行中', blocked: '阻塞', completed: '已完成', cancelled: '已取消' } as const;
const issueStatusLabels = { open: '待处理', in_progress: '处理中', pending_customer: '等待客户', resolved: '已解决', closed: '已关闭' } as const;
const milestoneStatusLabels = { not_started: '未开始', in_progress: '进行中', completed: '已完成', blocked: '阻塞', cancelled: '已取消' } as const;

export function DeliveryProjectCockpit({ bundle, onEditProject, onOpenTab, onOpenRecord, onOpenDocument }: {
  bundle: DeliveryProjectBundle;
  onEditProject: () => void;
  onOpenTab: (tab: 'milestones' | 'tasks' | 'issues' | 'meetings' | 'documents' | 'reports' | 'activity') => void;
  onOpenRecord: (kind: DeliveryRecordKind, id: string) => void;
  onOpenDocument: (id: string) => void;
}) {
  const { project } = bundle;
  const activeTasks = bundle.tasks.filter(item => !['completed', 'cancelled'].includes(item.status));
  const completedTasks = bundle.tasks.filter(item => item.status === 'completed').length;
  const plannedTasks = bundle.tasks.length - bundle.tasks.filter(item => item.status === 'cancelled').length;
  const progress = plannedTasks ? Math.round(completedTasks / plannedTasks * 100) : null;
  const activeMilestones = bundle.milestones.filter(item => !['completed', 'cancelled'].includes(item.status));
  const nextMilestones = [...activeMilestones].sort((a, b) => (a.plannedDate ?? '9999-12-31').localeCompare(b.plannedDate ?? '9999-12-31')).slice(0, 4);
  const openIssues = bundle.issues.filter(item => !['resolved', 'closed'].includes(item.status));
  const priorityIssues = [...openIssues].filter(item => item.priority === 'critical' || item.priority === 'high').sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority)).slice(0, 4);
  const recentMeeting = [...bundle.meetings].sort((a, b) => b.meetingAt.localeCompare(a.meetingAt))[0];
  const recentActivities = [...bundle.activities].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);

  return <div className="delivery-project-cockpit">
    <section className="delivery-panel delivery-project-health">
      <div className="delivery-project-health-heading"><div><span className="delivery-eyebrow">项目健康度</span><span className={`health-pill health-${bundle.health}`}>{healthLabels[bundle.health]}</span></div><p>{bundle.healthReasons.length ? bundle.healthReasons.join('；') : '当前没有触发健康度提醒。'}</p></div>
      <div className="delivery-project-progress">
        <div><span>任务完成进度</span><strong>{progress === null ? '未建立计划' : `${progress}%`}</strong></div>
        {progress !== null && <div className="delivery-progress-track"><span style={{ width: `${progress}%` }} /></div>}
        <small>{completedTasks} 项已完成 · {activeTasks.length} 项待跟进 · {openIssues.length} 项未关闭问题</small>
      </div>
      <div className="delivery-project-metrics"><button type="button" onClick={() => onOpenTab('milestones')}><span>里程碑</span><strong>{bundle.milestones.filter(item => item.status === 'completed').length}/{bundle.milestones.length}</strong></button><button type="button" onClick={() => onOpenTab('tasks')}><span>未完成任务</span><strong>{activeTasks.length}</strong></button><button type="button" onClick={() => onOpenTab('issues')}><span>未关闭问题</span><strong>{openIssues.length}</strong></button><button type="button" onClick={() => onOpenTab('documents')}><span>项目资料</span><strong>{bundle.documents.length}</strong></button></div>
    </section>

    <div className="delivery-project-cockpit-grid">
      <section className="delivery-panel">
        <PanelHeading title="近期里程碑" count={activeMilestones.length} action="查看里程碑" onAction={() => onOpenTab('milestones')} />
        {nextMilestones.length ? <div className="delivery-milestone-list">{nextMilestones.map(item => {
          const overdue = !!item.plannedDate && item.plannedDate < localDate();
          return <button type="button" className={`delivery-milestone-row${overdue ? ' overdue' : ''}`} key={item.id} onClick={() => onOpenRecord('milestone', item.id)}><span className="delivery-milestone-date">{item.plannedDate ? formatDate(item.plannedDate) : '未设置'}</span><span className="delivery-milestone-main"><strong>{item.name}</strong><small>{item.owner || '未分配负责人'}</small></span><span className={`delivery-chip ${overdue ? 'red' : 'neutral'}`}>{overdue ? '已逾期' : milestoneStatusLabels[item.status]}</span></button>;
        })}</div> : <p className="delivery-empty-inline">尚无待跟进里程碑。</p>}
      </section>
      <section className="delivery-panel">
        <PanelHeading title="高优先级问题" count={openIssues.length} action="查看问题" onAction={() => onOpenTab('issues')} />
        {priorityIssues.length ? <div className="delivery-project-issue-list">{priorityIssues.map(item => <button type="button" key={item.id} onClick={() => onOpenRecord('issue', item.id)}><span className={`delivery-chip ${item.priority === 'critical' ? 'red' : 'warning'}`}>{item.priority === 'critical' ? '紧急' : '高优先级'}</span><span><strong>{item.title}</strong><small>{item.owner || '未分配负责人'} · {issueStatusLabels[item.status]}{item.dueDate ? ` · 截止 ${formatDate(item.dueDate)}` : ''}</small></span><Icon name="chevron" /></button>)}</div> : <p className="delivery-empty-inline">暂无高优先级未关闭问题。</p>}
      </section>
      <section className="delivery-panel">
        <PanelHeading title="项目基本信息" action="编辑项目" onAction={onEditProject} />
        <dl className="delivery-project-info"><Info label="项目编号" value={project.code} /><Info label="客户" value={project.customerName} /><Info label="产品与版本" value={`${project.systemType} · ${project.productVersions.join('、') || '未记录'}`} /><Info label="项目经理" value={project.projectManager} /><Info label="团队成员" value={project.members.join('、')} /><Info label="计划周期" value={`${project.plannedStartDate ?? '未设置'} 至 ${project.plannedEndDate ?? '未设置'}`} /><Info label="Jira" value={project.jiraKey} /></dl>
        {project.description && <p className="delivery-project-description">{project.description}</p>}
      </section>
      <section className="delivery-panel">
        <PanelHeading title="最近会议" count={bundle.meetings.length} action="查看会议" onAction={() => onOpenTab('meetings')} />
        {recentMeeting ? <button type="button" className="delivery-project-meeting" onClick={() => onOpenTab('meetings')}><strong>{recentMeeting.title}</strong><small>{formatDateTime(recentMeeting.meetingAt)} · {recentMeeting.attendees.join('、') || '未记录参会人'}</small><span>{recentMeeting.minutes || '暂无会议纪要'}</span></button> : <p className="delivery-empty-inline">尚无会议记录。</p>}
      </section>
      <section className="delivery-panel">
        <PanelHeading title="项目资料" count={bundle.documents.length} action="管理资料" onAction={() => onOpenTab('documents')} />
        {bundle.documents.length ? <div className="delivery-project-documents">{bundle.documents.slice(0, 4).map(item => <button type="button" key={item.id} onClick={() => onOpenDocument(item.id)}><Icon name="file" /><span><strong>{item.fileName}</strong><small>{item.category} · {formatDate(item.createdAt)}</small></span></button>)}</div> : <p className="delivery-empty-inline">尚未关联项目资料。</p>}
      </section>
      <section className="delivery-panel">
        <PanelHeading title="最近动态" count={bundle.activities.length} action="全部动态" onAction={() => onOpenTab('activity')} />
        {recentActivities.length ? <div className="delivery-activity-list">{recentActivities.map(item => <button type="button" key={item.id} onClick={() => item.entityType === 'task' || item.entityType === 'issue' || item.entityType === 'milestone' ? onOpenRecord(item.entityType, item.entityId) : onOpenTab('activity')}><time>{formatDateTime(item.createdAt)}</time><span><strong>{item.summary}</strong><small>{item.actor || '未知操作人'}</small></span></button>)}</div> : <p className="delivery-empty-inline">暂无项目动态。</p>}
      </section>
    </div>
  </div>;
}

function Info({ label, value }: { label: string; value?: string }) {
  return <div><dt>{label}</dt><dd>{value || '未设置'}</dd></div>;
}

export function DeliveryDashboard({ overview, projects, taskProjects, quickTaskProjectId, onQuickTaskProjectChange, onCreateProject, onCreateTask, onOpenProject, onOpenLedger, onOpenTodos, onOpenRecord }: {
  overview: DeliveryOverview;
  projects: DeliveryProject[];
  taskProjects: DeliveryProject[];
  quickTaskProjectId: string;
  onQuickTaskProjectChange: (id: string) => void;
  onCreateProject: () => void;
  onCreateTask: (projectId: string) => void;
  onOpenProject: (id: string) => void;
  onOpenLedger: (filter: 'active' | 'risk') => void;
  onOpenTodos: (filter: DeliveryTodoFilter, type: DeliveryTodoType) => void;
  onOpenRecord: (projectId: string, kind: DeliveryRecordKind, recordId: string) => void;
}) {
  const riskProjects = overview.attentionProjects.filter(item => item.health === 'red' || item.health === 'yellow');
  const portfolio = overview.portfolio
    .filter(item => item.project.status !== 'archived')
    .sort((a, b) => healthRank[a.health] - healthRank[b.health] || b.project.updatedAt.localeCompare(a.project.updatedAt))
    .slice(0, 8);

  return <div className="delivery-dashboard">
    <div className="delivery-view-heading">
      <div><span className="delivery-eyebrow">交付总览</span><h1>交付驾驶舱</h1></div>
      <div className="delivery-heading-actions">
        {taskProjects.length > 0 && <label className="delivery-quick-task-project"><span>新建任务所属项目</span><select value={quickTaskProjectId} onChange={event => onQuickTaskProjectChange(event.target.value)} aria-label="新建任务所属项目">{taskProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
        <button type="button" className="secondary-button" disabled={!quickTaskProjectId} onClick={() => quickTaskProjectId && onCreateTask(quickTaskProjectId)}><Icon name="plus" />新建任务</button>
        <button type="button" className="primary-button" onClick={onCreateProject}><Icon name="plus" />新建项目</button>
      </div>
    </div>

    <div className="delivery-kpi-row" aria-label="交付关键指标">
      <button type="button" className="delivery-kpi" onClick={() => onOpenLedger('active')}><span>进行中项目</span><strong>{overview.activeProjects}</strong><small>查看项目台账</small></button>
      <button type="button" className="delivery-kpi risk" onClick={() => onOpenLedger('risk')}><span>风险项目</span><strong>{riskProjects.length}</strong><small>高风险与需关注</small></button>
      <button type="button" className="delivery-kpi risk" onClick={() => onOpenTodos('overdue', 'task')}><span>逾期任务</span><strong>{overview.overdueTasks}</strong><small>打开逾期待办</small></button>
      <button type="button" className="delivery-kpi warning" onClick={() => onOpenTodos('all', 'issue')}><span>高优先级未关闭问题</span><strong>{overview.highPriorityOpenIssues}</strong><small>查看问题事项</small></button>
      <button type="button" className="delivery-kpi" onClick={() => onOpenTodos('7days', 'milestone')}><span>7 天内里程碑</span><strong>{overview.upcomingMilestones}</strong><small>查看近期节点</small></button>
    </div>

    <div className="delivery-dashboard-grid">
      <section className="delivery-panel delivery-dashboard-risk">
        <PanelHeading title="项目风险与异常" count={riskProjects.length + overview.exceptions.length} action="项目台账" onAction={() => onOpenLedger('risk')} />
        {overview.exceptions.length > 0 && <div className="delivery-exception-list">{overview.exceptions.slice(0, 5).map(item => <ExceptionRow key={`${item.entityType}-${item.entityId}`} item={item} onClick={() => onOpenRecord(item.project.id, item.entityType, item.entityId)} />)}</div>}
        {riskProjects.length > 0 && <div className="delivery-attention-list">{riskProjects.slice(0, 5).map(item => <button type="button" className="delivery-risk-project" key={item.project.id} onClick={() => onOpenProject(item.project.id)}><span className={`health-marker health-${item.health}`} /><span className="delivery-risk-project-main"><strong>{item.project.name}</strong><small>{item.project.customerName} · {item.project.systemType} · {item.project.projectManager || '未分配项目经理'}</small><span>{item.reasons.slice(0, 2).join('；')}{item.reasons.length > 2 ? ` 等 ${item.reasons.length} 项` : ''}</span></span><span className={`health-pill health-${item.health}`}>{healthLabels[item.health]}</span><Icon name="chevron" /></button>)}</div>}
        {!overview.exceptions.length && !riskProjects.length && <EmptyState title="当前没有需要关注的项目" action="查看全部项目" onClick={() => onOpenLedger('active')} />}
      </section>

      <section className="delivery-panel delivery-dashboard-todos">
        <PanelHeading title="交付待办" count={overview.incompleteTasks + overview.priorityIssues.length} action="全部待办" onAction={() => onOpenTodos('all', 'all')} />
        <p className="delivery-panel-context">当前查看范围 · 全部待处理事项</p>
        <DeliveryTodoList overview={overview} filter="all" type="all" limit={6} onOpenRecord={onOpenRecord} />
        <button type="button" className="delivery-panel-link" onClick={() => onOpenTodos('all', 'all')}>进入待办列表<Icon name="chevron" /></button>
      </section>

      <section className="delivery-panel delivery-dashboard-portfolio">
        <PanelHeading title="项目交付态势" count={overview.portfolio.filter(item => item.project.status !== 'archived').length} action="查看全部" onAction={() => onOpenLedger('active')} />
        {portfolio.length > 0 ? <ProjectPortfolioTable items={portfolio} onOpenProject={onOpenProject} /> : <EmptyState title="暂无交付项目" action="新建项目" onClick={onCreateProject} />}
      </section>

      <section className="delivery-panel delivery-dashboard-milestones">
        <PanelHeading title="近期里程碑" count={overview.milestoneItems.length} action="查看全部" onAction={() => onOpenTodos('7days', 'milestone')} />
        {overview.milestoneItems.length ? <div className="delivery-milestone-list">{overview.milestoneItems.slice(0, 7).map(({ project, milestone }) => {
          const overdue = !!milestone.plannedDate && milestone.plannedDate < localDate();
          return <button type="button" className={`delivery-milestone-row${overdue ? ' overdue' : ''}`} key={milestone.id} onClick={() => onOpenRecord(project.id, 'milestone', milestone.id)}><span className="delivery-milestone-date">{milestone.plannedDate ? formatDate(milestone.plannedDate) : '未设置'}</span><span className="delivery-milestone-main"><strong>{milestone.name}</strong><small>{project.name} · {milestone.owner || '未分配'}</small></span><span className={`delivery-chip ${overdue ? 'red' : 'neutral'}`}>{overdue ? '已逾期' : milestoneStatusLabels[milestone.status]}</span></button>;
        })}</div> : <p className="delivery-empty-inline">未来 7 天暂无到期或逾期里程碑。</p>}
      </section>

      <section className="delivery-panel delivery-dashboard-activity">
        <PanelHeading title="最近动态" count={overview.recentActivities.length} />
        {overview.recentActivities.length ? <div className="delivery-activity-list">{overview.recentActivities.slice(0, 6).map(activity => {
          const project = projects.find(item => item.id === activity.deliveryProjectId);
          return <button type="button" key={activity.id} onClick={() => project && onOpenProject(project.id)} disabled={!project}><time>{formatDateTime(activity.createdAt)}</time><span><strong>{activity.summary}</strong><small>{project?.name ?? '项目已不可用'} · {activity.actor || '未知操作人'}</small></span></button>;
        })}</div> : <p className="delivery-empty-inline">暂无项目动态。</p>}
      </section>
    </div>
  </div>;
}

export function DeliveryProjectLedger({ projects, totalProjectCount, overview, statusFilter, systemFilter, stageFilter, managerFilter, healthFilter, projectSort, includeArchived, query, onStatusChange, onSystemChange, onStageChange, onManagerChange, onHealthChange, onSortChange, onArchivedChange, onQueryChange, onClearFilters, onCreateProject, onEditProject, onOpenProject }: {
  projects: DeliveryProject[];
  totalProjectCount: number;
  overview: DeliveryOverview;
  statusFilter: string; systemFilter: string; stageFilter: string; managerFilter: string; healthFilter: string;
  projectSort: 'updated' | 'planned_end' | 'risk'; includeArchived: boolean; query: string;
  onStatusChange: (value: string) => void; onSystemChange: (value: string) => void; onStageChange: (value: string) => void;
  onManagerChange: (value: string) => void; onHealthChange: (value: string) => void; onSortChange: (value: 'updated' | 'planned_end' | 'risk') => void;
  onArchivedChange: (value: boolean) => void; onQueryChange: (value: string) => void; onClearFilters: () => void;
  onCreateProject: () => void; onEditProject: (project: DeliveryProject) => void; onOpenProject: (id: string) => void;
}) {
  const portfolio = new Map(overview.portfolio.map(item => [item.project.id, item]));
  const managers = [...new Set(projects.map(project => project.projectManager).filter((name): name is string => !!name))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const stages = [...new Set(projects.map(project => project.stage).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const hasFilters = !!query || statusFilter !== 'all' || systemFilter !== 'all' || stageFilter !== 'all' || managerFilter !== 'all' || healthFilter !== 'all' || includeArchived;
  const highPriorityByProject = new Map<string, number>();
  for (const { project, issue } of overview.priorityIssues) highPriorityByProject.set(project.id, (highPriorityByProject.get(project.id) ?? 0) + 1);

  return <div className="delivery-ledger">
    <div className="delivery-view-heading"><div><span className="delivery-eyebrow">交付项目</span><h1>项目台账</h1><p>共 {totalProjectCount} 个项目，当前显示 {projects.length} 个筛选结果</p></div><button type="button" className="primary-button" onClick={onCreateProject}><Icon name="plus" />新建项目</button></div>
    <div className="delivery-ledger-tools">
      <label className="delivery-ledger-search"><Icon name="search" /><input value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索项目名称、客户、编号或项目经理" aria-label="搜索项目名称、客户、编号或项目经理" /></label>
      <select value={statusFilter} onChange={event => onStatusChange(event.target.value)} aria-label="项目状态"><option value="all">全部状态</option><option value="active">进行中</option><option value="on_hold">暂停</option><option value="completed">已完成</option><option value="archived">已归档</option></select>
      <select value={systemFilter} onChange={event => onSystemChange(event.target.value)} aria-label="产品系统"><option value="all">全部系统</option><option value="MES5">MES5</option><option value="MES6">MES6</option><option value="WMS">WMS</option><option value="OTHER">其他</option></select>
      <select value={stageFilter} onChange={event => onStageChange(event.target.value)} aria-label="项目阶段"><option value="all">全部阶段</option>{stages.map(stage => <option key={stage} value={stage}>{stage}</option>)}</select>
      <select value={managerFilter} onChange={event => onManagerChange(event.target.value)} aria-label="项目经理"><option value="all">全部项目经理</option><option value="__unassigned__">未分配项目经理</option>{managers.map(manager => <option key={manager} value={manager}>{manager}</option>)}</select>
      <select value={healthFilter} onChange={event => onHealthChange(event.target.value)} aria-label="健康度"><option value="all">全部健康度</option><option value="risk">风险项目</option><option value="red">高风险</option><option value="yellow">需关注</option><option value="green">正常</option><option value="gray">数据不足</option></select>
      <select value={projectSort} onChange={event => onSortChange(event.target.value as typeof projectSort)} aria-label="项目排序"><option value="updated">最近更新</option><option value="planned_end">计划结束日期</option><option value="risk">风险等级</option></select>
      <label className="delivery-archived-toggle"><input type="checkbox" checked={includeArchived} onChange={event => onArchivedChange(event.target.checked)} />显示归档</label>
      {hasFilters && <button type="button" className="secondary-button" onClick={onClearFilters}>清除筛选</button>}
    </div>
    <div className="delivery-table-scroll"><table className="delivery-project-table"><thead><tr><th>项目</th><th>产品</th><th>阶段</th><th>项目经理</th><th>健康度</th><th>任务进度</th><th>未关闭问题</th><th>计划结束</th><th>最近更新</th><th>操作</th></tr></thead><tbody>
      {projects.map(project => {
        const item = portfolio.get(project.id);
        const endOverdue = project.status === 'active' && !!project.plannedEndDate && project.plannedEndDate < localDate();
        const issueCount = item?.openIssueCount ?? 0;
        const highPriorityCount = highPriorityByProject.get(project.id) ?? 0;
        return <tr key={project.id} className={project.status === 'archived' ? 'archived' : ''}>
          <td><button type="button" className="delivery-ledger-project-name" onClick={() => onOpenProject(project.id)}><strong>{project.name}</strong><small>{project.code || '未设置编号'} · {project.customerName}</small></button></td>
          <td><strong>{project.systemType}</strong><small>{project.productVersions.join('、') || '未记录版本'}</small></td>
          <td>{project.stage}</td><td>{project.projectManager || '未分配'}</td>
          <td>{item ? <span className={`health-pill health-${item.health}`} title={item.healthReasons.join('；')}>{healthLabels[item.health]}</span> : <span className="delivery-chip neutral">无健康数据</span>}</td>
          <td>{item?.progressPercent === null || !item ? <span className="delivery-no-plan">未建立计划</span> : <div className="delivery-progress-cell"><div className="delivery-progress-track"><span style={{ width: `${item.progressPercent}%` }} /></div><small>{item.completedTaskCount}/{item.taskCount - item.cancelledTaskCount} · {item.progressPercent}%</small></div>}</td>
          <td><span className={highPriorityCount ? 'delivery-issue-count high' : 'delivery-issue-count'}>{issueCount}</span>{highPriorityCount > 0 && <small className="delivery-ledger-high-issues">高优先级 {highPriorityCount}</small>}</td>
          <td><span className={endOverdue ? 'delivery-date-overdue' : ''}>{project.plannedEndDate || '未设置'}</span>{endOverdue && <small className="delivery-ledger-high-issues">计划已逾期</small>}</td>
          <td>{formatDate(project.updatedAt)}</td>
          <td><div className="delivery-ledger-actions"><button type="button" className="icon-button" onClick={() => onOpenProject(project.id)} title="进入项目" aria-label={`进入项目 ${project.name}`}><Icon name="chevron" /></button><button type="button" className="icon-button" onClick={() => onEditProject(project)} disabled={project.status === 'archived'} title="编辑项目" aria-label={`编辑项目 ${project.name}`}><Icon name="edit" /></button></div></td>
        </tr>;
      })}
      {!projects.length && <tr><td className="delivery-table-empty" colSpan={10}><EmptyState title={hasFilters ? '没有匹配的项目' : '还没有交付项目'} action={hasFilters ? '清除筛选' : '新建项目'} onClick={hasFilters ? onClearFilters : onCreateProject} /></td></tr>}
    </tbody></table></div>
  </div>;
}

export function DeliveryTodos({ overview, filter, type, onFilterChange, onTypeChange, onOpenRecord }: {
  overview: DeliveryOverview;
  filter: DeliveryTodoFilter;
  type: DeliveryTodoType;
  onFilterChange: (value: DeliveryTodoFilter) => void;
  onTypeChange: (value: DeliveryTodoType) => void;
  onOpenRecord: (projectId: string, kind: DeliveryRecordKind, recordId: string) => void;
}) {
  const count = todoRecords(overview, filter, type).length;
  return <div className="delivery-todos-page">
    <div className="delivery-view-heading"><div><span className="delivery-eyebrow">当前查看范围 · 全部待处理事项</span><h1>我的待办</h1><p>当前客户端没有可靠的登录用户身份，列表按交付项目聚合。</p></div></div>
    <div className="delivery-todo-toolbar">
      <div className="delivery-segmented" role="group" aria-label="待办时间范围">{([['all', '全部'], ['overdue', '已逾期'], ['today', '今天到期'], ['7days', '7 天内'], ['completed', '已完成']] as Array<[DeliveryTodoFilter, string]>).map(([value, label]) => <button type="button" key={value} className={filter === value ? 'active' : ''} aria-pressed={filter === value} onClick={() => onFilterChange(value)}>{label}</button>)}</div>
      <select value={type} onChange={event => onTypeChange(event.target.value as DeliveryTodoType)} aria-label="事项类型"><option value="all">全部事项</option><option value="task">任务</option><option value="issue">高优先级问题</option><option value="milestone">近期里程碑</option></select>
      <span className="delivery-todo-result-count">{count} 项</span>
    </div>
    <div className="delivery-todo-list">{count ? <TodoRows overview={overview} filter={filter} type={type} onOpenRecord={onOpenRecord} /> : <div className="delivery-todo-empty"><span className="delivery-empty-check"><Icon name="check" /></span><strong>{filter === 'completed' ? '暂无已完成任务' : '当前筛选下没有待办事项'}</strong><small>{filter === 'all' ? '任务、问题和近期里程碑会显示在这里。' : '可以切换筛选范围查看其他事项。'}</small></div>}</div>
  </div>;
}

function DeliveryTodoList({ overview, filter, type, limit, onOpenRecord }: { overview: DeliveryOverview; filter: DeliveryTodoFilter; type: DeliveryTodoType; limit?: number; onOpenRecord: (projectId: string, kind: DeliveryRecordKind, recordId: string) => void }) {
  const records = todoRecords(overview, filter, type).slice(0, limit);
  return records.length ? <div className="delivery-dashboard-todo-list">{records.map(item => <TodoButton key={`${item.kind}-${item.id}`} {...item} onClick={() => onOpenRecord(item.projectId, item.kind, item.id)} />)}</div> : <p className="delivery-empty-inline">暂无待处理事项。</p>;
}

function TodoRows({ overview, filter, type, onOpenRecord }: { overview: DeliveryOverview; filter: DeliveryTodoFilter; type: DeliveryTodoType; onOpenRecord: (projectId: string, kind: DeliveryRecordKind, recordId: string) => void }) {
  return <div className="delivery-todo-groups">{(type === 'all' || type === 'task') && <TodoGroup title={filter === 'completed' ? '已完成任务' : '任务'}>{overview.todos.filter(({ task }) => matchesDateFilter(task.dueDate, filter) && (filter === 'completed' ? task.status === 'completed' : task.status !== 'completed')).map(({ project, task }) => <TodoButton key={task.id} kind="task" id={task.id} projectId={project.id} title={task.title} projectName={project.name} owner={task.owner} dueDate={task.dueDate} priority={task.priority} status={taskStatusLabels[task.status]} tone={task.status === 'blocked' ? 'red' : task.priority === 'high' || task.priority === 'critical' ? 'warning' : ''} onClick={() => onOpenRecord(project.id, 'task', task.id)} />)}</TodoGroup>}
    {filter !== 'completed' && (type === 'all' || type === 'issue') && <TodoGroup title="高优先级未关闭问题">{overview.priorityIssues.filter(({ issue }) => matchesDateFilter(issue.dueDate, filter)).map(({ project, issue }) => <TodoButton key={issue.id} kind="issue" id={issue.id} projectId={project.id} title={issue.title} projectName={project.name} owner={issue.owner} dueDate={issue.dueDate} priority={issue.priority} status={issueStatusLabels[issue.status]} tone="red" onClick={() => onOpenRecord(project.id, 'issue', issue.id)} />)}</TodoGroup>}
    {filter !== 'completed' && (type === 'all' || type === 'milestone') && <TodoGroup title="近期里程碑">{overview.milestoneItems.filter(({ milestone }) => matchesDateFilter(milestone.plannedDate, filter)).map(({ project, milestone }) => <TodoButton key={milestone.id} kind="milestone" id={milestone.id} projectId={project.id} title={milestone.name} projectName={project.name} owner={milestone.owner} dueDate={milestone.plannedDate} status={milestoneStatusLabels[milestone.status]} tone={milestone.plannedDate && milestone.plannedDate < localDate() ? 'red' : ''} onClick={() => onOpenRecord(project.id, 'milestone', milestone.id)} />)}</TodoGroup>}
  </div>;
}

function todoRecords(overview: DeliveryOverview, filter: DeliveryTodoFilter, type: DeliveryTodoType): Array<{ kind: DeliveryRecordKind; id: string; projectId: string; title: string; projectName: string; owner?: string; dueDate?: string; priority?: string; status: string; tone: string; onClick?: () => void }> {
  const records: Array<{ kind: DeliveryRecordKind; id: string; projectId: string; title: string; projectName: string; owner?: string; dueDate?: string; priority?: string; status: string; tone: string }> = [];
  if (type === 'all' || type === 'task') for (const { project, task } of overview.todos) {
    if (!matchesDateFilter(task.dueDate, filter) || (filter === 'completed' ? task.status !== 'completed' : task.status === 'completed')) continue;
    records.push({ kind: 'task', id: task.id, projectId: project.id, title: task.title, projectName: project.name, owner: task.owner, dueDate: task.dueDate, priority: task.priority, status: taskStatusLabels[task.status], tone: task.status === 'blocked' ? 'red' : task.priority === 'high' || task.priority === 'critical' ? 'warning' : '' });
  }
  if (filter !== 'completed' && (type === 'all' || type === 'issue')) for (const { project, issue } of overview.priorityIssues) {
    if (!matchesDateFilter(issue.dueDate, filter)) continue;
    records.push({ kind: 'issue', id: issue.id, projectId: project.id, title: issue.title, projectName: project.name, owner: issue.owner, dueDate: issue.dueDate, priority: issue.priority, status: issueStatusLabels[issue.status], tone: 'red' });
  }
  if (filter !== 'completed' && (type === 'all' || type === 'milestone')) for (const { project, milestone } of overview.milestoneItems) {
    if (!matchesDateFilter(milestone.plannedDate, filter)) continue;
    records.push({ kind: 'milestone', id: milestone.id, projectId: project.id, title: milestone.name, projectName: project.name, owner: milestone.owner, dueDate: milestone.plannedDate, status: milestoneStatusLabels[milestone.status], tone: milestone.plannedDate && milestone.plannedDate < localDate() ? 'red' : '' });
  }
  return records.sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || priorityRank(b.priority) - priorityRank(a.priority));
}

function ProjectPortfolioTable({ items, onOpenProject }: { items: DeliveryPortfolioItem[]; onOpenProject: (id: string) => void }) {
  return <div className="delivery-portfolio-list">{items.map(item => <button type="button" className="delivery-portfolio-row" key={item.project.id} onClick={() => onOpenProject(item.project.id)}><span className={`health-marker health-${item.health}`} /><span className="delivery-portfolio-project"><strong>{item.project.name}</strong><small>{item.project.customerName} · {item.project.systemType} · {item.project.stage}</small></span><span className={`health-pill health-${item.health}`}>{healthLabels[item.health]}</span><span className="delivery-portfolio-progress">{item.progressPercent === null ? <small>未建立计划</small> : <><span className="delivery-progress-track"><span style={{ width: `${item.progressPercent}%` }} /></span><small>{item.progressPercent}%</small></>}</span><span className="delivery-portfolio-issues">问题 <b>{item.openIssueCount}</b></span></button>)}</div>;
}

function ExceptionRow({ item, onClick }: { item: DeliveryDashboardException; onClick: () => void }) {
  return <button type="button" className="delivery-exception-row" onClick={onClick}><span className={`delivery-exception-symbol ${item.priority === 'critical' || item.reason.includes('逾期') || item.reason.includes('阻塞') ? 'red' : 'warning'}`}><Icon name="alert" /></span><span className="delivery-exception-main"><strong>{item.title}</strong><small>{item.project.name} · {item.reason}</small></span><span className="delivery-exception-owner">{item.owner || '未分配'}</span><span className="delivery-exception-date">{item.dueDate || '未设置'}</span><Icon name="chevron" /></button>;
}

function TodoButton({ kind, title, projectName, owner, dueDate, priority, status, tone, onClick }: { kind: DeliveryRecordKind; id: string; projectId: string; title: string; projectName: string; owner?: string; dueDate?: string; priority?: string; status: string; tone: string; onClick: () => void }) {
  const kindLabel = kind === 'task' ? '任务' : kind === 'issue' ? '问题' : '里程碑';
  return <button type="button" className={`delivery-todo-row ${tone}`} onClick={onClick}><span className="delivery-todo-kind">{kindLabel}</span><span className="delivery-todo-main"><strong>{title}</strong><small>{projectName} · {owner || '未分配'}</small></span><span className="delivery-todo-priority">{priority ? `${priorityLabel(priority)} · ` : ''}{status}</span><span className="delivery-todo-date">{dueDate || '未设置截止日期'}</span><Icon name="chevron" /></button>;
}

function TodoGroup({ title, children }: { title: string; children: ReactNode }) {
  const count = Array.isArray(children) ? children.length : children ? 1 : 0;
  return <section className="delivery-todo-group"><div className="delivery-todo-group-heading"><h2>{title}</h2><span>{count}</span></div>{count > 0 ? children : <p className="delivery-empty-inline">暂无事项</p>}</section>;
}

function PanelHeading({ title, count, action, onAction }: { title: string; count?: number; action?: string; onAction?: () => void }) {
  return <div className="delivery-panel-heading"><div><h2>{title}</h2>{count !== undefined && <span>{count}</span>}</div>{action && onAction && <button type="button" onClick={onAction}>{action}<Icon name="chevron" /></button>}</div>;
}

function EmptyState({ title, action, onClick }: { title: string; action: string; onClick: () => void }) {
  return <div className="delivery-empty-state"><span>{title}</span><button type="button" className="secondary-button" onClick={onClick}>{action}</button></div>;
}

function matchesDateFilter(date: string | undefined, filter: DeliveryTodoFilter): boolean {
  if (filter === 'all' || filter === 'completed') return true;
  if (!date) return false;
  const today = localDate();
  if (filter === 'overdue') return date < today;
  if (filter === 'today') return date === today;
  return date >= today && date <= addDays(today, 7);
}

function priorityRank(priority?: string): number { return priority === 'critical' ? 3 : priority === 'high' ? 2 : priority === 'medium' ? 1 : 0; }
function priorityLabel(priority: string): string { return ({ low: '低', medium: '中', high: '高', critical: '緊急' } as Record<string, string>)[priority] ?? priority; }
function localDate(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function addDays(date: string, days: number): string { const value = new Date(`${date}T00:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }
function formatDate(value: string): string { return value.slice(0, 10); }
function formatDateTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }

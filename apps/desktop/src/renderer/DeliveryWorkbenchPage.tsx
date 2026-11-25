import { useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { DeliveryActivity, DeliveryDocumentCategory, DeliveryHealth, DeliveryIssue, DeliveryMeeting, DeliveryMilestone, DeliveryProject, DeliveryProjectBundle, DeliveryProjectInput, DeliveryReport, DeliveryTask, DeliveryTaskBatchInput, DeliveryWorkbenchApi } from '../../../../packages/domain/src/delivery-workbench';
import type { MappingJobSelection } from '../../../../packages/domain/src';
import { Icon } from './ui';
import './delivery-workbench.css';

type Tab = 'overview' | 'milestones' | 'tasks' | 'issues' | 'meetings' | 'documents' | 'reports' | 'activity';
type RecordKind = 'milestone' | 'task' | 'issue' | 'meeting';
type ProjectDraft = {
  id?: string; code: string; name: string; customerName: string; systemType: DeliveryProject['systemType'];
  productVersions: string; stage: string; status: Exclude<DeliveryProject['status'], 'archived'>;
  projectManager: string; members: string; plannedStartDate: string; plannedEndDate: string;
  description: string; jiraKey: string; linkedCodeProjectId: string;
};
type RecordDraft = {
  id?: string; title: string; description: string; owner: string; status: string; priority: string;
  type: string; startDate: string; dueDate: string; plannedDate: string; actualDate: string;
  completionNote: string; mitigation: string; resolution: string; meetingAt: string; meetingType: string;
  attendees: string; minutes: string; sortOrder: number; milestoneId: string;
  linkedTaskIds: string[]; linkedIssueIds: string[]; linkedMeetingIds: string[]; linkedMilestoneId: string;
};
type TaskBatchDraft = { titles: string; owner: string; priority: DeliveryTask['priority']; dueDate: string; milestoneId: string };

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '项目概况' }, { id: 'milestones', label: '里程碑' }, { id: 'tasks', label: '任务' },
  { id: 'issues', label: '问题与风险' }, { id: 'meetings', label: '会议' }, { id: 'documents', label: '项目资料' },
  { id: 'reports', label: '报告' }, { id: 'activity', label: '活动' },
];
const documentCategories: Array<{ value: DeliveryDocumentCategory; label: string }> = [
  { value: 'contract', label: '合同' }, { value: 'handover', label: '交接' }, { value: 'requirement', label: '需求' },
  { value: 'blueprint', label: '蓝图' }, { value: 'test', label: '测试' }, { value: 'go_live', label: '上线' },
  { value: 'acceptance', label: '验收' }, { value: 'manual', label: '手册' }, { value: 'other', label: '其他' },
];
const healthLabels: Record<DeliveryHealth, string> = { red: '高风险', yellow: '需关注', green: '正常', gray: '数据不足' };
const healthColors: Record<DeliveryHealth, string> = { red: 'red', yellow: 'yellow', green: 'green', gray: 'gray' };
const projectStatusLabels: Record<DeliveryProject['status'], string> = { active: '进行中', on_hold: '暂停', completed: '已完成', archived: '已归档' };
const taskStatusLabels: Record<DeliveryTask['status'], string> = { todo: '待办', in_progress: '进行中', blocked: '阻塞', completed: '已完成', cancelled: '已取消' };
const issueStatusLabels: Record<DeliveryIssue['status'], string> = { open: '待处理', in_progress: '处理中', pending_customer: '等待客户', resolved: '已解决', closed: '已关闭' };
const milestoneStatusLabels: Record<DeliveryMilestone['status'], string> = { not_started: '未开始', in_progress: '进行中', completed: '已完成', blocked: '阻塞', cancelled: '已取消' };

export function DeliveryWorkbenchPage({ api, onClose, onOpenMapping, onOpenManuals, initialProjectId, initialIssueId }: {
  api: DeliveryWorkbenchApi; onClose: () => void;
  onOpenMapping: (linkedCodeProjectId: string, systemType: MappingJobSelection['systemType'] | 'OTHER', productVersion: string) => void;
  onOpenManuals: () => void;
  initialProjectId?: string; initialIssueId?: string;
}) {
  const [overview, setOverview] = useState<Awaited<ReturnType<DeliveryWorkbenchApi['overview']>> | null>(null);
  const [projects, setProjects] = useState<DeliveryProject[]>([]);
  const [codeProjects, setCodeProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [bundle, setBundle] = useState<DeliveryProjectBundle | null>(null);
  const [selectedId, setSelectedId] = useState(initialProjectId ?? '');
  const [tab, setTab] = useState<Tab>(initialProjectId ? 'issues' : 'overview');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [systemFilter, setSystemFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState('all');
  const [managerFilter, setManagerFilter] = useState('all');
  const [projectSort, setProjectSort] = useState<'updated' | 'planned_end'>('updated');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [recordDraft, setRecordDraft] = useState<{ kind: RecordKind; value: RecordDraft } | null>(null);
  const [taskBatchDraft, setTaskBatchDraft] = useState<TaskBatchDraft | null>(null);
  const [documentCategory, setDocumentCategory] = useState<DeliveryDocumentCategory>('requirement');
  const [reportStart, setReportStart] = useState('');
  const [reportEnd, setReportEnd] = useState('');
  const [selectedReportId, setSelectedReportId] = useState('');
  const [reportTitle, setReportTitle] = useState('');
  const [reportMarkdown, setReportMarkdown] = useState('');
  const [reportStatus, setReportStatus] = useState<'draft' | 'final'>('draft');

  async function refresh(preferredId = selectedId) {
    setLoading(true);
    setError('');
    try {
      const [nextOverview, nextProjects, nextCodeProjects] = await Promise.all([
        api.overview(), api.listProjects(true), api.linkedCodeProjects(),
      ]);
      setOverview(nextOverview);
      setProjects(nextProjects);
      setCodeProjects(nextCodeProjects);
      const nextId = preferredId && nextProjects.some(item => item.id === preferredId) ? preferredId : '';
      setSelectedId(nextId);
      setBundle(nextId ? await api.getProject(nextId) : null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(initialProjectId ?? ''); }, []);
  useEffect(() => {
    if (!bundle?.reports.length) {
      setSelectedReportId(''); setReportTitle(''); setReportMarkdown(''); return;
    }
    const selected = bundle.reports.find(item => item.id === selectedReportId) ?? bundle.reports[0];
    setSelectedReportId(selected.id); setReportTitle(selected.title); setReportMarkdown(selected.markdown); setReportStatus(selected.status);
  }, [bundle?.reports, selectedReportId]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) { if (event.key === 'Escape') { if (projectDraft) setProjectDraft(null); else if (recordDraft) setRecordDraft(null); else if (taskBatchDraft) setTaskBatchDraft(null); else onClose(); } }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, projectDraft, recordDraft, taskBatchDraft]);

  async function perform(action: () => Promise<void>, message?: string) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (message) setNotice(message); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  async function selectProject(id: string) {
    setSelectedId(id); setTab('overview'); setError(''); setNotice('');
    try { setBundle(await api.getProject(id)); }
    catch (reason) { setError(errorText(reason)); }
  }
  function newProject() {
    setProjectDraft({ code: '', name: '', customerName: '', systemType: 'MES6', productVersions: '', stage: '实施', status: 'active', projectManager: '', members: '', plannedStartDate: '', plannedEndDate: '', description: '', jiraKey: '', linkedCodeProjectId: '' });
  }
  function editProject(project: DeliveryProject) {
    setProjectDraft({ id: project.id, code: project.code ?? '', name: project.name, customerName: project.customerName, systemType: project.systemType, productVersions: project.productVersions.join(', '), stage: project.stage, status: project.status === 'archived' ? 'active' : project.status, projectManager: project.projectManager ?? '', members: project.members.join(', '), plannedStartDate: project.plannedStartDate ?? '', plannedEndDate: project.plannedEndDate ?? '', description: project.description ?? '', jiraKey: project.jiraKey ?? '', linkedCodeProjectId: project.linkedCodeProjectId ?? '' });
  }
  async function saveProject(event: FormEvent) {
    event.preventDefault(); if (!projectDraft) return;
    const input: DeliveryProjectInput = {
      code: optional(projectDraft.code), name: projectDraft.name.trim(), customerName: projectDraft.customerName.trim(),
      systemType: projectDraft.systemType, productVersions: splitList(projectDraft.productVersions), stage: projectDraft.stage.trim(),
      status: projectDraft.status, projectManager: optional(projectDraft.projectManager), members: splitList(projectDraft.members),
      plannedStartDate: optional(projectDraft.plannedStartDate), plannedEndDate: optional(projectDraft.plannedEndDate),
      description: optional(projectDraft.description), jiraKey: optional(projectDraft.jiraKey), linkedCodeProjectId: optional(projectDraft.linkedCodeProjectId),
    };
    await perform(async () => {
      const saved = projectDraft.id ? await api.updateProject(projectDraft.id, input) : await api.createProject(input);
      setProjectDraft(null); await refresh(saved.id); setTab('overview');
    }, '项目信息已保存');
  }
  async function archiveProject() {
    if (!bundle || !window.confirm(`归档项目“${bundle.project.name}”？归档后仍可查看，不能继续编辑。`)) return;
    await perform(async () => { await api.archiveProject(bundle.project.id); await refresh(''); }, '项目已归档');
  }
  function openRecord(kind: RecordKind, item?: DeliveryMilestone | DeliveryTask | DeliveryIssue | DeliveryMeeting) {
    const base: RecordDraft = {
      title: '', description: '', owner: '', status: 'not_started', priority: 'medium', type: 'issue', startDate: '', dueDate: '', plannedDate: '', actualDate: '',
      completionNote: '', mitigation: '', resolution: '', meetingAt: localDateTime(), meetingType: 'customer', attendees: '', minutes: '', sortOrder: bundle?.milestones.length ?? 0,
      milestoneId: '', linkedTaskIds: [], linkedIssueIds: [], linkedMeetingIds: [], linkedMilestoneId: '',
    };
    if (kind === 'task') base.status = 'todo';
    if (kind === 'issue') base.status = 'open';
    if (kind === 'milestone' && item) Object.assign(base, { id: item.id, title: (item as DeliveryMilestone).name, description: (item as DeliveryMilestone).description ?? '', owner: (item as DeliveryMilestone).owner ?? '', status: (item as DeliveryMilestone).status, plannedDate: (item as DeliveryMilestone).plannedDate ?? '', actualDate: (item as DeliveryMilestone).actualDate ?? '', sortOrder: (item as DeliveryMilestone).sortOrder });
    if (kind === 'task' && item) Object.assign(base, { id: item.id, title: (item as DeliveryTask).title, description: (item as DeliveryTask).description ?? '', owner: (item as DeliveryTask).owner ?? '', status: (item as DeliveryTask).status, priority: (item as DeliveryTask).priority, startDate: (item as DeliveryTask).startDate ?? '', dueDate: (item as DeliveryTask).dueDate ?? '', completionNote: (item as DeliveryTask).completionNote ?? '', milestoneId: (item as DeliveryTask).milestoneId ?? '', linkedIssueIds: (item as DeliveryTask).linkedIssueIds, linkedMeetingIds: (item as DeliveryTask).linkedMeetingIds });
    if (kind === 'issue' && item) Object.assign(base, { id: item.id, title: (item as DeliveryIssue).title, description: (item as DeliveryIssue).description ?? '', owner: (item as DeliveryIssue).owner ?? '', status: (item as DeliveryIssue).status, priority: (item as DeliveryIssue).priority, type: (item as DeliveryIssue).type, dueDate: (item as DeliveryIssue).dueDate ?? '', mitigation: (item as DeliveryIssue).mitigation ?? '', resolution: (item as DeliveryIssue).resolution ?? '', linkedTaskIds: (item as DeliveryIssue).linkedTaskIds, linkedMeetingIds: (item as DeliveryIssue).linkedMeetingIds, linkedMilestoneId: (item as DeliveryIssue).linkedMilestoneId ?? '' });
    if (kind === 'meeting' && item) {
      const meeting = item as DeliveryMeeting;
      Object.assign(base, { id: meeting.id, title: meeting.title, status: 'in_progress', meetingAt: localInputDateTime(meeting.meetingAt), meetingType: meeting.meetingType, attendees: meeting.attendees.join(', '), minutes: meeting.minutes, linkedTaskIds: meeting.linkedTaskIds, linkedIssueIds: meeting.linkedIssueIds, linkedMilestoneId: meeting.linkedMilestoneId ?? '' });
    }
    setRecordDraft({ kind, value: base });
  }
  async function saveRecord(event: FormEvent) {
    event.preventDefault(); if (!bundle || !recordDraft) return;
    const { kind, value } = recordDraft;
    await perform(async () => {
      if (kind === 'milestone') await api.saveMilestone(bundle.project.id, { id: value.id, name: value.title.trim(), description: optional(value.description), sortOrder: Number(value.sortOrder), plannedDate: optional(value.plannedDate), actualDate: optional(value.actualDate), owner: optional(value.owner), status: value.status as DeliveryMilestone['status'] });
      if (kind === 'task') await api.saveTask(bundle.project.id, { id: value.id, title: value.title.trim(), description: optional(value.description), owner: optional(value.owner), priority: value.priority as DeliveryTask['priority'], status: value.status as DeliveryTask['status'], startDate: optional(value.startDate), dueDate: optional(value.dueDate), completionNote: optional(value.completionNote), milestoneId: optional(value.milestoneId), linkedIssueIds: value.linkedIssueIds, linkedMeetingIds: value.linkedMeetingIds });
      if (kind === 'issue') await api.saveIssue(bundle.project.id, { id: value.id, title: value.title.trim(), description: optional(value.description), type: value.type as DeliveryIssue['type'], priority: value.priority as DeliveryIssue['priority'], status: value.status as DeliveryIssue['status'], owner: optional(value.owner), discoveredAt: value.id ? bundle.issues.find(item => item.id === value.id)?.discoveredAt ?? new Date().toISOString() : new Date().toISOString(), dueDate: optional(value.dueDate), mitigation: optional(value.mitigation), resolution: optional(value.resolution), linkedTaskIds: value.linkedTaskIds, linkedMilestoneId: optional(value.linkedMilestoneId), linkedMeetingIds: value.linkedMeetingIds, sourceRefs: value.id ? bundle.issues.find(item => item.id === value.id)?.sourceRefs ?? [] : [] });
      if (kind === 'meeting') await api.saveMeeting(bundle.project.id, { id: value.id, title: value.title.trim(), meetingAt: new Date(value.meetingAt).toISOString(), meetingType: value.meetingType as DeliveryMeeting['meetingType'], attendees: splitList(value.attendees), minutes: value.minutes, linkedTaskIds: value.linkedTaskIds, linkedIssueIds: value.linkedIssueIds, linkedMilestoneId: optional(value.linkedMilestoneId) });
      setRecordDraft(null); await refresh(bundle.project.id);
    }, '记录已保存');
  }
  async function saveTaskBatch(event: FormEvent) {
    event.preventDefault();
    if (!bundle || !taskBatchDraft) return;
    const titles = taskBatchDraft.titles.split(/\r?\n/).map(title => title.trim()).filter(Boolean);
    if (!titles.length) { setError('请至少输入一条任务标题'); return; }
    if (titles.length > 100) { setError('每批最多录入 100 条任务'); return; }
    const inputs: DeliveryTaskBatchInput[] = titles.map(title => ({
      title,
      owner: optional(taskBatchDraft.owner),
      priority: taskBatchDraft.priority,
      dueDate: optional(taskBatchDraft.dueDate),
      milestoneId: optional(taskBatchDraft.milestoneId),
    }));
    await perform(async () => {
      await api.saveTasks(bundle.project.id, inputs);
      setTaskBatchDraft(null);
      await refresh(bundle.project.id);
    }, `已批量新增 ${inputs.length} 条任务`);
  }
  async function deleteRecord(kind: RecordKind, item: DeliveryMilestone | DeliveryTask | DeliveryIssue | DeliveryMeeting) {
    if (!bundle || !window.confirm(`删除“${recordTitle(kind, item)}”？其他记录中的关联会同步解除。`)) return;
    await perform(async () => {
      if (kind === 'milestone') await api.deleteMilestone(bundle.project.id, item.id);
      if (kind === 'task') await api.deleteTask(bundle.project.id, item.id);
      if (kind === 'issue') await api.deleteIssue(bundle.project.id, item.id);
      if (kind === 'meeting') await api.deleteMeeting(bundle.project.id, item.id);
      await refresh(bundle.project.id);
    }, '记录已删除');
  }
  async function importDocument() {
    if (!bundle) return;
    await perform(async () => { const document = await api.importDocument(bundle.project.id, documentCategory); if (document) await refresh(bundle.project.id); }, '资料已导入');
  }
  async function detachDocument(id: string, name: string) {
    if (!bundle || !window.confirm(`解除资料“${name}”与项目的关联？资料文件将保留在本机交付资料目录。`)) return;
    await perform(async () => { await api.detachDocument(bundle.project.id, id); await refresh(bundle.project.id); }, '资料关联已解除');
  }
  async function buildReport(reportType: 'weekly' | 'risk') {
    if (!bundle) return;
    await perform(async () => {
      const report = await api.buildReportDraft(bundle.project.id, { reportType, periodStart: optional(reportStart), periodEnd: optional(reportEnd) });
      await refresh(bundle.project.id); setSelectedReportId(report.id); setTab('reports');
    }, '报告数据草稿已保存');
  }
  async function saveReport() {
    if (!bundle) return;
    const current = bundle.reports.find(item => item.id === selectedReportId);
    if (!current) return;
    await perform(async () => {
      const saved = await api.saveReport(bundle.project.id, { id: current.id, reportType: current.reportType, title: reportTitle.trim(), periodStart: current.periodStart, periodEnd: current.periodEnd, markdown: reportMarkdown, status: reportStatus, sourceSnapshotHash: current.sourceSnapshotHash });
      await refresh(bundle.project.id); setSelectedReportId(saved.id);
    }, '报告已保存');
  }
  const projectStages = [...new Set(projects.map(project => project.stage).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const projectManagers = [...new Set(projects.map(project => project.projectManager).filter((manager): manager is string => !!manager))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const visibleProjects = projects
    .filter(project => (project.status !== 'archived' || includeArchived || statusFilter === 'archived') && (statusFilter === 'all' || project.status === statusFilter))
    .filter(project => systemFilter === 'all' || project.systemType === systemFilter)
    .filter(project => stageFilter === 'all' || project.stage === stageFilter)
    .filter(project => managerFilter === 'all' || (managerFilter === '__unassigned__' ? !project.projectManager : project.projectManager === managerFilter))
    .filter(project => `${project.name} ${project.customerName} ${project.code ?? ''} ${project.projectManager ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => projectSort === 'updated'
      ? b.updatedAt.localeCompare(a.updatedAt)
      : (a.plannedEndDate ?? '9999-12-31').localeCompare(b.plannedEndDate ?? '9999-12-31') || b.updatedAt.localeCompare(a.updatedAt));
  const relatedCodeProject = codeProjects.find(item => item.id === bundle?.project.linkedCodeProjectId);
  const canOpenMapping = !!relatedCodeProject && bundle?.project.systemType !== 'OTHER';

  return <main className="delivery-workbench-page">
    <header className="delivery-header">
      <div className="delivery-brand"><button type="button" className="icon-button" onClick={onClose} title="返回研发工作台" aria-label="返回研发工作台"><Icon name="arrow" /></button><span className="delivery-brand-mark"><Icon name="box" /></span><div><strong>交付工作台</strong><span>项目交付管理</span></div></div>
      <div className="delivery-header-actions"><button type="button" className="secondary-button" onClick={onOpenManuals}>操作手册</button><button type="button" className="icon-button" onClick={() => void refresh()} title="刷新数据" aria-label="刷新数据"><Icon name="refresh" /></button></div>
    </header>
    {error && <div className="delivery-feedback error" role="alert"><Icon name="alert" /><span>{error}</span><button type="button" className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><Icon name="close" /></button></div>}
    {notice && <div className="delivery-feedback success" role="status"><Icon name="check" /><span>{notice}</span><button type="button" className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示"><Icon name="close" /></button></div>}
    <div className="delivery-layout">
      <aside className="delivery-project-rail" aria-label="交付项目列表">
        <div className="delivery-rail-heading"><div><strong>项目</strong><span>{visibleProjects.length} 个</span></div><button type="button" className="icon-button" onClick={newProject} title="新建项目" aria-label="新建项目"><Icon name="plus" /></button></div>
        <label className="delivery-search"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目、客户或负责人" aria-label="搜索交付项目" /></label>
        <div className="delivery-rail-filters">
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="按项目状态筛选"><option value="all">全部状态</option><option value="active">进行中</option><option value="on_hold">暂停</option><option value="completed">已完成</option><option value="archived">已归档</option></select>
          <select value={systemFilter} onChange={event => setSystemFilter(event.target.value)} aria-label="按系统类型筛选"><option value="all">全部系统</option><option value="MES5">MES5</option><option value="MES6">MES6</option><option value="WMS">WMS</option><option value="OTHER">其他</option></select>
          <select value={stageFilter} onChange={event => setStageFilter(event.target.value)} aria-label="按项目阶段筛选"><option value="all">全部阶段</option>{projectStages.map(stage => <option key={stage} value={stage}>{stage}</option>)}</select>
          <select value={managerFilter} onChange={event => setManagerFilter(event.target.value)} aria-label="按项目经理筛选"><option value="all">全部项目经理</option><option value="__unassigned__">未分配项目经理</option>{projectManagers.map(manager => <option key={manager} value={manager}>{manager}</option>)}</select>
          <select value={projectSort} onChange={event => setProjectSort(event.target.value as typeof projectSort)} aria-label="项目排序"><option value="updated">最近更新</option><option value="planned_end">计划结束日期</option></select>
          <label><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} />显示归档</label>
        </div>
        <div className="delivery-project-list">{visibleProjects.map(project => <button type="button" key={project.id} className={`delivery-project-row${selectedId === project.id ? ' selected' : ''}`} onClick={() => void selectProject(project.id)}><span className={`delivery-project-dot status-${project.status}`} /><span className="delivery-project-row-main"><strong>{project.name}</strong><small>{project.customerName} · {project.systemType} · {project.stage}</small></span><span className="delivery-project-row-status">{projectStatusLabels[project.status]}</span></button>)}{!visibleProjects.length && <p className="delivery-empty">没有匹配的项目</p>}</div>
      </aside>
      <section className="delivery-content">
        {loading && !overview ? <div className="delivery-loading">正在载入交付数据…</div> : selectedId && bundle ? <>
          <div className="delivery-project-heading"><div><div className="delivery-eyebrow">{bundle.project.customerName} · {bundle.project.systemType}</div><h1>{bundle.project.name}</h1><p>{bundle.project.code || '未设置项目编号'} · {bundle.project.stage} · {projectStatusLabels[bundle.project.status]}</p></div><div className="delivery-project-actions"><button type="button" className="secondary-button" disabled={bundle.project.status === 'archived'} onClick={() => editProject(bundle.project)}>编辑项目</button><button type="button" className="secondary-button" disabled={!canOpenMapping || bundle.project.status === 'archived'} onClick={() => onOpenMapping(bundle.project.linkedCodeProjectId!, bundle.project.systemType, bundle.project.productVersions[0] ?? '')} title={!relatedCodeProject ? '请先关联本地代码项目' : bundle.project.systemType === 'OTHER' ? '映射引擎支持 MES5、MES6 与 WMS' : '打开数据映射并预填项目系统和版本'}><Icon name="layers" />打开 Excel 映射</button>{bundle.project.status !== 'archived' && <button type="button" className="danger-button" onClick={() => void archiveProject()}>归档</button>}</div></div>
          <div className="delivery-tabs" role="tablist" aria-label="项目交付信息">{tabs.map(item => <button role="tab" type="button" key={item.id} aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}{item.id === 'issues' && bundle.issues.filter(issue => !['resolved', 'closed'].includes(issue.status)).length > 0 && <span>{bundle.issues.filter(issue => !['resolved', 'closed'].includes(issue.status)).length}</span>}</button>)}</div>
          <ProjectTab bundle={bundle} tab={tab} api={api} focusedIssueId={initialIssueId} documentCategory={documentCategory} setDocumentCategory={setDocumentCategory} onImportDocument={() => void importDocument()} onDetachDocument={detachDocument} onEditRecord={openRecord} onDeleteRecord={deleteRecord} onAddTaskBatch={() => setTaskBatchDraft({ titles: '', owner: '', priority: 'medium', dueDate: '', milestoneId: '' })} onBuildReport={buildReport} reportStart={reportStart} setReportStart={setReportStart} reportEnd={reportEnd} setReportEnd={setReportEnd} selectedReportId={selectedReportId} setSelectedReportId={setSelectedReportId} reportTitle={reportTitle} setReportTitle={setReportTitle} reportMarkdown={reportMarkdown} setReportMarkdown={setReportMarkdown} reportStatus={reportStatus} setReportStatus={setReportStatus} onSaveReport={() => void saveReport()} onCopyReport={() => perform(async () => { await navigator.clipboard.writeText(reportMarkdown); }, '报告 Markdown 已复制')} onExportReport={id => perform(async () => { const file = await api.exportReport(bundle.project.id, id); if (file) setNotice(`已导出至 ${file}`); }, '报告已导出')} onOpenManuals={onOpenManuals} busy={busy} />
        </> : <OverviewPanel overview={overview} projects={projects} onSelectProject={id => void selectProject(id)} onCreateProject={newProject} />}
      </section>
    </div>
    {projectDraft && <ProjectDialog draft={projectDraft} codeProjects={codeProjects} busy={busy} onChange={setProjectDraft} onSubmit={event => void saveProject(event)} onClose={() => setProjectDraft(null)} />}
    {recordDraft && bundle && <RecordDialog draft={recordDraft} bundle={bundle} busy={busy} onChange={setRecordDraft} onSubmit={event => void saveRecord(event)} onClose={() => setRecordDraft(null)} />}
    {taskBatchDraft && bundle && <TaskBatchDialog draft={taskBatchDraft} milestones={bundle.milestones} busy={busy} onChange={setTaskBatchDraft} onSubmit={event => void saveTaskBatch(event)} onClose={() => setTaskBatchDraft(null)} />}
  </main>;
}

function OverviewPanel({ overview, projects, onSelectProject, onCreateProject }: { overview: Awaited<ReturnType<DeliveryWorkbenchApi['overview']>> | null; projects: DeliveryProject[]; onSelectProject: (id: string) => void; onCreateProject: () => void }) {
  if (!overview) return <div className="delivery-loading">正在载入交付数据…</div>;
  const activities = overview.recentActivities;
  return <div className="delivery-overview-panel">
    <div className="delivery-overview-heading"><div><div className="delivery-eyebrow">项目交付状态</div><h1>交付总览</h1></div><button type="button" className="primary-button" onClick={onCreateProject}><Icon name="plus" />新建项目</button></div>
    <div className="delivery-stat-grid"><Stat label="项目总数" value={overview.totalProjects} /><Stat label="进行中" value={overview.activeProjects} /><Stat label="未完成任务" value={overview.incompleteTasks} /><Stat label="逾期任务" value={overview.overdueTasks} tone={overview.overdueTasks ? 'red' : ''} /><Stat label="逾期里程碑" value={overview.overdueMilestones} tone={overview.overdueMilestones ? 'red' : ''} /><Stat label="7 天内里程碑" value={overview.upcomingMilestones} /><Stat label="高优先级未关闭" value={overview.highPriorityOpenIssues} tone={overview.highPriorityOpenIssues ? 'yellow' : ''} /><Stat label="归档项目" value={overview.archivedProjects} /></div>
    <section className="delivery-usage-flow" aria-label="交付工作台使用流程"><strong>使用流程</strong><ol><li><span>01</span><div><b>建立项目</b><small>新建项目并填写客户、产品、负责人和计划周期</small></div></li><li><span>02</span><div><b>拆解交付计划</b><small>维护里程碑、任务、问题与风险</small></div></li><li><span>03</span><div><b>跟进执行</b><small>更新负责人、状态、完成日期和会议纪要</small></div></li><li><span>04</span><div><b>归档交付资料</b><small>关联文档，生成并确认周报或风险摘要</small></div></li></ol></section>
    <div className="delivery-overview-columns"><section className="delivery-section"><div className="delivery-section-heading"><h2>需要关注</h2><span>{overview.attentionProjects.length}</span></div>{overview.attentionProjects.length ? <div className="delivery-attention-list">{overview.attentionProjects.map(item => <button type="button" className="delivery-attention-row" key={item.project.id} onClick={() => onSelectProject(item.project.id)}><span className={`health-marker health-${healthColors[item.health]}`} /><span><strong>{item.project.name}</strong><small>{item.project.customerName} · {item.reasons.slice(0, 2).join('，')}</small></span><Icon name="chevron" /></button>)}</div> : <p className="delivery-muted">当前没有触发关注规则的进行中项目。</p>}</section><section className="delivery-section"><div className="delivery-section-heading"><h2>最近活动</h2><span>{activities.length}</span></div>{activities.length ? <ActivityList activities={activities.slice(0, 12)} projects={projects} onSelectProject={onSelectProject} /> : <p className="delivery-muted">暂无活动记录。</p>}</section></div>
  </div>;
}

function ProjectTab({ bundle, tab, api, focusedIssueId, documentCategory, setDocumentCategory, onImportDocument, onDetachDocument, onEditRecord, onDeleteRecord, onAddTaskBatch, onBuildReport, reportStart, setReportStart, reportEnd, setReportEnd, selectedReportId, setSelectedReportId, reportTitle, setReportTitle, reportMarkdown, setReportMarkdown, reportStatus, setReportStatus, onSaveReport, onCopyReport, onExportReport, onOpenManuals, busy }: {
  bundle: DeliveryProjectBundle; tab: Tab; api: DeliveryWorkbenchApi; focusedIssueId?: string; documentCategory: DeliveryDocumentCategory; setDocumentCategory: (value: DeliveryDocumentCategory) => void; onImportDocument: () => void;
  onDetachDocument: (id: string, name: string) => void; onEditRecord: (kind: RecordKind, item?: DeliveryMilestone | DeliveryTask | DeliveryIssue | DeliveryMeeting) => void;
  onDeleteRecord: (kind: RecordKind, item: DeliveryMilestone | DeliveryTask | DeliveryIssue | DeliveryMeeting) => void;
  onAddTaskBatch: () => void;
  onBuildReport: (type: 'weekly' | 'risk') => void; reportStart: string; setReportStart: (value: string) => void; reportEnd: string; setReportEnd: (value: string) => void;
  selectedReportId: string; setSelectedReportId: (value: string) => void; reportTitle: string; setReportTitle: (value: string) => void; reportMarkdown: string; setReportMarkdown: (value: string) => void;
  reportStatus: 'draft' | 'final'; setReportStatus: (value: 'draft' | 'final') => void; onSaveReport: () => void; onCopyReport: () => void; onExportReport: (id: string) => void | Promise<void>; onOpenManuals: () => void; busy: boolean;
}) {
  const { project } = bundle;
  const [milestoneStatusFilter, setMilestoneStatusFilter] = useState<DeliveryMilestone['status'] | 'all'>('all');
  const [taskStatusFilter, setTaskStatusFilter] = useState<DeliveryTask['status'] | 'all'>('all');
  const [taskOwnerFilter, setTaskOwnerFilter] = useState('all');
  const [taskPriorityFilter, setTaskPriorityFilter] = useState<DeliveryTask['priority'] | 'all'>('all');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [issueStatusFilter, setIssueStatusFilter] = useState<DeliveryIssue['status'] | 'all'>('all');
  const [issueTypeFilter, setIssueTypeFilter] = useState<DeliveryIssue['type'] | 'all'>('all');
  const [issuePriorityFilter, setIssuePriorityFilter] = useState<DeliveryIssue['priority'] | 'all'>('all');
  const today = localDate();
  const taskOwners = [...new Set(bundle.tasks.map(task => task.owner).filter((owner): owner is string => !!owner))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const visibleMilestones = bundle.milestones.filter(item => milestoneStatusFilter === 'all' || item.status === milestoneStatusFilter);
  const visibleTasks = bundle.tasks.filter(item =>
    (taskStatusFilter === 'all' || item.status === taskStatusFilter)
    && (taskOwnerFilter === 'all' || (taskOwnerFilter === '__unassigned__' ? !item.owner : item.owner === taskOwnerFilter))
    && (taskPriorityFilter === 'all' || item.priority === taskPriorityFilter)
    && (!overdueOnly || (!!item.dueDate && item.dueDate < today && !['completed', 'cancelled'].includes(item.status))));
  const visibleIssues = bundle.issues.filter(item =>
    (issueStatusFilter === 'all' || item.status === issueStatusFilter)
    && (issueTypeFilter === 'all' || item.type === issueTypeFilter)
    && (issuePriorityFilter === 'all' || item.priority === issuePriorityFilter));
  if (tab === 'overview') return <div className="delivery-detail-grid">
    <section className="delivery-section delivery-health-panel"><div className="delivery-section-heading"><h2>交付健康度</h2><span className={`health-pill health-${healthColors[bundle.health]}`}>{healthLabels[bundle.health]}</span></div><ul className="delivery-reasons">{bundle.healthReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></section>
    <section className="delivery-section"><div className="delivery-section-heading"><h2>项目基本信息</h2></div><dl className="delivery-info-grid"><Info label="项目编号" value={project.code} /><Info label="客户" value={project.customerName} /><Info label="系统" value={project.systemType} /><Info label="产品版本" value={project.productVersions.join('、')} /><Info label="阶段" value={project.stage} /><Info label="项目经理" value={project.projectManager} /><Info label="成员" value={project.members.join('、')} /><Info label="计划周期" value={dateSpan(project.plannedStartDate, project.plannedEndDate)} /><Info label="Jira" value={project.jiraKey} /><Info label="本地代码项目" value={bundle.project.linkedCodeProjectId ?? '未关联'} /></dl>{project.description && <p className="delivery-description">{project.description}</p>}</section>
    <section className="delivery-section"><div className="delivery-section-heading"><h2>交付进度</h2></div><div className="delivery-progress-grid"><Stat label="里程碑" value={`${bundle.milestones.filter(item => item.status === 'completed').length}/${bundle.milestones.length}`} /><Stat label="未完成任务" value={bundle.tasks.filter(item => !['completed', 'cancelled'].includes(item.status)).length} /><Stat label="未关闭问题" value={bundle.issues.filter(item => !['resolved', 'closed'].includes(item.status)).length} /><Stat label="项目资料" value={bundle.documents.length} /></div></section>
  </div>;
  if (tab === 'milestones') return <div className="delivery-section"><div className="delivery-section-heading"><div><h2>里程碑</h2><span>{bundle.milestones.length}</span></div><button type="button" className="primary-button" onClick={() => onEditRecord('milestone')}><Icon name="plus" />新增里程碑</button></div><div className="delivery-list-filters"><select value={milestoneStatusFilter} onChange={event => setMilestoneStatusFilter(event.target.value as typeof milestoneStatusFilter)} aria-label="按里程碑状态筛选"><option value="all">全部状态</option>{Object.entries(milestoneStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="delivery-item-list">{visibleMilestones.map(item => <article className="delivery-record-row" key={item.id}><div className="delivery-record-main"><strong>{item.name}</strong><small>{item.plannedDate ? `计划 ${item.plannedDate}` : '未设计划日期'}{item.actualDate ? ` · 完成 ${item.actualDate}` : ''}{item.owner ? ` · ${item.owner}` : ''}</small>{item.description && <p>{item.description}</p>}</div><span className="delivery-status-text">{milestoneStatusLabels[item.status]}</span><RecordActions onEdit={() => onEditRecord('milestone', item)} onDelete={() => onDeleteRecord('milestone', item)} disabled={busy} /></article>)}{!visibleMilestones.length && <EmptyRows text={bundle.milestones.length ? '没有符合筛选条件的里程碑' : '尚未记录里程碑'} />}</div></div>;
  if (tab === 'tasks') return <div className="delivery-section"><div className="delivery-section-heading"><div><h2>任务</h2><span>{bundle.tasks.length}</span></div><div className="delivery-inline-actions"><button type="button" className="secondary-button" disabled={busy || project.status === 'archived'} onClick={onAddTaskBatch}>多行录入</button><button type="button" className="primary-button" disabled={busy || project.status === 'archived'} onClick={() => onEditRecord('task')}><Icon name="plus" />新增任务</button></div></div><div className="delivery-list-filters"><select value={taskStatusFilter} onChange={event => setTaskStatusFilter(event.target.value as typeof taskStatusFilter)} aria-label="按任务状态筛选"><option value="all">全部状态</option>{Object.entries(taskStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={taskOwnerFilter} onChange={event => setTaskOwnerFilter(event.target.value)} aria-label="按任务负责人筛选"><option value="all">全部负责人</option><option value="__unassigned__">未分配负责人</option>{taskOwners.map(owner => <option key={owner} value={owner}>{owner}</option>)}</select><select value={taskPriorityFilter} onChange={event => setTaskPriorityFilter(event.target.value as typeof taskPriorityFilter)} aria-label="按任务优先级筛选"><option value="all">全部优先级</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select><label className="delivery-overdue-filter"><input type="checkbox" checked={overdueOnly} onChange={event => setOverdueOnly(event.target.checked)} />仅逾期</label></div><div className="delivery-item-list">{visibleTasks.map(item => <article className="delivery-record-row" key={item.id}><div className="delivery-record-main"><strong>{item.title}</strong><small>{taskStatusLabels[item.status]} · {priorityLabel(item.priority)}{item.owner ? ` · ${item.owner}` : ''}{item.dueDate ? ` · 截止 ${item.dueDate}` : ''}</small>{item.description && <p>{item.description}</p>}</div><RecordActions onEdit={() => onEditRecord('task', item)} onDelete={() => onDeleteRecord('task', item)} disabled={busy} /></article>)}{!visibleTasks.length && <EmptyRows text={bundle.tasks.length ? '没有符合筛选条件的任务' : '尚未记录任务'} />}</div></div>;
  if (tab === 'issues') return <div className="delivery-section"><div className="delivery-section-heading"><div><h2>问题与风险</h2><span>{bundle.issues.length}</span></div><button type="button" className="primary-button" onClick={() => onEditRecord('issue')}><Icon name="plus" />新增问题或风险</button></div><div className="delivery-list-filters"><select value={issueStatusFilter} onChange={event => setIssueStatusFilter(event.target.value as typeof issueStatusFilter)} aria-label="按问题状态筛选"><option value="all">全部状态</option>{Object.entries(issueStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select value={issueTypeFilter} onChange={event => setIssueTypeFilter(event.target.value as typeof issueTypeFilter)} aria-label="按问题类型筛选"><option value="all">全部类型</option><option value="issue">问题</option><option value="blocker">阻塞</option><option value="risk">风险</option><option value="question">待确认</option><option value="change">变更</option></select><select value={issuePriorityFilter} onChange={event => setIssuePriorityFilter(event.target.value as typeof issuePriorityFilter)} aria-label="按问题优先级筛选"><option value="all">全部优先级</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select></div><div className="delivery-item-list">{visibleIssues.map(item => <article className={`delivery-record-row${item.id === focusedIssueId ? ' targeted' : ''}`} key={item.id}><div className="delivery-record-main"><strong>{item.title}</strong><small>{issueTypeLabel(item.type)} · {priorityLabel(item.priority)} · {issueStatusLabels[item.status]}{item.owner ? ` · ${item.owner}` : ''}{item.dueDate ? ` · 截止 ${item.dueDate}` : ''}</small>{item.description && <p>{item.description}</p>}{item.mitigation && <p>应对：{item.mitigation}</p>}</div><RecordActions onEdit={() => onEditRecord('issue', item)} onDelete={() => onDeleteRecord('issue', item)} disabled={busy} /></article>)}{!visibleIssues.length && <EmptyRows text={bundle.issues.length ? '没有符合筛选条件的问题或风险' : '尚未记录问题或风险'} />}</div></div>;
  if (tab === 'meetings') return <RecordSection title="会议" count={bundle.meetings.length} addLabel="新增会议记录" onAdd={() => onEditRecord('meeting')}><div className="delivery-item-list">{bundle.meetings.map(item => <article className="delivery-record-row" key={item.id}><div className="delivery-record-main"><strong>{item.title}</strong><small>{formatDateTime(item.meetingAt)} · {meetingTypeLabel(item.meetingType)}{item.attendees.length ? ` · ${item.attendees.join('、')}` : ''}</small>{item.minutes && <p className="meeting-minutes">{item.minutes}</p>}</div><RecordActions onEdit={() => onEditRecord('meeting', item)} onDelete={() => onDeleteRecord('meeting', item)} disabled={busy} /></article>)}{!bundle.meetings.length && <EmptyRows text="尚未记录会议" />}</div></RecordSection>;
  if (tab === 'documents') return <div className="delivery-section"><div className="delivery-section-heading"><div><h2>项目资料</h2><span>{bundle.documents.length} 份</span></div><div className="delivery-inline-actions"><select value={documentCategory} onChange={event => setDocumentCategory(event.target.value as DeliveryDocumentCategory)} aria-label="资料分类">{documentCategories.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><button type="button" className="primary-button" disabled={busy || project.status === 'archived'} onClick={onImportDocument}><Icon name="plus" />导入资料</button></div></div><p className="delivery-muted">导入的文件保存在应用本地数据目录，并校验文件大小与 SHA-256。</p><div className="delivery-item-list">{bundle.documents.map(item => <article className="delivery-record-row" key={item.id}><Icon name="file" /><div className="delivery-record-main"><strong>{item.fileName}</strong><small>{documentCategoryLabel(item.category)} · {formatBytes(item.sizeBytes)} · {item.extractedTextStatus === 'stale' ? '文件校验失败' : `导入于 ${formatDate(item.createdAt)}`}</small></div><div className="delivery-row-actions"><button type="button" className="secondary-button" disabled={busy || item.extractedTextStatus === 'stale'} onClick={() => void api.openDocument(project.id, item.id)}><Icon name="file" />打开</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void api.openDocument(project.id, item.id, true)}><Icon name="folder" />定位</button><button type="button" className="text-danger" disabled={busy || project.status === 'archived'} onClick={() => onDetachDocument(item.id, item.fileName)}>解除关联</button></div></article>)}{!bundle.documents.length && <EmptyRows text="尚未导入项目资料" />}</div></div>;
  if (tab === 'reports') {
    const selected = bundle.reports.find(item => item.id === selectedReportId);
    return <div className="delivery-report-layout"><section className="delivery-section delivery-report-list"><div className="delivery-section-heading"><h2>报告</h2><span>{bundle.reports.length}</span></div><label>周期开始<input type="date" value={reportStart} onChange={event => setReportStart(event.target.value)} /></label><label>周期结束<input type="date" value={reportEnd} onChange={event => setReportEnd(event.target.value)} /></label><div className="delivery-report-actions"><button type="button" className="secondary-button" disabled={busy || project.status === 'archived'} onClick={() => onBuildReport('weekly')}>生成周报数据草稿</button><button type="button" className="secondary-button" disabled={busy || project.status === 'archived'} onClick={() => onBuildReport('risk')}>生成风险摘要</button></div><button type="button" className="text-button" onClick={onOpenManuals}>打开操作手册</button><div className="delivery-report-items">{bundle.reports.map(report => <button type="button" key={report.id} className={report.id === selectedReportId ? 'selected' : ''} onClick={() => setSelectedReportId(report.id)}><strong>{report.title}</strong><small>{reportTypeLabel(report.reportType)} · {report.status === 'final' ? '正式' : '草稿'} · {formatDate(report.updatedAt)}</small></button>)}{!bundle.reports.length && <p className="delivery-muted">暂无报告。</p>}</div></section><section className="delivery-section delivery-report-editor"><div className="delivery-section-heading"><div><h2>{selected ? '编辑报告' : '报告内容'}</h2>{selected && <small>{selected.generatedAt ? `数据草稿生成于 ${formatDateTime(selected.generatedAt)}` : `更新时间 ${formatDateTime(selected.updatedAt)}`}</small>}</div><div className="delivery-inline-actions"><select value={reportStatus} onChange={event => setReportStatus(event.target.value as 'draft' | 'final')} disabled={!selected || project.status === 'archived'} aria-label="报告状态"><option value="draft">草稿</option><option value="final">正式</option></select><button type="button" className="secondary-button" disabled={!selected || busy} onClick={onCopyReport}><Icon name="copy" />复制 Markdown</button><button type="button" className="secondary-button" disabled={!selected || busy} onClick={() => selected && void onExportReport(selected.id)}><Icon name="download" />导出 Markdown</button><button type="button" className="primary-button" disabled={!selected || busy || project.status === 'archived'} onClick={onSaveReport}>保存</button></div></div>{selected ? <><input className="delivery-report-title" value={reportTitle} maxLength={160} onChange={event => setReportTitle(event.target.value)} aria-label="报告标题" /><textarea className="delivery-report-markdown" value={reportMarkdown} maxLength={30000} onChange={event => setReportMarkdown(event.target.value)} aria-label="Markdown 报告正文" /><small className="delivery-muted">数据快照 {selected.sourceSnapshotHash.slice(0, 12)} · 汇总草稿为确定性数据整理，不是 AI 生成。</small></> : <EmptyRows text="生成周报或风险摘要数据草稿后，可在此编辑和导出。" />}</section></div>;
  }
  return <div className="delivery-section"><div className="delivery-section-heading"><h2>项目活动</h2><span>{bundle.activities.length}</span></div>{bundle.activities.length ? <ActivityList activities={bundle.activities} projects={[project]} onSelectProject={() => undefined} /> : <EmptyRows text="暂无活动记录" />}</div>;
}

function ProjectDialog({ draft, codeProjects, busy, onChange, onSubmit, onClose }: { draft: ProjectDraft; codeProjects: Array<{ id: string; name: string }>; busy: boolean; onChange: (draft: ProjectDraft | null) => void; onSubmit: (event: FormEvent) => void; onClose: () => void }) {
  const set = (key: keyof ProjectDraft, value: string) => onChange({ ...draft, [key]: value });
  return <div className="delivery-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="delivery-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-project-dialog-title" onSubmit={onSubmit}><div className="delivery-dialog-heading"><div><h2 id="delivery-project-dialog-title">{draft.id ? '编辑交付项目' : '新建交付项目'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div><div className="delivery-form-grid"><Field label="项目名称" required><input autoFocus maxLength={120} required value={draft.name} onChange={event => set('name', event.target.value)} /></Field><Field label="客户名称" required><input maxLength={120} required value={draft.customerName} onChange={event => set('customerName', event.target.value)} /></Field><Field label="项目编号"><input maxLength={32} value={draft.code} onChange={event => set('code', event.target.value)} /></Field><Field label="系统类型"><select value={draft.systemType} onChange={event => set('systemType', event.target.value)}><option value="MES5">MES5</option><option value="MES6">MES6</option><option value="WMS">WMS</option><option value="OTHER">其他</option></select></Field><Field label="产品版本"><input value={draft.productVersions} onChange={event => set('productVersions', event.target.value)} placeholder="多个版本用逗号分隔" /></Field><Field label="项目阶段" required><input required maxLength={80} value={draft.stage} onChange={event => set('stage', event.target.value)} /></Field><Field label="项目经理"><input maxLength={80} value={draft.projectManager} onChange={event => set('projectManager', event.target.value)} /></Field><Field label="成员"><input value={draft.members} onChange={event => set('members', event.target.value)} placeholder="多个成员用逗号分隔" /></Field><Field label="计划开始"><input type="date" value={draft.plannedStartDate} onChange={event => set('plannedStartDate', event.target.value)} /></Field><Field label="计划结束"><input type="date" value={draft.plannedEndDate} onChange={event => set('plannedEndDate', event.target.value)} /></Field><Field label="项目状态"><select value={draft.status} onChange={event => set('status', event.target.value)}><option value="active">进行中</option><option value="on_hold">暂停</option><option value="completed">已完成</option></select></Field><Field label="Jira 项目键"><input maxLength={24} value={draft.jiraKey} onChange={event => set('jiraKey', event.target.value.toUpperCase())} placeholder="例如 MES-123" /></Field><Field label="关联本地代码项目" wide><select value={draft.linkedCodeProjectId} onChange={event => set('linkedCodeProjectId', event.target.value)}><option value="">暂不关联</option>{codeProjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="项目说明" wide><textarea rows={4} maxLength={8000} value={draft.description} onChange={event => set('description', event.target.value)} /></Field></div><div className="delivery-dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !draft.name.trim() || !draft.customerName.trim()}>保存项目</button></div></form></div>;
}

function TaskBatchDialog({ draft, milestones, busy, onChange, onSubmit, onClose }: { draft: TaskBatchDraft; milestones: DeliveryMilestone[]; busy: boolean; onChange: (value: TaskBatchDraft) => void; onSubmit: (event: FormEvent) => void; onClose: () => void }) {
  const count = draft.titles.split(/\r?\n/).map(title => title.trim()).filter(Boolean).length;
  function set(key: keyof TaskBatchDraft, value: string) { onChange({ ...draft, [key]: value }); }
  return <div className="delivery-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="delivery-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-task-batch-title" onSubmit={onSubmit}><div className="delivery-dialog-heading"><div><h2 id="delivery-task-batch-title">多行录入任务</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div><div className="delivery-form-grid"><Field label="任务标题" required wide><textarea autoFocus required rows={9} maxLength={20000} value={draft.titles} onChange={event => set('titles', event.target.value)} aria-describedby="delivery-task-batch-count" /></Field><small className="delivery-muted wide" id="delivery-task-batch-count">每行一条，空行会忽略。当前 {count} 条，最多 100 条。</small><Field label="负责人"><input maxLength={80} value={draft.owner} onChange={event => set('owner', event.target.value)} /></Field><Field label="优先级"><PrioritySelect value={draft.priority} onChange={value => set('priority', value)} /></Field><Field label="截止日期"><input type="date" value={draft.dueDate} onChange={event => set('dueDate', event.target.value)} /></Field><Field label="关联里程碑"><select value={draft.milestoneId} onChange={event => set('milestoneId', event.target.value)}><option value="">无</option>{milestones.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div><div className="delivery-dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || count < 1 || count > 100}>新增 {count} 条任务</button></div></form></div>;
}

function RecordDialog({ draft, bundle, busy, onChange, onSubmit, onClose }: { draft: { kind: RecordKind; value: RecordDraft }; bundle: DeliveryProjectBundle; busy: boolean; onChange: (value: { kind: RecordKind; value: RecordDraft } | null) => void; onSubmit: (event: FormEvent) => void; onClose: () => void }) {
  const value = draft.value;
  function set(key: keyof RecordDraft, next: string | number | string[]) { onChange({ ...draft, value: { ...value, [key]: next } }); }
  const typeTitle = draft.kind === 'milestone' ? '里程碑' : draft.kind === 'task' ? '任务' : draft.kind === 'issue' ? '问题或风险' : '会议记录';
  return <div className="delivery-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><form className="delivery-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-record-dialog-title" onSubmit={onSubmit}><div className="delivery-dialog-heading"><div><h2 id="delivery-record-dialog-title">{value.id ? '编辑' : '新增'}{typeTitle}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div><div className="delivery-form-grid"><Field label={draft.kind === 'milestone' ? '里程碑名称' : draft.kind === 'meeting' ? '会议主题' : '标题'} required wide><input autoFocus required maxLength={200} value={value.title} onChange={event => set('title', event.target.value)} /></Field>{draft.kind !== 'meeting' && <Field label="说明" wide><textarea rows={3} maxLength={8000} value={value.description} onChange={event => set('description', event.target.value)} /></Field>}
    {draft.kind === 'milestone' && <><Field label="状态"><select value={value.status} onChange={event => set('status', event.target.value)}><option value="not_started">未开始</option><option value="in_progress">进行中</option><option value="completed">已完成</option><option value="blocked">阻塞</option><option value="cancelled">已取消</option></select></Field><Field label="排序"><input type="number" min={0} value={value.sortOrder} onChange={event => set('sortOrder', Number(event.target.value))} /></Field><Field label="计划日期"><input type="date" value={value.plannedDate} onChange={event => set('plannedDate', event.target.value)} /></Field><Field label="实际完成日期"><input type="date" value={value.actualDate} onChange={event => set('actualDate', event.target.value)} /></Field><Field label="负责人"><input maxLength={80} value={value.owner} onChange={event => set('owner', event.target.value)} /></Field></>}
    {draft.kind === 'task' && <><Field label="状态"><select value={value.status} onChange={event => set('status', event.target.value)}><option value="todo">待办</option><option value="in_progress">进行中</option><option value="blocked">阻塞</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></Field><Field label="优先级"><PrioritySelect value={value.priority} onChange={next => set('priority', next)} /></Field><Field label="负责人"><input maxLength={80} value={value.owner} onChange={event => set('owner', event.target.value)} /></Field><Field label="关联里程碑"><select value={value.milestoneId} onChange={event => set('milestoneId', event.target.value)}><option value="">无</option>{bundle.milestones.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="开始日期"><input type="date" value={value.startDate} onChange={event => set('startDate', event.target.value)} /></Field><Field label="截止日期"><input type="date" value={value.dueDate} onChange={event => set('dueDate', event.target.value)} /></Field><Field label="完成说明" wide><textarea rows={2} maxLength={4000} value={value.completionNote} onChange={event => set('completionNote', event.target.value)} /></Field><Checklist label="关联问题" items={bundle.issues.map(item => ({ id: item.id, label: item.title }))} selected={value.linkedIssueIds} onChange={next => set('linkedIssueIds', next)} /><Checklist label="关联会议" items={bundle.meetings.map(item => ({ id: item.id, label: item.title }))} selected={value.linkedMeetingIds} onChange={next => set('linkedMeetingIds', next)} /></>}
    {draft.kind === 'issue' && <><Field label="类型"><select value={value.type} onChange={event => set('type', event.target.value)}><option value="issue">问题</option><option value="blocker">阻塞</option><option value="risk">风险</option><option value="question">待确认</option><option value="change">变更</option></select></Field><Field label="优先级"><PrioritySelect value={value.priority} onChange={next => set('priority', next)} /></Field><Field label="状态"><select value={value.status} onChange={event => set('status', event.target.value)}><option value="open">待处理</option><option value="in_progress">处理中</option><option value="pending_customer">等待客户</option><option value="resolved">已解决</option><option value="closed">已关闭</option></select></Field><Field label="负责人"><input maxLength={80} value={value.owner} onChange={event => set('owner', event.target.value)} /></Field><Field label="截止日期"><input type="date" value={value.dueDate} onChange={event => set('dueDate', event.target.value)} /></Field><Field label="关联里程碑"><select value={value.linkedMilestoneId} onChange={event => set('linkedMilestoneId', event.target.value)}><option value="">无</option>{bundle.milestones.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="应对措施" wide><textarea rows={2} maxLength={4000} value={value.mitigation} onChange={event => set('mitigation', event.target.value)} /></Field><Field label={`解决说明${['resolved', 'closed'].includes(value.status) ? '（必填）' : ''}`} wide><textarea rows={2} maxLength={4000} required={['resolved', 'closed'].includes(value.status)} value={value.resolution} onChange={event => set('resolution', event.target.value)} /></Field><Checklist label="关联任务" items={bundle.tasks.map(item => ({ id: item.id, label: item.title }))} selected={value.linkedTaskIds} onChange={next => set('linkedTaskIds', next)} /><Checklist label="关联会议" items={bundle.meetings.map(item => ({ id: item.id, label: item.title }))} selected={value.linkedMeetingIds} onChange={next => set('linkedMeetingIds', next)} /></>}
    {draft.kind === 'meeting' && <><Field label="会议时间" required><input type="datetime-local" required value={value.meetingAt} onChange={event => set('meetingAt', event.target.value)} /></Field><Field label="会议形式"><select value={value.meetingType} onChange={event => set('meetingType', event.target.value)}><option value="customer">客户会议</option><option value="internal">内部会议</option><option value="onsite">现场会议</option><option value="remote">远程会议</option><option value="other">其他</option></select></Field><Field label="参会人"><input value={value.attendees} onChange={event => set('attendees', event.target.value)} placeholder="多个姓名用逗号分隔" /></Field><Field label="关联里程碑"><select value={value.linkedMilestoneId} onChange={event => set('linkedMilestoneId', event.target.value)}><option value="">无</option>{bundle.milestones.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="会议纪要" wide><textarea rows={5} maxLength={30000} value={value.minutes} onChange={event => set('minutes', event.target.value)} /></Field><Checklist label="关联任务" items={bundle.tasks.map(item => ({ id: item.id, label: item.title }))} selected={value.linkedTaskIds} onChange={next => set('linkedTaskIds', next)} /><Checklist label="关联问题" items={bundle.issues.map(item => ({ id: item.id, label: item.title }))} selected={value.linkedIssueIds} onChange={next => set('linkedIssueIds', next)} /></>}
    </div><div className="delivery-dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !value.title.trim()}>保存</button></div></form></div>;
}

function Stat({ label, value, tone = '' }: { label: string; value: string | number; tone?: string }) { return <div className={`delivery-stat ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function Info({ label, value }: { label: string; value?: string }) { return <div><dt>{label}</dt><dd>{value || '未记录'}</dd></div>; }
function RecordSection({ title, count, addLabel, onAdd, children }: { title: string; count: number; addLabel: string; onAdd: () => void; children: ReactElement }) { return <div className="delivery-section"><div className="delivery-section-heading"><div><h2>{title}</h2><span>{count}</span></div><button type="button" className="primary-button" onClick={onAdd}><Icon name="plus" />{addLabel}</button></div>{children}</div>; }
function RecordActions({ onEdit, onDelete, disabled }: { onEdit: () => void; onDelete: () => void; disabled: boolean }) { return <div className="delivery-row-actions"><button type="button" className="icon-button" title="编辑" aria-label="编辑" disabled={disabled} onClick={onEdit}><Icon name="edit" /></button><button type="button" className="icon-button text-danger" title="删除" aria-label="删除" disabled={disabled} onClick={onDelete}><Icon name="close" /></button></div>; }
function ActivityList({ activities, projects, onSelectProject }: { activities: DeliveryActivity[]; projects: DeliveryProject[]; onSelectProject: (id: string) => void }) { return <div className="delivery-activity-list">{activities.map(item => { const project = projects.find(candidate => candidate.id === item.deliveryProjectId); return <button type="button" key={item.id} onClick={() => onSelectProject(item.deliveryProjectId)}><time>{formatDateTime(item.createdAt)}</time><span><strong>{item.summary}</strong><small>{project?.name ?? '交付项目'} · {item.actor}</small></span></button>; })}</div>; }
function EmptyRows({ text }: { text: string }) { return <div className="delivery-empty-state"><Icon name="file" /><span>{text}</span></div>; }
function Field({ label, required, wide, children }: { label: string; required?: boolean; wide?: boolean; children: ReactElement }) { return <label className={`delivery-field${wide ? ' wide' : ''}`}><span>{label}{required && <b> *</b>}</span>{children}</label>; }
function Checklist({ label, items, selected, onChange }: { label: string; items: Array<{ id: string; label: string }>; selected: string[]; onChange: (values: string[]) => void }) { return <fieldset className="delivery-checklist"><legend>{label}</legend>{items.length ? items.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={event => onChange(event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id))} /><span>{item.label}</span></label>) : <small>暂无可关联记录</small>}</fieldset>; }
function PrioritySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) { return <select value={value} onChange={event => onChange(event.target.value)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">紧急</option></select>; }
function optional(value: string): string | undefined { return value.trim() || undefined; }
function splitList(value: string): string[] { return [...new Set(value.split(/[,，、;；\n]/).map(item => item.trim()).filter(Boolean))]; }
function localDateTime(): string { const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); }
function localDate(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function localInputDateTime(value: string): string { const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); }
function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
function dateSpan(start?: string, end?: string): string { return start || end ? `${start || '未开始'} 至 ${end || '未结束'}` : '未设置'; }
function formatDate(value: string): string { return value.slice(0, 10); }
function formatDateTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function priorityLabel(value: string): string { return ({ low: '低优先级', medium: '中优先级', high: '高优先级', critical: '紧急' } as Record<string, string>)[value] ?? value; }
function issueTypeLabel(value: string): string { return ({ issue: '问题', blocker: '阻塞', risk: '风险', question: '待确认', change: '变更' } as Record<string, string>)[value] ?? value; }
function meetingTypeLabel(value: DeliveryMeeting['meetingType']): string { return ({ internal: '内部', customer: '客户', onsite: '现场', remote: '远程', other: '其他' })[value]; }
function documentCategoryLabel(value: DeliveryDocumentCategory): string { return documentCategories.find(item => item.value === value)?.label ?? value; }
function reportTypeLabel(value: DeliveryReport['reportType']): string { return ({ weekly: '周报', risk: '风险摘要', plan: '计划', meeting_summary: '会议纪要', other: '其他' })[value]; }
function recordTitle(kind: RecordKind, item: DeliveryMilestone | DeliveryTask | DeliveryIssue | DeliveryMeeting): string { return kind === 'milestone' ? (item as DeliveryMilestone).name : (item as DeliveryTask | DeliveryIssue | DeliveryMeeting).title; }

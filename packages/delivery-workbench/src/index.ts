import type { DeliveryActivity, DeliveryDashboardException, DeliveryHealth, DeliveryIssue, DeliveryMilestone, DeliveryOverview, DeliveryProject, DeliveryProjectBundle, DeliveryTask } from '../../domain/src/delivery-workbench';

export function deliveryHealth(input: Pick<DeliveryProjectBundle, 'project' | 'milestones' | 'tasks' | 'issues'>, today = localDate()): { health: DeliveryHealth; reasons: string[] } {
  const red: string[] = [];
  const yellow: string[] = [];
  const openIssues = input.issues.filter(item => !['resolved', 'closed'].includes(item.status));
  if (openIssues.some(item => item.priority === 'critical')) red.push('存在未关闭的 Critical 问题');
  if (openIssues.some(item => item.type === 'blocker')) red.push('存在尚未解除的阻塞项');
  if (input.milestones.some(item => item.status !== 'completed' && item.status !== 'cancelled' && !!item.plannedDate && item.plannedDate < today)) red.push('存在逾期里程碑');
  if (input.tasks.some(item => item.status !== 'completed' && item.status !== 'cancelled' && item.priority === 'high' && !!item.dueDate && item.dueDate < today)) yellow.push('存在逾期 High 任务');
  if (input.milestones.some(item => item.status !== 'completed' && item.status !== 'cancelled' && !!item.plannedDate && item.plannedDate >= today && item.plannedDate <= addDays(today, 7))) yellow.push('存在 7 天内到期的里程碑');
  if (openIssues.some(item => item.priority === 'high')) yellow.push('存在未关闭的 High 问题');
  if (input.project.status === 'active' && daysBetween(input.project.updatedAt.slice(0, 10), today) > 7) yellow.push('项目超过 7 天未更新');
  const enoughData = (input.tasks.length > 0 || input.milestones.length > 0) && [...input.tasks.map(item => item.dueDate), ...input.milestones.map(item => item.plannedDate)].some(Boolean);
  if (red.length) return { health: 'red', reasons: [...red, ...yellow] };
  if (yellow.length) return { health: 'yellow', reasons: yellow };
  if (!enoughData) return { health: 'gray', reasons: ['任务、里程碑或关键计划日期数据不足'] };
  return { health: 'green', reasons: ['当前数据未触发红色或黄色规则'] };
}

export function deliveryOverview(bundles: DeliveryProjectBundle[], activities: DeliveryActivity[], today = localDate()): DeliveryOverview {
  const active = bundles.filter(item => item.project.status === 'active');
  const currentProjects = bundles.filter(item => item.project.status !== 'archived');
  const todos = currentProjects.flatMap(bundle => bundle.tasks
    .filter(task => task.status !== 'cancelled')
    .map(task => ({ project: bundle.project, task })))
    .sort((a, b) => (a.task.dueDate ?? '9999-12-31').localeCompare(b.task.dueDate ?? '9999-12-31') || priorityRank(b.task.priority) - priorityRank(a.task.priority));
  const priorityIssues = currentProjects.flatMap(bundle => bundle.issues
    .filter(issue => (issue.priority === 'high' || issue.priority === 'critical') && !['resolved', 'closed'].includes(issue.status))
    .map(issue => ({ project: bundle.project, issue })))
    .sort((a, b) => priorityRank(b.issue.priority) - priorityRank(a.issue.priority) || (a.issue.dueDate ?? '9999-12-31').localeCompare(b.issue.dueDate ?? '9999-12-31'));
  const milestoneItems = currentProjects.flatMap(bundle => bundle.milestones
    .filter(item => {
      if (item.status === 'completed' || item.status === 'cancelled' || !item.plannedDate) return false;
      return item.plannedDate < today || item.plannedDate <= addDays(today, 7);
    })
    .map(milestone => ({ project: bundle.project, milestone })))
    .sort((a, b) => (a.milestone.plannedDate ?? '9999-12-31').localeCompare(b.milestone.plannedDate ?? '9999-12-31'));
  const exceptions: DeliveryDashboardException[] = currentProjects.flatMap(bundle => {
    const taskExceptions = bundle.tasks.flatMap(task => {
      const overdue = task.status !== 'completed' && task.status !== 'cancelled' && !!task.dueDate && task.dueDate < today;
      if (task.status !== 'blocked' && !overdue) return [];
      return [{ project: bundle.project, entityType: 'task' as const, entityId: task.id, title: task.title, reason: [task.status === 'blocked' ? '任务受阻' : '', overdue ? '任务已逾期' : ''].filter(Boolean).join(' · '), owner: task.owner, dueDate: task.dueDate, priority: task.priority }];
    });
    const issueExceptions = bundle.issues.flatMap(issue => {
      if (['resolved', 'closed'].includes(issue.status)) return [];
      const reasons = [issue.priority === 'critical' ? '紧急问题未关闭' : issue.priority === 'high' ? '高优先级问题未关闭' : '', issue.type === 'blocker' ? '存在阻塞项' : ''].filter(Boolean);
      if (!reasons.length) return [];
      return [{ project: bundle.project, entityType: 'issue' as const, entityId: issue.id, title: issue.title, reason: reasons.join(' · '), owner: issue.owner, dueDate: issue.dueDate, priority: issue.priority }];
    });
    const milestoneExceptions = bundle.milestones.flatMap(milestone => {
      if (milestone.status === 'completed' || milestone.status === 'cancelled' || !milestone.plannedDate || milestone.plannedDate >= today) return [];
      return [{ project: bundle.project, entityType: 'milestone' as const, entityId: milestone.id, title: milestone.name, reason: '里程碑已逾期', owner: milestone.owner, dueDate: milestone.plannedDate }];
    });
    return [...taskExceptions, ...issueExceptions, ...milestoneExceptions];
  }).sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || priorityRank('priority' in b ? b.priority : 'medium') - priorityRank('priority' in a ? a.priority : 'medium'));
  return {
    activeProjects: active.length,
    totalProjects: bundles.length,
    archivedProjects: bundles.filter(item => item.project.status === 'archived').length,
    incompleteTasks: bundles.reduce((count, bundle) => count + bundle.tasks.filter(task => !['completed', 'cancelled'].includes(task.status)).length, 0),
    overdueTasks: bundles.reduce((count, bundle) => count + bundle.tasks.filter(task => task.status !== 'completed' && task.status !== 'cancelled' && !!task.dueDate && task.dueDate < today).length, 0),
    overdueMilestones: bundles.reduce((count, bundle) => count + bundle.milestones.filter(item => !['completed', 'cancelled'].includes(item.status) && !!item.plannedDate && item.plannedDate < today).length, 0),
    highPriorityOpenIssues: bundles.reduce((count, bundle) => count + bundle.issues.filter(issue => issue.priority === 'high' || issue.priority === 'critical').filter(issue => !['resolved', 'closed'].includes(issue.status)).length, 0),
    upcomingMilestones: bundles.reduce((count, bundle) => count + bundle.milestones.filter(item => item.status !== 'completed' && item.status !== 'cancelled' && !!item.plannedDate && item.plannedDate >= today && item.plannedDate <= addDays(today, 7)).length, 0),
    attentionProjects: active.map(bundle => ({ project: bundle.project, health: bundle.health, reasons: bundle.healthReasons })).filter(item => item.health !== 'green').sort((a, b) => healthRank(a.health) - healthRank(b.health)),
    recentActivities: activities.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
    portfolio: bundles.map(bundle => {
      const completedTaskCount = bundle.tasks.filter(task => task.status === 'completed').length;
      const cancelledTaskCount = bundle.tasks.filter(task => task.status === 'cancelled').length;
      const taskCount = bundle.tasks.length;
      const plannedTaskCount = taskCount - cancelledTaskCount;
      return {
        project: bundle.project, health: bundle.health, healthReasons: bundle.healthReasons,
        taskCount, completedTaskCount, cancelledTaskCount,
        progressPercent: plannedTaskCount ? Math.round(completedTaskCount / plannedTaskCount * 100) : null,
        openIssueCount: bundle.issues.filter(issue => !['resolved', 'closed'].includes(issue.status)).length,
      };
    }),
    todos,
    priorityIssues,
    milestoneItems,
    exceptions,
  };
}

export function deliverySnapshotHash(value: unknown): string {
  const input = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function localDate(): string { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}
function healthRank(value: DeliveryHealth): number { return value === 'red' ? 0 : value === 'yellow' ? 1 : value === 'gray' ? 2 : 3; }
function priorityRank(value: string): number { return value === 'critical' ? 3 : value === 'high' ? 2 : value === 'medium' ? 1 : 0; }

export function deliveryReportMarkdown(bundle: DeliveryProjectBundle, type: 'weekly' | 'risk', snapshotHash: string, periodStart?: string, periodEnd?: string): string {
  const { project, tasks, milestones, issues, meetings, health, healthReasons } = bundle;
  const header = type === 'weekly' ? '项目周报数据草稿' : '项目风险巡检数据草稿';
  const lines = [`# ${project.name} - ${header}`, '', `> 本内容由已记录数据汇总生成，不是 AI 输出。项目状态为${health}，来源快照 ${snapshotHash}。`];
  if (periodStart || periodEnd) lines.push(`> 周期：${periodStart || '未指定'} 至 ${periodEnd || '未指定'}`);
  lines.push('', '## 项目情况', '', `- 客户：${project.customerName}`, `- 系统：${project.systemType}`, `- 阶段：${project.stage}`, `- 项目经理：${project.projectManager || '未记录'}`, `- 健康规则：${healthReasons.join('；')}`, '', '## 任务', '');
  const visibleTasks = tasks.filter(item => !periodStart || item.updatedAt.slice(0, 10) >= periodStart).filter(item => !periodEnd || item.updatedAt.slice(0, 10) <= periodEnd);
  lines.push(...(visibleTasks.length ? visibleTasks.map(item => `- ${item.title}（${taskStatus(item)}，${item.owner || '未分配'}${item.dueDate ? `，截止 ${item.dueDate}` : ''}）`) : ['- 周期内没有可用任务变更记录，无法还原历史状态。']));
  const activeIssues = issues.filter(item => !['resolved', 'closed'].includes(item.status));
  lines.push('', '## 里程碑', '', ...(milestones.length ? milestones.map(item => `- ${item.name}（${item.status}${item.plannedDate ? `，计划 ${item.plannedDate}` : '，未记录计划日期'}）`) : ['- 未记录里程碑。']), '', '## 未关闭问题与风险', '', ...(activeIssues.length ? activeIssues.map(item => `- ${item.title}（${item.type}/${item.priority}，${item.status}${item.owner ? `，${item.owner}` : '，未分配'}）`) : ['- 无未关闭问题记录。']), '', '## 会议', '', ...(meetings.length ? meetings.map(item => `- ${item.title}（${item.meetingAt.slice(0, 10)}）`) : ['- 未记录会议。']), '', '## 数据限制', '', '- 任务历史按当前记录的更新时间筛选，不代表已保存的历史快照。', '- 内容需要项目负责人复核后再作为正式报告使用。');
  return lines.join('\n');
}

function taskStatus(task: DeliveryTask): string { return task.status; }

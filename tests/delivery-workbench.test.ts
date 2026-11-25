import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore } from '../packages/storage/src/index';
import type { DeliveryActivity, DeliveryIssue, DeliveryMeeting, DeliveryMilestone, DeliveryProject, DeliveryProjectBundle, DeliveryTask } from '../packages/domain/src/delivery-workbench';
import { deliveryHealth, deliveryOverview } from '../packages/delivery-workbench/src';

test('删除交付记录时解除双向关联并追加动态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-delivery-workbench-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const projectId = randomUUID();
  const milestoneId = randomUUID();
  const taskId = randomUUID();
  const issueId = randomUUID();
  const meetingId = randomUUID();
  const now = '2026-11-24T00:00:00.000Z';
  const project: DeliveryProject = { id: projectId, name: '交付测试', customerName: '测试客户', systemType: 'MES6', productVersions: [], stage: '实施', status: 'active', members: [], createdAt: now, updatedAt: now };
  const milestone: DeliveryMilestone = { id: milestoneId, deliveryProjectId: projectId, name: '上线', sortOrder: 0, status: 'in_progress', createdAt: now, updatedAt: now };
  const task: DeliveryTask = { id: taskId, deliveryProjectId: projectId, milestoneId, title: '准备上线', priority: 'high', status: 'todo', linkedIssueIds: [issueId], linkedMeetingIds: [meetingId], createdAt: now, updatedAt: now };
  const issue: DeliveryIssue = { id: issueId, deliveryProjectId: projectId, title: '数据待确认', type: 'issue', priority: 'high', status: 'open', discoveredAt: now, linkedTaskIds: [taskId], linkedMilestoneId: milestoneId, linkedMeetingIds: [meetingId], sourceRefs: [], createdAt: now, updatedAt: now };
  const meeting: DeliveryMeeting = { id: meetingId, deliveryProjectId: projectId, title: '上线准备会', meetingAt: now, meetingType: 'customer', attendees: [], minutes: '', linkedTaskIds: [taskId], linkedIssueIds: [issueId], linkedMilestoneId: milestoneId, createdAt: now, updatedAt: now };
  const makeActivity = (entityId: string): DeliveryActivity => ({ id: randomUUID(), deliveryProjectId: projectId, entityType: 'milestone', entityId, action: 'deleted', summary: '删除测试记录', actor: '测试', createdAt: now });

  try {
    store.saveDeliveryProject(project);
    store.saveDeliveryRecord('delivery_milestones', milestone);
    store.saveDeliveryRecord('delivery_tasks', task);
    store.saveDeliveryRecord('delivery_issues', issue);
    store.saveDeliveryRecord('delivery_meetings', meeting);

    store.deleteDeliveryRecord('delivery_milestones', projectId, milestoneId, makeActivity(milestoneId));
    assert.equal(store.listDeliveryRecords<DeliveryTask>('delivery_tasks', projectId)[0].milestoneId, undefined);
    assert.equal(store.listDeliveryRecords<DeliveryIssue>('delivery_issues', projectId)[0].linkedMilestoneId, undefined);
    assert.equal(store.listDeliveryRecords<DeliveryMeeting>('delivery_meetings', projectId)[0].linkedMilestoneId, undefined);

    store.deleteDeliveryRecord('delivery_tasks', projectId, taskId, makeActivity(taskId));
    assert.deepEqual(store.listDeliveryRecords<DeliveryIssue>('delivery_issues', projectId)[0].linkedTaskIds, []);
    assert.deepEqual(store.listDeliveryRecords<DeliveryMeeting>('delivery_meetings', projectId)[0].linkedTaskIds, []);

    store.deleteDeliveryRecord('delivery_issues', projectId, issueId, makeActivity(issueId));
    assert.deepEqual(store.listDeliveryRecords<DeliveryMeeting>('delivery_meetings', projectId)[0].linkedIssueIds, []);

    store.deleteDeliveryRecord('delivery_meetings', projectId, meetingId, makeActivity(meetingId));
    assert.equal(store.listDeliveryRecords<DeliveryMeeting>('delivery_meetings', projectId).length, 0);
    assert.ok(store.listDeliveryActivities(projectId).some(item => item.action === 'deleted'));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('批量新增任务与动态使用同一事务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-delivery-task-batch-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const projectId = randomUUID();
  const now = '2026-11-24T00:00:00.000Z';
  const project: DeliveryProject = { id: projectId, name: '交付测试', customerName: '测试客户', systemType: 'MES6', productVersions: [], stage: '实施', status: 'active', members: [], createdAt: now, updatedAt: now };
  const makeTask = (title: string): DeliveryTask => ({ id: randomUUID(), deliveryProjectId: projectId, title, priority: 'medium', status: 'todo', linkedIssueIds: [], linkedMeetingIds: [], createdAt: now, updatedAt: now });
  const makeActivity = (task: DeliveryTask, activityProjectId = projectId): DeliveryActivity => ({ id: randomUUID(), deliveryProjectId: activityProjectId, entityType: 'task', entityId: task.id, action: 'created', summary: `新增任务“${task.title}”`, actor: '测试', createdAt: now });

  try {
    store.saveDeliveryProject(project);
    const first = [makeTask('任务一'), makeTask('任务二')];
    store.saveDeliveryTasks(first, first.map(task => makeActivity(task)));
    assert.equal(store.listDeliveryRecords<DeliveryTask>('delivery_tasks', projectId).length, 2);
    assert.equal(store.listDeliveryActivities(projectId).length, 2);

    const partial = [makeTask('事务回滚一'), makeTask('事务回滚二')];
    assert.throws(() => store.saveDeliveryTasks(partial, [makeActivity(partial[0]), makeActivity(partial[1], randomUUID())]));
    const saved = store.listDeliveryRecords<DeliveryTask>('delivery_tasks', projectId);
    assert.equal(saved.length, 2);
    assert.ok(saved.every(task => !task.title.startsWith('事务回滚')));
    assert.equal(store.listDeliveryActivities(projectId).length, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('交付健康规则将逾期里程碑与未关闭严重问题标为红色', () => {
  const now = '2026-11-24T00:00:00.000Z';
  const project: DeliveryProject = { id: randomUUID(), name: '交付测试', customerName: '测试客户', systemType: 'MES6', productVersions: [], stage: '实施', status: 'active', members: [], createdAt: now, updatedAt: now };
  const milestone: DeliveryMilestone = { id: randomUUID(), deliveryProjectId: project.id, name: '上线', sortOrder: 0, plannedDate: '2026-11-20', status: 'in_progress', createdAt: now, updatedAt: now };
  const issue: DeliveryIssue = { id: randomUUID(), deliveryProjectId: project.id, title: '生产阻塞', type: 'blocker', priority: 'critical', status: 'open', discoveredAt: now, linkedTaskIds: [], linkedMeetingIds: [], sourceRefs: [], createdAt: now, updatedAt: now };
  const result = deliveryHealth({ project, milestones: [milestone], tasks: [], issues: [issue] }, '2026-11-24');
  assert.equal(result.health, 'red');
  assert.ok(result.reasons.some(reason => reason.includes('逾期里程碑')));
  assert.ok(result.reasons.some(reason => reason.includes('Critical')));
});

test('交付总览聚合真实待办、风险和里程碑并按任务计划分母计算进度', () => {
  const now = '2026-11-25T00:00:00.000Z';
  const project: DeliveryProject = { id: randomUUID(), name: '交付测试', customerName: '测试客户', systemType: 'MES6', productVersions: [], stage: '实施', status: 'active', members: [], createdAt: now, updatedAt: now };
  const tasks: DeliveryTask[] = [
    { id: randomUUID(), deliveryProjectId: project.id, title: '逾期高优先级任务', priority: 'high', status: 'todo', owner: '张三', dueDate: '2026-11-24', linkedIssueIds: [], linkedMeetingIds: [], createdAt: now, updatedAt: now },
    { id: randomUUID(), deliveryProjectId: project.id, title: '完成任务', priority: 'medium', status: 'completed', linkedIssueIds: [], linkedMeetingIds: [], createdAt: now, updatedAt: now },
    { id: randomUUID(), deliveryProjectId: project.id, title: '取消任务', priority: 'medium', status: 'cancelled', linkedIssueIds: [], linkedMeetingIds: [], createdAt: now, updatedAt: now },
  ];
  const issue: DeliveryIssue = { id: randomUUID(), deliveryProjectId: project.id, title: '严重问题', type: 'blocker', priority: 'critical', status: 'open', owner: '李四', discoveredAt: now, dueDate: '2026-11-26', linkedTaskIds: [], linkedMeetingIds: [], sourceRefs: [], createdAt: now, updatedAt: now };
  const milestone: DeliveryMilestone = { id: randomUUID(), deliveryProjectId: project.id, name: '近期上线', sortOrder: 0, plannedDate: '2026-11-30', status: 'in_progress', createdAt: now, updatedAt: now };
  const bundle: DeliveryProjectBundle = { project, tasks, issues: [issue], milestones: [milestone], meetings: [], documents: [], reports: [], activities: [], health: 'red', healthReasons: ['存在尚未解除的阻塞项'] };

  const overview = deliveryOverview([bundle], [], '2026-11-25');

  assert.equal(overview.todos.length, 2);
  assert.equal(overview.todos[0].task.id, tasks[0].id);
  assert.ok(overview.todos.some(item => item.task.status === 'completed'));
  assert.equal(overview.priorityIssues[0].issue.id, issue.id);
  assert.equal(overview.milestoneItems[0].milestone.id, milestone.id);
  assert.equal(overview.portfolio[0].progressPercent, 50);
  assert.ok(overview.exceptions.some(item => item.entityId === tasks[0].id && item.owner === '张三'));
  assert.ok(overview.exceptions.some(item => item.entityId === issue.id && item.reason.includes('阻塞项')));
});

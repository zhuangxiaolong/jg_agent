import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { assertCommitBlocked } from './helpers/sqlite-commit';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { LocalStore } from '../packages/storage/src/index';
import type { AgentEvent, AgentTask, ExpertCollaborationPlan, ExpertPlannerContext, Project, Session } from '../packages/domain/src/index';
import { createAgentTask, createExpertCollaborationPlan, createTaskContract, transitionAgentTask } from '../packages/agent-orchestrator/src';
import { tokenizeManualQuery, type ManualChunk, type OperationManual } from '../packages/operation-manuals/src';

test('工作区会话无需项目，分组重启保留且删除工作区后成为独立会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-workspace-session-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  try {
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    store.saveWorkspace({ id: workspaceId, name: '日常事务', repositories: [] });
    const session: Session = { id: 'workspace-chat', workspaceId, title: '业务分析', workspacePath: join(root, 'session'), status: 'idle', createdAt: '2026-11-10T10:00:00Z', model: 'test-model' };
    store.saveSession(session);
    store.saveSession({ ...session, id: 'independent-chat', workspaceId: undefined });
    const event: AgentEvent = { id: 'event', sessionId: session.id, type: 'user', text: '分析工作计划', createdAt: session.createdAt };
    store.appendEvent(event);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getSession(session.id)?.workspaceId, workspaceId);
    assert.equal(store.getSession(session.id)?.projectId, undefined);
    assert.equal(store.getSession('independent-chat')?.workspaceId, undefined);
    assert.throws(() => store.saveSession({ ...session, id: 'invalid', workspaceId: '00000000-0000-4000-8000-000000000009' }), /工作区不存在/);
    store.deleteWorkspace(workspaceId);
    assert.equal(store.getSession(session.id)?.workspaceId, undefined);
    assert.deepEqual(store.events(session.id), [event]);
    assert.equal(store.listSessions().length, 2);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getSession(session.id)?.workspaceId, undefined);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('编排工具调用按 orchestration 和 toolCallId 幂等，未知结果禁止重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-orchestration-idempotency-'));
  const filename = join(root, 'agent.db');
  const store = await LocalStore.open(filename);
  try {
    const project: Project = { id: 'orchestration-project', path: join(root, 'project'), name: '编排测试', branch: 'main' };
    store.saveProject(project);
    store.saveSession({ id: 'orchestration-session', projectId: project.id, title: '编排测试', workspacePath: project.path, status: 'idle', createdAt: '2026-11-19T00:00:00.000Z', model: 'model', runtimeKind: 'codex' });
    const requestHash = 'a'.repeat(64);
    assert.deepEqual(store.beginOrchestrationToolCall({ sessionId: 'orchestration-session', orchestrationId: 'run-1', toolCallId: 'call-1', toolName: 'platform_agent_list_tasks', requestHash }), { state: 'started' });
    store.completeOrchestrationToolCall({ sessionId: 'orchestration-session', orchestrationId: 'run-1', toolCallId: 'call-1', requestHash, result: { tasks: [] } });
    assert.deepEqual(store.beginOrchestrationToolCall({ sessionId: 'orchestration-session', orchestrationId: 'run-1', toolCallId: 'call-1', toolName: 'platform_agent_list_tasks', requestHash }), { state: 'completed', result: { tasks: [] } });
    assert.throws(() => store.beginOrchestrationToolCall({ sessionId: 'orchestration-session', orchestrationId: 'run-1', toolCallId: 'call-1', toolName: 'platform_agent_get_task', requestHash }), /不同请求占用/);
    assert.deepEqual(store.beginOrchestrationToolCall({ sessionId: 'orchestration-session', orchestrationId: 'run-1', toolCallId: 'call-2', toolName: 'platform_agent_list_tasks', requestHash }), { state: 'started' });
    assert.deepEqual(store.beginOrchestrationToolCall({ sessionId: 'orchestration-session', orchestrationId: 'run-1', toolCallId: 'call-2', toolName: 'platform_agent_list_tasks', requestHash }), { state: 'unknown_outcome' });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('专家协作计划、任务契约和专家归属原子落库并在重启后恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-expert-collaboration-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const project: Project = { id: 'expert-project', path: join(root, 'project'), name: '专家协作测试', branch: 'main' };
  const session: Session = { id: 'expert-session', projectId: project.id, title: '专家协作测试', workspacePath: project.path, status: 'idle', createdAt: '2026-11-24T00:00:00.000Z', model: 'test-model', runtimeKind: 'codex' };
  const profiles: ExpertPlannerContext[] = [
    { id: 'mes-wms-backend', name: '后端开发专家', role: 'backend_developer', familyId: 'backend', enabled: true },
    { id: 'mes-wms-frontend', name: '前端开发专家', role: 'frontend_developer', familyId: 'frontend', enabled: true },
  ];
  try {
    store.saveProject(project);
    store.saveSession(session);
    const plan = createExpertCollaborationPlan({ sessionId: session.id, projectId: project.id, prompt: '分析后端接口和前端页面', profiles });
    const taskIds = new Map(plan.tasks.map(task => [task.taskKey, randomUUID()]));
    const entries = plan.tasks.map(spec => {
      const task = createAgentTask({ id: taskIds.get(spec.taskKey)!, sessionId: session.id, projectId: project.id, orchestrationId: plan.id, expertId: spec.expertId, expertPlanId: plan.id, name: `专家[${spec.expertName}] ${spec.objective.slice(0, 96)}`, role: spec.role, description: `${spec.objective}\n约束：${spec.constraints.join('；')}`, input: plan.prompt, dependencyIds: spec.dependencyKeys.map(key => taskIds.get(key)!), model: session.model, runtimeKind: 'codex', workspaceMode: 'read' });
      return { task, contract: createTaskContract(task, { createdBy: 'expert-planner', inputRefs: [], outputExpectations: spec.expectedOutput, acceptanceCriteria: spec.acceptanceCriteria, permissionProfile: `expert:${spec.expertId}` }), expectedContractVersion: 0 };
    });
    const executing: ExpertCollaborationPlan = { ...plan, tasks: plan.tasks.map(spec => ({ ...spec, agentTaskId: taskIds.get(spec.taskKey)! })), status: 'executing', confirmedAt: '2026-11-24T00:01:00.000Z', updatedAt: '2026-11-24T00:01:00.000Z' };
    store.saveExpertCollaborationPlan(plan);
    assertCommitBlocked(filename, () => store.saveAgentTaskContracts(entries, 'expert-planner', executing));
    assert.deepEqual(store.listAgentTasks(session.id), []);
    assert.equal(store.expertCollaborationPlan(plan.id)?.status, 'review');
    store.saveAgentTaskContracts(entries, 'expert-planner', executing);
    assert.equal(store.listAgentTasks(session.id).filter(task => task.expertPlanId === plan.id).length, plan.tasks.length);
    assert.equal(store.expertCollaborationPlan(plan.id)?.status, 'executing');
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.expertCollaborationPlan(plan.id)?.tasks.every(task => Boolean(task.agentTaskId)), true);
    assert.equal(store.listAgentTasks(session.id).every(task => task.expertPlanId === plan.id && task.contractVersion === 1), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('操作手册切片与词项索引随数据库迁移持久化并按产品和状态过滤', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-manual-index-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const timestamp = '2026-11-21T00:00:00.000Z';
  const manual: OperationManual = {
    id: 'manual-mes6', name: 'MES6 报工手册', productType: 'MES6', manualVersion: 'V2.1',
    originalName: 'mes6.md', originalStorageKey: 'knowledge/manuals/originals/manual-mes6/mes6.md', fileExtension: '.md',
    fileSize: 100, sha256: 'a'.repeat(64), status: 'ready', parserVersion: 'manual-parser-1', extractedChars: 30, chunkCount: 1,
    createdAt: timestamp, updatedAt: timestamp,
  };
  const chunk: ManualChunk = {
    id: 'chunk-mes6', manualId: manual.id, productType: 'MES6', manualVersion: 'V2.1', sectionPath: ['生产管理', '工单报工'],
    locator: { kind: 'pdf', page: 32 }, content: '扫描条码后确认工单报工。', contentHash: 'b'.repeat(64), tokenEstimate: 10, ordinal: 0,
  };
  try {
    store.completeOperationManualIndex(manual, [chunk]);
    assert.equal(store.searchOperationManualChunks(['MES6', 'COMMON'], tokenizeManualQuery('扫描条码工单报工')).length, 1);
    assert.equal(store.searchOperationManualChunks(['MES5', 'COMMON'], tokenizeManualQuery('扫描条码工单报工')).length, 0);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getOperationManual(manual.id)?.status, 'ready');
    assert.equal(store.listOperationManualChunks(manual.id)[0]?.locator.kind, 'pdf');
    assert.equal(store.searchOperationManualChunks(['MES6', 'COMMON'], tokenizeManualQuery('扫描条码工单报工'))[0]?.chunk.id, chunk.id);
    store.saveOperationManual({ ...manual, status: 'disabled', updatedAt: timestamp });
    assert.equal(store.searchOperationManualChunks(['MES6', 'COMMON'], tokenizeManualQuery('扫描条码工单报工')).length, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('SQLite 项目、会话、事件与模型元数据落盘，重启恢复中断状态并可备份', async () => {
  const root = await mkdtemp(join(tmpdir(), '精工 SQLite '));
  const path = join(root, '数据库', 'agent.db');
  const backup = join(root, '备份.db');
  const project: Project = { id: 'project-1', path: 'D:\\中文 项目', name: 'MES 测试', branch: 'main' };
  const session: Session = { id: 'session-1', projectId: project.id, title: '分析事务', workspacePath: 'D:\\workspace', branch: 'agent/session-1', status: 'running', createdAt: '2026-11-04T01:00:00.000Z', model: 'test-model', runtimeThreadId: 'thread-1' };
  const event: AgentEvent = { id: 'event-1', sessionId: session.id, type: 'user', text: '真实 SQLite 持久化验证', createdAt: '2026-11-04T01:00:01.000Z', attachments: [{ id: '00000000-0000-4000-8000-000000000099', name: '截图.png', mimeType: 'image/png', size: 42, kind: 'image' }] };
  let store: LocalStore | undefined;
  try {
    store = await LocalStore.open(path);
    assert.deepEqual(store.listProjects(), []);
    store.saveProject(project);
    store.saveSession(session);
    store.appendEvent(event);
    store.saveProvider({ baseUrl: 'https://model.example.invalid/v1', model: 'test-model', hasKey: true, apiKey: 'SYNTHETIC_CREDENTIAL_MUST_NOT_PERSIST' } as never);
    assert.throws(() => store!.appendEvent(event), /UNIQUE/);
    assert.equal(store.events(session.id).length, 1);
    store.close();
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
    assert.equal(bytes.includes(Buffer.from('SYNTHETIC_CREDENTIAL_MUST_NOT_PERSIST')), false);
    store = await LocalStore.open(path);
    assert.deepEqual(store.listProjects(), [project]);
    assert.equal(store.getSession(session.id)?.status, 'interrupted');
    assert.equal(store.getSession(session.id)?.runtimeThreadId, 'thread-1');
    assert.deepEqual(store.events(session.id)[0], event);
    assert.match(store.events(session.id)[1].text, /中断/);
    assert.equal(store.getProvider().model, 'test-model');
    assert.equal(store.getSession('missing'), undefined);
    store.backup(backup);
    assert.throws(() => store!.backup(path), /不能覆盖/);
    const restored = await LocalStore.open(backup);
    try { assert.equal(restored.events(session.id).length, 2); assert.equal(restored.listSessions().length, 1); } finally { restored.close(); }
    store.close();
    store = await LocalStore.open(path);
    assert.equal(store.events(session.id).length, 2, '再次启动不重复添加中断事件');
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

test('会话只读目录策略重启后保留且空范围不扩大权限，非法授权记录被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-read-access-'));
  const filename = join(root, 'agent.db');
  let store: LocalStore | undefined;
  const session: Session = { id: 'read-access-session', title: '受限资料会话', workspacePath: join(root, 'session'), status: 'idle', createdAt: '2026-11-11T00:00:00.000Z', model: 'test-model', readAccess: { mode: 'full', directories: [] } };
  try {
    store = await LocalStore.open(filename);
    store.saveSession(session);
    store.saveSession({ ...session, readAccess: { mode: 'restricted', directories: [{ id: 'grant-1', path: join(root, '资料') }] } });
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getSession(session.id)?.readAccess, { mode: 'restricted', directories: [{ id: 'grant-1', path: join(root, '资料') }] });
    store.saveSession({ ...session, readAccess: { mode: 'restricted', directories: [] } });
    assert.deepEqual(store.getSession(session.id)?.readAccess, { mode: 'restricted', directories: [] });
    assert.throws(() => store!.saveSession({ ...session, readAccess: { mode: 'restricted', directories: [{ id: '../grant', path: join(root, '资料') }] } }), /授权记录无效/);
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

test('外键失败和磁盘写入失败不会造成内存、磁盘状态分叉', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-storage-fail-'));
  const path = join(root, 'agent.db');
  const store = await LocalStore.open(path);
  try {
    assert.throws(() => store.saveSession({ id: 'bad', projectId: 'missing', title: '', workspacePath: '', branch: '', status: 'idle', createdAt: '', model: '' }), /FOREIGN KEY/);
    assert.equal(store.listSessions().length, 0);
    const project = { id: 'good', path: 'D:\\test', name: '测试', branch: 'main' };
    store.saveProject(project);
    assertCommitBlocked(path, () => store.saveProject({ ...project, name: '不应提交' }));
    assert.equal(store.listProjects()[0].name, '测试');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('损坏、无版本与更高版本数据库保留原文件并拒绝覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-storage-version-'));
  const path = join(root, 'agent.db');
  try {
    const corrupted = Buffer.from('not a sqlite database');
    await writeFile(path, corrupted);
    await assert.rejects(LocalStore.open(path), /损坏/);
    assert.deepEqual(await readFile(path), corrupted);
    const sql = await initSqlJs();
    const db = new sql.Database();
    db.run('CREATE TABLE other(value TEXT)');
    await writeFile(path, db.export());
    const unversioned = await readFile(path);
    await assert.rejects(LocalStore.open(path), /版本信息/);
    assert.deepEqual(await readFile(path), unversioned);
    db.run('PRAGMA user_version = 999');
    await writeFile(path, db.export());
    const newer = await readFile(path);
    await assert.rejects(LocalStore.open(path), /版本较新/);
    assert.deepEqual(await readFile(path), newer);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('v4 数据库迁移后允许无项目会话并保留事件及外键约束', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-storage-v5-'));
  const path = join(root, 'agent.db');
  let store: LocalStore | undefined;
  try {
    const sql = await initSqlJs();
    const db = new sql.Database();
    db.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), created_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), value TEXT NOT NULL);
      CREATE INDEX events_session ON events(session_id, seq);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO projects(id, path, value) VALUES ('legacy-project', 'D:/legacy', '{"id":"legacy-project"}');
      INSERT INTO sessions(id, project_id, created_at, value) VALUES ('legacy-session', 'legacy-project', '2026-11-04T00:00:00.000Z', '{"id":"legacy-session","projectId":"legacy-project","title":"旧会话","workspacePath":"D:/legacy","status":"completed","createdAt":"2026-11-04T00:00:00.000Z","model":"test"}');
      INSERT INTO events(id, session_id, value) VALUES ('legacy-event', 'legacy-session', '{"id":"legacy-event","sessionId":"legacy-session","type":"delta","text":"保留","createdAt":"2026-11-04T00:00:01.000Z"}');
      PRAGMA user_version = 4;
    `);
    await writeFile(path, db.export());
    db.close();

    store = await LocalStore.open(path, undefined, { recoverUnfinished: false });
    assert.deepEqual(store.getSession('legacy-session')?.projectId, 'legacy-project');
    assert.equal(store.events('legacy-session')[0].id, 'legacy-event');
    const readSession: Session = { id: 'read-session', title: '独立会话', workspacePath: join(root, 'session-cwd'), status: 'idle', createdAt: '2026-11-04T00:01:00.000Z', model: 'test' };
    const readEvent: AgentEvent = { id: 'read-event', sessionId: readSession.id, type: 'delta', text: '无项目事件', createdAt: '2026-11-04T00:01:01.000Z' };
    store.saveSession(readSession);
    store.appendEvent(readEvent);
    assert.equal(store.getSession(readSession.id)?.projectId, undefined);
    assert.deepEqual(store.events(readSession.id), [readEvent]);
    assert.throws(() => store!.saveSession({ ...readSession, id: 'bad-project', projectId: 'missing' }), /FOREIGN KEY/);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('子 Agent 任务可持久化，重启标为中断并阻塞后续任务且不伪造失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-agent-tasks-'));
  const path = join(root, 'agent.db');
  let store: LocalStore | undefined;
  const project: Project = { id: 'task-project', path: join(root, 'project'), name: '任务项目', branch: 'main' };
  const session: Session = { id: 'task-session', projectId: project.id, title: '任务测试', workspacePath: project.path, branch: 'main', status: 'idle', createdAt: '2026-11-10T00:00:00.000Z', model: 'test' };
  try {
    store = await LocalStore.open(path);
    store.saveProject(project);
    store.saveSession(session);
    const queued = createAgentTask({ id: 'queued', sessionId: session.id, projectId: project.id, name: '后续任务', role: 'testing', description: '等待执行', dependencyIds: ['running'] });
    const running = transitionAgentTask(createAgentTask({ id: 'running', sessionId: session.id, projectId: project.id, name: '当前任务', role: 'developer', description: '执行中' }), { status: 'RUNNING', now: '2026-11-10T00:01:00.000Z' });
    const tasks: AgentTask[] = [running, queued];
    store.saveAgentTasksForSession(session.id, tasks);
    assert.deepEqual(store.listAgentTasks(session.id).map(task => task.id).sort(), ['queued', 'running']);
    assert.throws(() => store!.saveSession({ ...session, projectId: 'another-project' }), /不能更改项目绑定/);
    store.close();

    store = await LocalStore.open(path);
    const recovered = store.listAgentTasks(session.id);
    const recoveredById = new Map(recovered.map(task => [task.id, task]));
    assert.equal(recoveredById.get('running')?.status, 'BLOCKED');
    assert.equal(recoveredById.get('running')?.executionStatus, 'INTERRUPTED');
    assert.match(recoveredById.get('running')?.error ?? '', /未自动重放/);
    assert.equal(recoveredById.get('queued')?.status, 'BLOCKED');
    assert.equal(recoveredById.get('queued')?.dependencyIds[0], 'running');
    store.deleteSession(session.id);
    assert.deepEqual(store.listAgentTasks(session.id), []);
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

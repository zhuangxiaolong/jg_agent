import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { LocalStore, LEGACY_PROVIDER_ID } from '../packages/storage/src/index';
import type { JiraIssue, ManagedDocument, Session } from '../packages/domain/src/index';
import type { WeComDeliveryRecord } from '../packages/wecom-notification/src/desktop-service';

test('v1 数据库真实升级到当前 schema，保留项目/会话/事件，迁移旧 Provider 且不重复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-migration-'));
  const filename = join(root, 'old.db');
  let store: LocalStore | undefined;
  try {
    const sql = await initSqlJs();
    const db = new sql.Database();
    db.run(`CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,value TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),created_at TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),value TEXT NOT NULL);
      CREATE INDEX events_session ON events(session_id,seq);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=1;`);
    const project = { id: 'old-project', name: '旧项目', path: '/old', branch: 'main' };
    const session: Session = { id: 'old-session', projectId: project.id, title: '历史会话', workspacePath: '/worktree', branch: 'agent/old', status: 'completed', createdAt: '2026-11-01T00:00:00Z', model: 'old-model' };
    const event = { id: 'old-event', sessionId: session.id, type: 'message', text: '旧版本消息', createdAt: '2026-11-01T00:00:01Z' };
    db.run('INSERT INTO projects VALUES (?,?,?)', [project.id, project.path, JSON.stringify(project)]);
    db.run('INSERT INTO sessions VALUES (?,?,?,?)', [session.id, project.id, session.createdAt, JSON.stringify(session)]);
    db.run('INSERT INTO events(id,session_id,value) VALUES (?,?,?)', [event.id, session.id, JSON.stringify(event)]);
    db.run('INSERT INTO settings VALUES (?,?)', ['provider', JSON.stringify({ baseUrl: 'https://old.example.invalid/v1', model: 'old-model', hasKey: true })]);
    await writeFile(filename, db.export()); db.close();
    store = await LocalStore.open(filename);
    assert.deepEqual(store.listProjects(), [project]);
    assert.deepEqual(store.getSession(session.id), session);
    assert.deepEqual(store.events(session.id), [event]);
    assert.deepEqual(store.listProviders(), [{ id: LEGACY_PROVIDER_ID, name: '原有模型服务', baseUrl: 'https://old.example.invalid/v1', models: ['old-model'], hasKey: true }]);
    store.saveSession({ ...session, providerId: LEGACY_PROVIDER_ID, mode: 'develop', system: 'MES6', runtimeCapabilitiesVersion: 2 });
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.listProviders().length, 1);
    assert.equal(store.getSession(session.id)?.mode, 'develop');
    assert.equal(store.getSession(session.id)?.providerId, LEGACY_PROVIDER_ID);
    assert.equal(store.getSession(session.id)?.system, 'MES6');
    assert.equal(store.getSession(session.id)?.runtimeCapabilitiesVersion, 2);
    const upgraded = new sql.Database(await readFile(filename));
    assert.equal(upgraded.exec('PRAGMA user_version')[0].values[0][0], 10); upgraded.close();
    store.deleteModelProvider(LEGACY_PROVIDER_ID); store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.listProviders(), [], '删除旧 Provider 后不会在重启时被旧配置复活');
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

test('v4 升级到 v5 后可持久化无项目只读会话与事件，外键保持完整', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-v5-no-project-session-'));
  const filename = join(root, 'v4.db');
  let store: LocalStore | undefined;
  try {
    const sql = await initSqlJs();
    const db = new sql.Database();
    db.run(`CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,value TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),created_at TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id),value TEXT NOT NULL);
      CREATE INDEX events_session ON events(session_id,seq);
      CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=4;`);
    const project = { id: 'legacy-project', name: '旧项目', path: '/legacy', branch: 'main' };
    const oldSession: Session = { id: 'legacy-session', projectId: project.id, title: '历史会话', workspacePath: '/legacy-worktree', branch: 'agent/legacy', status: 'completed', createdAt: '2026-11-01T00:00:00Z', model: 'legacy-model' };
    db.run('INSERT INTO projects VALUES (?,?,?)', [project.id, project.path, JSON.stringify(project)]);
    db.run('INSERT INTO sessions VALUES (?,?,?,?)', [oldSession.id, project.id, oldSession.createdAt, JSON.stringify(oldSession)]);
    db.run('INSERT INTO events(id,session_id,value) VALUES (?,?,?)', ['legacy-event', oldSession.id, JSON.stringify({ id: 'legacy-event', sessionId: oldSession.id, type: 'message', text: '旧事件', createdAt: oldSession.createdAt })]);
    await writeFile(filename, db.export());
    db.close();

    store = await LocalStore.open(filename);
    const noProjectSession = {
      id: 'standalone-read-session', projectId: undefined, title: '独立分析',
      workspacePath: root, branch: '', mode: 'read' as const,
      status: 'completed' as const, createdAt: '2026-11-10T00:00:00Z', model: 'analysis-model',
    } as unknown as Session;
    store.saveSession(noProjectSession);
    const event = { id: 'standalone-event', sessionId: noProjectSession.id, type: 'message' as const, text: '分析结果已保存', createdAt: '2026-11-10T00:00:01Z' };
    store.appendEvent(event);
    store.close(); store = await LocalStore.open(filename);

    assert.equal(store.getSession(noProjectSession.id)?.projectId, undefined);
    assert.equal(store.getSession(noProjectSession.id)?.mode, 'read');
    assert.equal(store.getSession(noProjectSession.id)?.workspacePath, root);
    assert.deepEqual(store.events(noProjectSession.id), [event]);
    assert.deepEqual(store.events(oldSession.id).map(item => item.id), ['legacy-event']);
    store.close(); store = undefined;

    const upgraded = new sql.Database(await readFile(filename));
    assert.equal(upgraded.exec('PRAGMA user_version')[0].values[0][0], 10);
    assert.deepEqual(upgraded.exec('PRAGMA foreign_key_check'), []);
    const nullProject = upgraded.exec('SELECT project_id FROM sessions WHERE id = \'standalone-read-session\'');
    assert.equal(nullProject[0].values[0][0], null);
    upgraded.close();
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

test('大型字典完整写入SQLite并重开，要求仍限80k且密码字段示例可正常保存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-large-storage-'));
  const filename = join(root, 'dictionary.db');
  let store = await LocalStore.open(filename);
  const content = '[工作表：结构]\nA1\t序号\tB1\t字段名\tC1\t类型\nA2\t1\tB2\tPassword\tC2\tString\n' + '完整字段说明，不截断。\n'.repeat(100000);
  const document: ManagedDocument = { id: 'large-dictionary', kind: 'dictionary', system: 'WMS', name: '字典.xlsx', content, digest: 'digest', createdAt: '2026-11-04T00:00:00Z', enabled: true };
  try {
    assert.ok(content.length > 1000000 && content.length < 2000000);
    store.saveDocument(document); store.close(); store = await LocalStore.open(filename);
    assert.equal(store.listDocuments()[0].content, content);
    store.setDocumentEnabled(document.id, false); store.close(); store = await LocalStore.open(filename);
    assert.equal(store.listDocuments()[0].content, content);
    assert.equal(store.listDocuments()[0].enabled, false);
    assert.throws(() => store.saveDocument({ ...document, id: 'large-requirement', kind: 'requirement', content: '字'.repeat(80001) }), /80000/);
    assert.throws(() => store.saveDocument({ ...document, id: 'too-large', content: '字'.repeat(2000001) }), /2000000/);
    const example = '字段名,类型\nPassword,String\npassword="synthetic-value"';
    store.saveDocument({ ...document, id: 'secret', content: example });
    assert.equal(store.listDocuments().find(item => item.id === 'secret')?.content, example);
    assert.equal(store.listDocuments().length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('配置、Provider、Jira、文档与记忆真实 CRUD 及重启持久化，不保存额外凭据属性', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-settings-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const secret = 'SYNTHETIC_SETTINGS_SECRET_MUST_NOT_PERSIST';
  const document: ManagedDocument = { id: 'doc-1', kind: 'dictionary', system: 'MES5', name: '字段说明.md', content: '# SFCS\n字段 QTY 表示数量。', digest: 'test-digest', enabled: true, createdAt: '2026-11-04T00:00:00Z' };
  try {
    assert.deepEqual(store.getPreferences(), { theme: 'dark', style: 'jinggong', completionSound: 'chime', updateMode: 'automatic' });
    store.savePreferences({ theme: 'light', style: 'minimal', apiKey: secret } as never);
    store.saveModelProvider({ id: 'provider-1', name: '中转站', baseUrl: 'https://model.example.invalid', models: ['model-a', 'model-b'], modelCatalog: [{ id: 'model-a', name: '模型 A' }, { id: 'model-unused', name: '未启用模型' }], hasKey: true, apiKey: secret } as never);
    store.saveJira({ baseUrl: 'https://jira.example.invalid', account: '研发账号', hasPassword: true, password: secret } as never);
    store.saveDocument({ ...document, apiKey: secret } as never);
    store.setDocumentEnabled(document.id, false);
    store.saveMemory({ id: 'memory-1', title: '构建说明', content: '先运行构建，再执行测试。', createdAt: '2026-11-04T00:00:00Z', password: secret } as never);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getPreferences(), { theme: 'light', style: 'minimal', completionSound: 'chime', updateMode: 'automatic' });
    assert.deepEqual(store.listProviders()[0].models, ['model-a', 'model-b']);
    assert.deepEqual(store.listProviders()[0].modelCatalog, [{ id: 'model-a', name: '模型 A' }]);
    assert.equal(store.getJira().account, '研发账号');
    assert.equal(store.listDocuments()[0].enabled, false);
    assert.equal(store.listMemories()[0].content, '先运行构建，再执行测试。');
    assert.equal((await readFile(filename)).includes(Buffer.from(secret)), false);
    const example = 'const apiKey = "synthetic-business-example";\npassword="synthetic-business-example"';
    store.saveDocument({ ...document, content: example });
    store.saveMemory({ id: 'memory-1', title: '密码字段示例', content: example, createdAt: '' });
    assert.equal(store.listDocuments()[0].content, example);
    assert.equal(store.listMemories()[0].content, example);
    assert.equal(store.listDocuments().length, 1); assert.equal(store.listMemories().length, 1);
    store.deleteDocument(document.id); store.deleteMemory('memory-1'); store.deleteModelProvider('provider-1');
    assert.deepEqual(store.listDocuments(), []); assert.deepEqual(store.listMemories(), []); assert.deepEqual(store.listProviders(), []);
    assert.throws(() => store.setDocumentEnabled('missing', true), /不存在/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Jira旧配置不补写默认，新项目及日期字段真实重开保留且不保存凭据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-jira-settings-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const legacy = { baseUrl: 'http://jira.example.invalid', account: '研发账号', hasPassword: true };
  const secret = 'SYNTHETIC_JIRA_CREDENTIAL_MUST_NOT_PERSIST';
  try {
    store.saveJira({ ...legacy, password: secret } as never);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getJira(), legacy);
    assert.equal(Object.hasOwn(store.getJira(), 'projectKey'), false);
    assert.equal(Object.hasOwn(store.getJira(), 'dateFieldId'), false);
    const configured = { ...legacy, projectKey: 'NEWDEVGROUP', dateFieldId: 'customfield_11116' };
    store.saveJira({ ...configured, password: secret, headers: { Authorization: `Basic ${secret}` } } as never);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getJira(), configured);
    assert.equal((await readFile(filename)).includes(Buffer.from(secret)), false);
    const sql = await initSqlJs(); const db = new sql.Database(await readFile(filename));
    assert.equal(db.exec('PRAGMA user_version')[0].values[0][0], 10); db.close();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

function jiraIssue(): JiraIssue {
  return {
    id: '12345', key: 'NEWDEVGROUP-123', summary: '修复工单状态查询并保留历史说明',
    description: '# 需求正文\n按工单编号查询；验收条件：无匹配记录时返回空结果。\n',
    status: '进行中', issueType: '需求', priority: '高', assignee: '研发负责人', updated: '2026-11-04T10:30:00+08:00',
    url: 'http://jira.example.invalid/browse/NEWDEVGROUP-123', fetchedAt: '2026-11-04T03:00:00Z',
    attachments: [{ id: '5001', name: '需求附件 中文.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 357484, url: 'http://jira.example.invalid/secure/attachment/5001/spec.xlsx' }]
  };
}

test('Jira会话任务快照重开保持原字段和概要，附件只存来源元数据且启动恢复保留关联', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-jira-snapshot-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const secret = 'SYNTHETIC_JIRA_AUTHORIZATION_MUST_NOT_PERSIST';
  const issue = jiraIssue();
  const session: Session = { id: 'jira-session', projectId: 'jira-project', title: issue.summary, workspacePath: 'D:\\workspaces\\jira', branch: 'agent/jira-session', status: 'running', createdAt: '2026-11-04T03:00:00Z', model: 'test-model', providerId: 'provider-1', mode: 'read', system: 'MES5', runtimeThreadId: 'runtime-thread', runtimeCapabilitiesVersion: 1, jiraIssue: issue };
  try {
    store.saveProject({ id: session.projectId!, path: 'D:\\项目 中文', name: 'MES5测试项目', branch: 'main' });
    store.saveSession({ ...session, password: secret, jiraIssue: { ...issue, password: secret, authorization: secret, attachments: issue.attachments.map(attachment => ({ ...attachment, password: secret, headers: { Authorization: `Bearer ${secret}` }, content: secret })) } } as never);
    assert.deepEqual(store.getSession(session.id)?.jiraIssue, issue);
    issue.attachments[0].name = '保存后调用方修改.xlsx';
    assert.equal(store.getSession(session.id)?.jiraIssue?.attachments[0].name, '需求附件 中文.xlsx');
    store.close(); store = await LocalStore.open(filename);
    const expected = jiraIssue(); const restored = store.getSession(session.id)!;
    assert.deepEqual(restored.jiraIssue, expected);
    assert.equal(restored.title, expected.summary);
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.providerId, session.providerId);
    assert.equal(restored.runtimeThreadId, session.runtimeThreadId);
    assert.equal(restored.runtimeCapabilitiesVersion, session.runtimeCapabilitiesVersion);
    assert.equal(restored.system, 'MES5');
    assert.deepEqual(store.listSessions()[0].jiraIssue, expected);
    assert.equal((await readFile(filename)).includes(Buffer.from(secret)), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Jira快照有界保存正文和附件，允许密码字段示例；超限及授权URL拒绝且不覆盖旧快照', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-jira-snapshot-limits-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const issue = jiraIssue();
  const session: Session = { id: 'jira-session', projectId: 'jira-project', title: issue.summary, workspacePath: 'D:\\workspaces\\jira', branch: 'agent/jira-session', status: 'completed', createdAt: '2026-11-04T03:00:00Z', model: 'test-model', jiraIssue: issue };
  try {
    store.saveProject({ id: session.projectId!, path: 'D:\\项目', name: '测试', branch: 'main' });
    const maximum = { ...issue, description: '文'.repeat(100000), attachments: Array.from({ length: 200 }, (_, index) => ({ ...issue.attachments[0], id: String(index) })) };
    store.saveSession({ ...session, jiraIssue: maximum });
    assert.equal(store.getSession(session.id)?.jiraIssue?.description.length, 100000);
    assert.equal(store.getSession(session.id)?.jiraIssue?.attachments.length, 200);
    const invalidCases: [JiraIssue, RegExp][] = [
      [{ ...issue, description: '文'.repeat(100001) }, /100000/],
      [{ ...maximum, attachments: [...maximum.attachments, maximum.attachments[0]] }, /200/],
      [{ ...issue, url: 'https://jira.example.invalid/browse/T-1?token=synthetic-credential-only' }, /授权凭据/],
      [{ ...issue, attachments: [{ ...issue.attachments[0], size: -1 }] }, /附件大小/]
    ];
    for (const [invalid, message] of invalidCases) {
      assert.throws(() => store.saveSession({ ...session, jiraIssue: invalid }), message);
      assert.deepEqual(store.getSession(session.id)?.jiraIssue, maximum);
    }
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getSession(session.id)?.jiraIssue, maximum);
    const sample = { ...issue, description: 'password="synthetic-credential-only"\nAuthorization: Bearer synthetic-business-token' };
    store.saveSession({ ...session, jiraIssue: sample });
    assert.deepEqual(store.getSession(session.id)?.jiraIssue, sample);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Jira附件空URL保留不可用链接元数据，重开会话不丢失；任务来源和非空授权URL仍拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-jira-unavailable-attachment-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const issue = jiraIssue();
  issue.attachments[0].url = '';
  const session: Session = { id: 'jira-session', projectId: 'jira-project', title: issue.summary, workspacePath: 'D:\\workspaces\\jira', branch: 'agent/jira-session', status: 'completed', createdAt: '2026-11-04T03:00:00Z', model: 'test-model', jiraIssue: issue };
  try {
    store.saveProject({ id: session.projectId!, path: 'D:\\项目', name: '测试', branch: 'main' });
    store.saveSession(session); store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getSession(session.id)?.jiraIssue, issue);
    assert.equal(store.getSession(session.id)?.jiraIssue?.attachments[0].url, '');
    assert.throws(() => store.saveSession({ ...session, jiraIssue: { ...issue, url: '' } }), /来源链接无效/);
    assert.throws(() => store.saveSession({ ...session, jiraIssue: { ...issue, attachments: [{ ...issue.attachments[0], url: 'https://jira.example.invalid/attachment?token=synthetic-value' }] } }), /授权凭据/);
    assert.deepEqual(store.getSession(session.id)?.jiraIssue, issue);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Workspace 与企业微信通知表独立持久化，投递幂等且 SQLite 拒绝 Webhook 明文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-workspace-wecom-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  const workspaceId = '2f84cf15-e596-4e5d-96fb-f7078d13ec8b';
  const targetId = '493679e1-7afd-42db-b80f-cf56ad51f7ba';
  const workspace = { id: workspaceId, name: 'MES Workspace', description: '', system: 'MES6', instructions: '', primaryRepositoryId: 'repo-1', repositories: [], createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z' };
  const record: WeComDeliveryRecord = {
    id: 'c7184c50-3131-46be-afce-2a8079f83bb4', idempotencyKey: 'event-1:' + targetId,
    kind: 'terminal', status: 'sending', eventId: 'event-1', platformSessionId: 'session-1', eventType: 'session.completed',
    targetId, targetName: '测试通知群', targetSnapshot: { id: targetId, name: '测试通知群', purpose: 'team_group', credentialRef: `wecom.webhook.${targetId}`, enabled: true, workspaceIds: ['2f84cf15-e596-4e5d-96fb-f7078d13ec8b'], runtimeKinds: ['claude_agent_sdk'], eventPolicy: { onCompleted: true, onFailed: true, onError: true, onCancelled: false, onInterrupted: true } },
    content: '任务已完成', attempts: 0, createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
  };
  try {
    store.saveWorkspace(workspace);
    assert.deepEqual(store.getWorkspace(workspaceId), workspace);
    store.saveWorkspace({ ...workspace, name: 'MES Workspace Updated' });
    assert.equal(store.listWorkspaces<typeof workspace>()[0].name, 'MES Workspace Updated');
    assert.throws(() => store.saveWorkspace({ ...workspace, description: 'x'.repeat(1024 * 1024) }), /1 MiB/);
    assert.equal(store.insertWeComDeliveryIfAbsent(record), true);
    assert.equal(store.insertWeComDeliveryIfAbsent({ ...record, id: '035af421-87f9-49f4-a8de-c4bcdd794d0f' }), false);
    assert.equal(store.findWeComDeliveryByIdempotencyKey(record.idempotencyKey)?.id, record.id);
    const oldSent = { ...record, id: '6c46ef34-d12c-414a-a63c-d88440f81811', idempotencyKey: 'old-sent', status: 'sent' as const, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z' };
    const recentFailed = { ...record, id: '97661796-2b8c-4663-907c-ae17a7738888', idempotencyKey: 'recent-failed', status: 'failed' as const, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:01.000Z' };
    assert.equal(store.insertWeComDeliveryIfAbsent(oldSent), true);
    assert.equal(store.insertWeComDeliveryIfAbsent(recentFailed), true);
    assert.equal(store.cleanupWeComDeliveries(90, new Date('2026-11-10T00:00:00.000Z')), 1);
    assert.equal(store.findWeComDeliveryById(oldSent.id), undefined);
    assert.equal(store.findWeComDeliveryById(record.id)?.status, 'sending', '清理不能删除仍待恢复的发送中记录');
    assert.equal(store.findWeComDeliveryById(recentFailed.id)?.status, 'failed');
    assert.throws(() => store.saveWeComTarget({ id: targetId, name: 'bad', webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-secret' }), /不能写入 SQLite/);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.listWeComDeliveries()[0].id, record.id);
    assert.deepEqual(store.listWeComDeliveries()[0].targetSnapshot.workspaceIds, [workspaceId]);
    assert.deepEqual(store.listWeComDeliveries()[0].targetSnapshot.runtimeKinds, ['claude_agent_sdk']);
    assert.equal(store.listWorkspaces<typeof workspace>()[0].name, 'MES Workspace Updated');
    const bytes = await readFile(filename);
    assert.equal(bytes.includes(Buffer.from('synthetic-secret')), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

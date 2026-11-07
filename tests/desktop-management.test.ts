import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src';
import { projectNameSchema, preferencesSchema, sessionAliasSchema, sessionOptionsSchema } from '../apps/desktop/src/main/security';
import type { JiraIssue, JiraSearchInput, JiraSearchPage } from '../packages/domain/src';

const scope = createHash('sha256').update('合成连接A').digest('hex');
const otherScope = createHash('sha256').update('合成连接B').digest('hex');
function issue(): JiraIssue { return { id: '1001', key: 'CD-435', summary: '合成任务', description: '合成验收资料', issueType: '任务', status: '新增', url: 'https://jira.example.invalid/browse/CD-435', fetchedAt: '2026-11-04T09:00:00.000Z', attachments: [] }; }
function page(task = issue()): JiraSearchPage { return { issues: [task], startAt: 0, maxResults: 50, total: 1, isLast: true, jql: 'cf[11116] = "2026-11-04"', timeZone: 'Asia/Shanghai', fetchedAt: task.fetchedAt }; }
const input: JiraSearchInput = { date: '2026-11-04', scope: 'daily', projectKey: '*', onlyMine: true };

test('修改项目显示名称仅更新SQLite元数据，保留路径、分支、隔离目录及自定义会话标题', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-rename-'));
  const repo = path.join(root, '原始目录'); await mkdir(repo);
  const filename = path.join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  try {
    const project = { id: 'project', name: '原名称', path: repo, branch: 'main' };
    store.saveProject(project);
    const session = { id: 'session', projectId: project.id, title: '原名称 · 只读分析', workspacePath: path.join(root, 'worktree'), branch: 'agent/session', status: 'idle' as const, createdAt: '2026-11-04T00:00:00Z', model: '' };
    store.saveSession(session); store.saveSession({ ...session, id: 'custom', title: '保留用户指定标题' });
    const renamed = store.renameProject(project.id, '  新显示名称  ');
    assert.deepEqual(renamed, { ...project, name: '新显示名称' });
    assert.equal(store.getSession('session')!.title, '新显示名称 · 只读分析');
    assert.equal(store.getSession('custom')!.title, '保留用户指定标题');
    assert.equal(store.getSession('session')!.workspacePath, session.workspacePath);
    assert.equal(store.getSession('session')!.branch, session.branch);
    for (const name of ['', '  ', '中'.repeat(101), '一\n二']) assert.throws(() => store.renameProject(project.id, name));
    assert.throws(() => store.renameProject('missing', '新名称'), /不存在/);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.listProjects(), [renamed]);
    assert.ok((await stat(repo)).isDirectory());
    assert.equal(projectNameSchema.safeParse('名称\n换行').success, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Jira抓取记录与详情在真实SQLite重开恢复，按连接隔离、更新同条件并限制最近50条', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-history-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    const saved = store.saveJiraQuery(scope, input, page());
    const detailed = { ...issue(), description: '已读取的完整需求正文' };
    store.saveJiraIssue(scope, detailed);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.listJiraQueries(scope), [saved]);
    assert.equal(store.getCachedJiraIssue(scope, 'CD-435')!.description, detailed.description);
    assert.deepEqual(store.listJiraQueries(otherScope), []);
    assert.equal(store.getCachedJiraIssue(otherScope, 'CD-435'), undefined);
    const replacement = store.saveJiraQuery(scope, input, { ...page(), issues: [], total: 0 });
    assert.equal(replacement.id, saved.id);
    assert.equal(store.listJiraQueries(scope).length, 1);
    assert.deepEqual(store.listJiraQueries(scope)[0].page.issues, []);
    for (let n = 0; n < 60; n++) store.saveJiraQuery(scope, { ...input, startAt: n * 50 }, { ...page(), startAt: n * 50 });
    assert.equal(store.listJiraQueries(scope).length, 50);
    assert.throws(() => store.saveJiraQuery('unsafe:%', input, page()), /范围/);
    assert.throws(() => store.saveJiraQuery(scope, { ...input, projectKey: 'CD" OR project=OTHER' }, page()), /条件/);
    const example = 'api_key="synthetic-business-example"';
    store.saveJiraIssue(scope, { ...issue(), description: example, fetchedAt: '2099-01-01T00:00:00Z' });
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getCachedJiraIssue(scope, issue().key)?.description, example);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('图片摘要随会话持久化，原路径和二进制不进入快照；新增主题真实保存并重开', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-image-meta-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    store.saveProject({ id: 'project', name: '合成', path: 'D:\\fixture', branch: 'main' });
    const snapshot = { ...issue(), attachments: [{ id: '11', name: '任务图片.png', mimeType: 'image/png', size: 68, url: 'https://jira.example.invalid/secure/attachment/11/image.png', localImage: { sha256: 'a'.repeat(64), mimeType: 'image/png' as const, size: 68, path: '不应保存的本地路径' } }] };
    const session = { id: 'session', projectId: 'project', title: '图片快照', workspacePath: 'D:\\fixture-work', branch: 'agent/session', status: 'idle' as const, createdAt: '2026-11-04T00:00:00Z', model: '', jiraIssue: snapshot };
    store.saveSession(session); store.saveJiraIssue(scope, snapshot);
    for (const theme of ['purple', 'black', 'sky', 'grass'] as const) { const value = preferencesSchema.parse({ theme, style: 'minimal' }); store.savePreferences(value); assert.deepEqual(store.getPreferences(), value); }
    assert.equal(preferencesSchema.safeParse({ theme: 'unknown', style: 'minimal' }).success, false);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.getSession('session')!.jiraIssue!.attachments[0].localImage, { sha256: 'a'.repeat(64), mimeType: 'image/png', size: 68 });
    assert.equal(store.getCachedJiraIssue(scope, 'CD-435')!.attachments[0].localImage!.sha256, 'a'.repeat(64));
    assert.equal(store.getPreferences().theme, 'grass');
    assert.equal((await readFile(filename)).includes(Buffer.from('不应保存的本地路径')), false);
    assert.throws(() => store.saveSession({ ...session, jiraIssue: { ...snapshot, attachments: [{ ...snapshot.attachments[0], localImage: { sha256: '../path', mimeType: 'image/png', size: 68 } }] } }), /摘要/);
    assert.equal(store.getSession('session')!.jiraIssue!.attachments[0].localImage!.sha256, 'a'.repeat(64));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('会话别名独立默认标题和Jira关联，推理强度逐会话保存、重开和恢复默认', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-preferences-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    const project = { id: 'project', name: '合成项目', path: 'D:\\fixture', branch: 'main' }; store.saveProject(project);
    const initial = { id: 'session', projectId: project.id, title: 'CD-435 · 合成项目 · 只读分析', workspacePath: 'D:\\fixture-work', branch: 'agent/session', status: 'idle' as const, createdAt: '2026-11-04T00:00:00Z', model: '', jiraIssue: issue() };
    store.saveSession(initial);
    const renamed = store.renameSession(initial.id, '  排查过站问题  ');
    assert.equal(renamed.alias, '排查过站问题'); assert.equal(renamed.title, initial.title);
    assert.deepEqual(renamed.jiraIssue, initial.jiraIssue); assert.equal(renamed.workspacePath, initial.workspacePath);
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      store.saveSession({ ...store.getSession(initial.id)!, reasoningEffort: effort });
      assert.equal(store.getSession(initial.id)!.reasoningEffort, effort);
    }
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getSession(initial.id)!.alias, '排查过站问题');
    assert.equal(store.getSession(initial.id)!.reasoningEffort, 'xhigh');
    store.renameProject(project.id, '新项目名');
    assert.equal(store.getSession(initial.id)!.alias, '排查过站问题');
    assert.equal(store.renameSession(initial.id, '  ').alias, undefined);
    store.saveSession({ ...store.getSession(initial.id)!, reasoningEffort: undefined });
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getSession(initial.id)!.reasoningEffort, undefined);
    assert.equal(store.getSession(initial.id)!.alias, undefined);
    for (const alias of ['x'.repeat(101), '一\n二']) assert.equal(sessionAliasSchema.safeParse(alias).success, false);
    const options = { providerId: 'legacy-default', model: 'fixture-model', mode: 'read' };
    assert.equal(sessionOptionsSchema.safeParse({ ...options, reasoningEffort: 'high' }).success, true);
    assert.equal(sessionOptionsSchema.safeParse({ ...options, reasoningEffort: 'unbounded' }).success, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

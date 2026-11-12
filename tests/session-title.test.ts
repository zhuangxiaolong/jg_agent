import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { JiraIssue, RuntimeKind, Session } from '../packages/domain/src';
import { contentTitledSession, initialSessionTitle, sessionTitleFromPrompt } from '../packages/domain/src/session-title';
import { LocalStore } from '../packages/storage/src';
import { sessionDisplayName } from '../apps/desktop/src/renderer/branding';
import { exportShare, parseShare } from '../apps/desktop/src/main/sharing';

const createdAt = '2026-11-11T01:00:00.000Z';
const issue: JiraIssue = {
  id: 'issue-1', key: 'TEST-123', summary: '修复过站查询报错', description: '合成测试需求',
  issueType: '任务', status: '新增', url: 'https://jira.example.invalid/browse/TEST-123',
  fetchedAt: createdAt, attachments: [],
};
function session(overrides: Partial<Session> = {}): Session {
  return { id: 'session', title: '新会话', workspacePath: 'D:\\fixture-session', status: 'idle', createdAt, model: 'fixture-model', runtimeKind: 'codex', ...overrides };
}

test('新建会话使用非日期占位名称，Jira 会话使用任务编号与概要', () => {
  assert.equal(initialSessionTitle(), '新会话');
  assert.equal(initialSessionTitle(issue), 'TEST-123 · 修复过站查询报错');
  const title = initialSessionTitle({ key: issue.key, summary: '  修复过站\n查询报错  ' });
  assert.match(title, /TEST-123/);
  assert.match(title, /修复过站/);
  assert.doesNotMatch(title, /[\r\n]/);
});

test('自动标题提取首条有效内容，清理 Markdown 和礼貌前缀', () => {
  const title = sessionTitleFromPrompt('\n# 请帮我修复过站查询报错\n\n补充：沿用原有事务边界。');
  assert.equal(title, '修复过站查询报错');
  const formatted = sessionTitleFromPrompt('> **分析库存差异原因**\n下一步再处理。');
  assert.match(formatted!, /分析库存差异原因/);
  assert.doesNotMatch(formatted!, /[*#>\r\n]/);
});

test('自动标题跳过代码块及空内容，礼貌语清理不损坏业务用语', () => {
  assert.equal(sessionTitleFromPrompt('  \n\t '), undefined);
  assert.equal(sessionTitleFromPrompt('```sql\nSELECT * FROM INVENTORY;\n```'), undefined);
  assert.match(sessionTitleFromPrompt('```sql\nSELECT 1;\n```\n分析库存差异原因')!, /分析库存差异原因/);
  assert.equal(sessionTitleFromPrompt('请假申请流程优化'), '请假申请流程优化');
  assert.equal(sessionTitleFromPrompt('请款流程检查'), '请款流程检查');
});

test('Markdown 清理保留字段名中的下划线和代码标识符', () => {
  for (const prompt of ['修复 SN_CODE 查询', '修复 `SN_CODE` 查询', '修复 **SN_CODE** 查询']) {
    assert.equal(sessionTitleFromPrompt(prompt), '修复 SN_CODE 查询');
  }
  const title = sessionTitleFromPrompt('检查 __WORK_ORDER__ 与 `SN_CODE` 映射');
  assert.match(title!, /WORK_ORDER/);
  assert.match(title!, /SN_CODE/);
});

test('自动标题支持英文且限制 Unicode 字符数，不截断表情代理对', () => {
  assert.match(sessionTitleFromPrompt('Investigate station query failure')!, /Investigate/);
  const title = sessionTitleFromPrompt('排查' + '😀'.repeat(40))!;
  assert.ok(Array.from(title).length <= 32);
  assert.ok(title.endsWith('…'));
  assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  assert.equal(sessionTitleFromPrompt('修复过站查询报错'), '修复过站查询报错');
});

test('首次命名保留会话元数据，已生成内容标题不随后续轮次改变', () => {
  const original = session({ projectId: 'project', branch: 'agent/fixture', providerId: 'provider', reasoningEffort: 'high', runtimeThreadId: 'thread', unreadCompletionId: 'completion' });
  const named = contentTitledSession(original, '修复过站查询报错', 'MES5 项目');
  assert.notEqual(named, original);
  assert.equal(named.title, '修复过站查询报错');
  assert.equal(named.titleSource, 'content');
  assert.deepEqual({ ...named, title: original.title, titleSource: undefined }, { ...original, titleSource: undefined });
  assert.equal(original.title, '新会话');
  assert.equal(contentTitledSession(named, '分析库存差异原因', 'MES5 项目'), named);
  assert.equal(contentTitledSession(original, '   '), original);
});

test('历史默认日期名称可按内容命名，自定义标题与导入会话保留', () => {
  for (const title of ['会话 2026/11/11 09:00', 'MES5 项目 · 会话 2026/11/11 09:00']) {
    const named = contentTitledSession(session({ title }), '修复过站查询报错', 'MES5 项目');
    assert.equal(named.title, '修复过站查询报错');
    assert.equal(named.titleSource, 'content');
  }
  for (const original of [session({ title: '手工整理的验收报告' }), session({ imported: true }), session({ title: '会话 2026/11/11 09:00', imported: true })]) {
    assert.equal(contentTitledSession(original, '修复过站查询报错', 'MES5 项目'), original);
  }
});

test('手工别名优先于内容标题，Jira 内容标题优先于默认任务概要', () => {
  const jira = session({ title: initialSessionTitle(issue), jiraIssue: issue });
  assert.equal(sessionDisplayName(jira), 'TEST-123 · 修复过站查询报错');
  const named = contentTitledSession(jira, '分析 Oracle 查询返回空值');
  assert.equal(named.titleSource, 'content');
  assert.deepEqual(named.jiraIssue, issue);
  assert.equal(sessionDisplayName(named), named.title);
  assert.equal(sessionDisplayName({ ...named, alias: '人工确认名称' }), '人工确认名称');
});

test('真实 SQLite 持久化内容标题，三种 Runtime 重开后保持且后续轮次不覆盖', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-title-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  const runtimes: RuntimeKind[] = ['codex', 'jinggong', 'claude_agent_sdk'];
  try {
    store.saveProject({ id: 'project', name: 'MES5 项目', path: root, branch: 'main' });
    for (const runtimeKind of runtimes) {
      const original = session({ id: runtimeKind, projectId: 'project', workspacePath: root, runtimeKind, branch: 'agent/fixture', runtimeThreadId: `thread-${runtimeKind}`, runtimeNativeSessionId: `native-${runtimeKind}` });
      store.saveSession(original);
      const named = store.nameSessionFromContent(original.id, '修复过站查询报错');
      assert.equal(named.title, '修复过站查询报错');
      assert.equal(named.titleSource, 'content');
      assert.equal(named.runtimeKind, runtimeKind);
      assert.equal(named.runtimeThreadId, original.runtimeThreadId);
      assert.equal(named.runtimeNativeSessionId, original.runtimeNativeSessionId);
    }
    store.close(); store = await LocalStore.open(filename);
    for (const runtimeKind of runtimes) {
      const saved = store.getSession(runtimeKind)!;
      assert.equal(saved.title, '修复过站查询报错');
      assert.equal(saved.titleSource, 'content');
      assert.equal(store.nameSessionFromContent(runtimeKind, '分析库存差异原因').title, saved.title);
      store.saveSession({ ...saved, runtimeKind: runtimeKind === 'codex' ? 'claude_agent_sdk' : 'codex', model: 'other-model', runtimeThreadId: undefined });
      assert.equal(store.getSession(runtimeKind)!.titleSource, 'content');
      assert.equal(store.getSession(runtimeKind)!.title, saved.title);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('真实 SQLite 保留手工别名，清空别名后恢复内容标题', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-title-alias-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    store.saveSession(session({ workspacePath: root }));
    store.nameSessionFromContent('session', '修复过站查询报错');
    store.renameSession('session', '人工确认名称');
    const named = store.nameSessionFromContent('session', '后续任务不应覆盖已有名称');
    assert.equal(named.alias, '人工确认名称');
    assert.equal(named.title, '修复过站查询报错');
    store.close(); store = await LocalStore.open(filename);
    assert.equal(sessionDisplayName(store.getSession('session')!), '人工确认名称');
    const reset = store.renameSession('session', '  ');
    assert.equal(reset.alias, undefined);
    assert.equal(reset.titleSource, 'content');
    assert.equal(sessionDisplayName(reset), '修复过站查询报错');
    store.close(); store = await LocalStore.open(filename);
    assert.equal(sessionDisplayName(store.getSession('session')!), '修复过站查询报错');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('存储层命名只处理指定会话，项目改名与导入会话不覆盖内容标题', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-title-scope-'));
  let store = await LocalStore.open(path.join(root, 'agent.db'));
  try {
    store.saveProject({ id: 'project', name: 'MES5 项目', path: root, branch: 'main' });
    store.saveSession(session({ id: 'legacy', projectId: 'project', title: 'MES5 项目 · 会话 2026/11/11 09:00', workspacePath: root }));
    store.saveSession(session({ id: 'custom', title: '人工指定任务', workspacePath: root }));
    store.saveSession(session({ id: 'imported', title: '会话 2026/11/11 09:00', imported: true, workspacePath: root }));
    const first = store.nameSessionFromContent('legacy', '修复过站查询报错');
    assert.equal(first.titleSource, 'content');
    assert.equal(store.getSession('custom')!.title, '人工指定任务');
    assert.equal(store.nameSessionFromContent('custom', '其他任务').title, '人工指定任务');
    assert.equal(store.nameSessionFromContent('imported', '其他任务').title, '会话 2026/11/11 09:00');
    store.renameProject('project', '已改名项目');
    assert.equal(store.getSession('legacy')!.title, first.title);
    assert.throws(() => store.nameSessionFromContent('missing', '其他任务'), /不存在/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('Jira 内容标题与手工别名在分享导出和界面展示中一致', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-title-sharing-'));
  const store = await LocalStore.open(path.join(root, 'agent.db'));
  try {
    store.saveSession(session({ title: initialSessionTitle(issue), jiraIssue: issue, workspacePath: root }));
    const named = store.nameSessionFromContent('session', '分析 Oracle 返回空值原因');
    assert.equal(named.titleSource, 'content');
    const bundle = parseShare(exportShare(store, { kind: 'session', sessionId: named.id }, text => text));
    assert.equal(bundle.session!.title, sessionDisplayName(named));
    assert.match(bundle.session!.title, /Oracle 返回空值原因/);
    const renamed = store.renameSession(named.id, '人工确认的过站任务');
    const aliased = parseShare(exportShare(store, { kind: 'session', sessionId: named.id }, text => text));
    assert.equal(aliased.session!.title, sessionDisplayName(renamed));
    assert.equal(aliased.session!.title, '人工确认的过站任务');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

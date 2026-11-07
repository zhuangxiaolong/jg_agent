import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStore } from '../packages/storage/src';
import type { AgentEvent, Session } from '../packages/domain/src';
import { rememberCompletedSession, sessionMemories } from '../apps/desktop/src/main/session-memory';
import { DEFAULT_UPDATE_URL, updateFeed } from '../packages/domain/src/updates';

test('自动记忆按真实完成轮次摘录、重复完成去重、多轮更新同一条并按项目隔离，重启仍保留', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-memory-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    store.saveProject({ id: 'project', name: '项目', branch: 'main', path: root });
    const session: Session = { id: 'session', projectId: 'project', title: '验证构建', status: 'completed', workspacePath: root, branch: 'agent/test', model: 'model', createdAt: new Date().toISOString() };
    store.saveSession(session);
    const event = (id: string, type: AgentEvent['type'], text: string) => store.appendEvent({ id, type, text, sessionId: session.id, createdAt: new Date().toISOString() });
    event('u1', 'user', '分析构建要求'); event('m1', 'message', '现有脚本要求先构建后测试。'); event('c1', 'status', 'completed');
    const first = rememberCompletedSession(store, session, () => {});
    assert.ok(first); assert.match(first.content, /未经独立核实/); assert.match(first.content, /分析构建要求/);
    rememberCompletedSession(store, session, () => {}); assert.equal(store.listMemories().length, 1);
    event('u2', 'user', '验证第二轮'); event('d1', 'delta', '结果第'); event('d2', 'delta', '二轮。'); event('c2', 'status', 'completed');
    const next = rememberCompletedSession(store, session, () => {});
    assert.equal(next?.id, first.id); assert.match(next!.content, /结果第二轮/); assert.doesNotMatch(next!.content, /分析构建要求/);
    store.saveMemory({ id: 'manual', title: '全局人工记忆', content: '手工录入', createdAt: new Date().toISOString() });
    assert.equal(sessionMemories(store.listMemories(), 'other').length, 1);
    assert.equal(sessionMemories(store.listMemories(), 'project').length, 2);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.listMemories().find(item => item.source === 'session')?.sourceEventId, 'c2');
    assert.equal(rememberCompletedSession(store, { ...session, status: 'failed' }, () => {}), undefined);
    event('u3', 'user', '分析密码字段示例'); event('m3', 'message', 'password="synthetic-credential"'); event('c3', 'status', 'completed');
    assert.match(rememberCompletedSession(store, session, () => {})!.content, /password="synthetic-credential"/);
    assert.equal(store.listMemories().find(item => item.source === 'session')?.sourceEventId, 'c3');
    event('u4', 'user', '当前配置凭据误粘贴'); event('m4', 'message', 'known-configured-secret'); event('c4', 'status', 'completed');
    assert.throws(() => rememberCompletedSession(store, session, text => { if (text.includes('known-configured-secret')) throw new Error('当前配置凭据'); }), /当前配置凭据/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('项目收放、输入框尺寸和更新地址持久化；旧完成已读请求不能清除新完成标记', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-v062-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    store.saveProject({ id: 'project', name: '项目', path: root, branch: 'main' });
    assert.equal(store.listProjects()[0].collapsed ?? true, true);
    store.setProjectCollapsed('project', false); store.renameProject('project', '改名');
    store.saveSession({ id: 'session', projectId: 'project', title: '完成会话', status: 'completed', workspacePath: root, branch: 'agent/test', model: '', createdAt: new Date().toISOString(), unreadCompletionId: 'new' });
    store.markSessionRead('session', 'old'); assert.equal(store.getSession('session')?.unreadCompletionId, 'new');
    store.saveLayout({ ...store.getLayout(), composerHeight: 240 });
    assert.throws(() => store.saveLayout({ ...store.getLayout(), composerHeight: 500 }), /尺寸/);
    store.saveUpdateUrl(updateFeed('https://updates.example.invalid/agent').url);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.listProjects()[0].collapsed, false);
    assert.equal(store.getSession('session')?.unreadCompletionId, 'new');
    assert.equal(store.getLayout().composerHeight, 240);
    assert.equal(store.getUpdateUrl(), 'https://updates.example.invalid/agent/');
    store.markSessionRead('session', 'new'); store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getSession('session')?.unreadCompletionId, undefined);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('更新地址识别 GitHub 仓库及 HTTPS 清单目录，拒绝凭据与危险协议', () => {
  assert.deepEqual(updateFeed(DEFAULT_UPDATE_URL + '.git'), { url: DEFAULT_UPDATE_URL, feed: { provider: 'github', owner: 'zhuangxiaolong', repo: 'jg_agent' } });
  assert.deepEqual(updateFeed('https://updates.example.invalid/agent'), { url: 'https://updates.example.invalid/agent/', feed: { provider: 'generic', url: 'https://updates.example.invalid/agent/' } });
  for (const value of ['http://updates.example.invalid', 'file:///C:/test', 'https://name:password@example.invalid', 'https://example.invalid/?token=secret', 'https://github.com/owner/repo/releases']) assert.throws(() => updateFeed(value));
});

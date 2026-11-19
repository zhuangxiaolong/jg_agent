import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStore } from '../packages/storage/src';
import type { AgentEvent, Session } from '../packages/domain/src';
import { rememberCompletedSession, sessionMemories } from '../apps/desktop/src/main/session-memory';
import { DEFAULT_UPDATE_URL, updateFeed } from '../packages/domain/src/updates';

test('自动记忆只摘录本轮用户明确长期规则，排除普通任务和模型回答', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-memory-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    store.saveProject({ id: 'project', name: '项目', branch: 'main', path: root });
    const session: Session = { id: 'session', projectId: 'project', title: '验证构建', status: 'completed', workspacePath: root, branch: 'agent/test', model: 'model', createdAt: new Date().toISOString() };
    store.saveSession(session);
    const event = (id: string, type: AgentEvent['type'], text: string) => store.appendEvent({ id, type, text, sessionId: session.id, createdAt: new Date().toISOString() });
    event('u1', 'user', '请记住：提交代码前必须先运行相关测试。'); event('m1', 'message', 'password="synthetic-credential"'); event('c1', 'status', 'completed');
    const first = rememberCompletedSession(store, session);
    assert.equal(first.length, 1); assert.match(first[0].content, /提交代码前必须先运行相关测试/);
    assert.equal(first[0].status, 'active'); assert.equal(first[0].evidence?.length, 1);
    rememberCompletedSession(store, session); assert.equal(store.listMemories().length, 1);
    assert.equal(store.listMemories()[0].evidence?.length, 1, '重复完成不能重复添加证据');
    event('u2', 'user', '分析本次构建输出'); event('m2', 'message', 'password="synthetic-credential"'); event('c2', 'status', 'completed');
    assert.deepEqual(rememberCompletedSession(store, session), []);
    assert.equal(store.listMemories().length, 1);
    assert.doesNotMatch(JSON.stringify(store.listMemories()), /synthetic-credential/);
    store.saveMemory({ id: 'manual', title: '全局人工记忆', content: '手工录入', category: 'preference', createdAt: new Date().toISOString() });
    assert.equal(sessionMemories(store.listMemories(), 'other').length, 1);
    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.listMemories().find(item => item.id !== 'manual')?.evidence?.[0].eventId, 'u1');
    assert.deepEqual(rememberCompletedSession(store, { ...session, status: 'failed' }), []);
    event('u3', 'user', '请记住：以后使用 known-configured-secret。'); event('c3', 'status', 'completed');
    assert.deepEqual(rememberCompletedSession(store, session, { knownSecrets: ['known-configured-secret'] }), []);
    store.saveMemorySettings({ autoCaptureEnabled: false, globalInjectionEnabled: true, projectInjectionEnabled: true, maxItems: 20, maxChars: 10000 });
    event('u4', 'user', '请记住：以后提交前必须复核变更。'); event('c4', 'status', 'completed');
    assert.deepEqual(rememberCompletedSession(store, session, { enabled: store.getMemorySettings()?.autoCaptureEnabled }), []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('普通独立会话与项目会话均不兜底生成长期记忆', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-no-project-memory-'));
  const filename = path.join(root, 'agent.db'); let store = await LocalStore.open(filename);
  try {
    store.saveProject({ id: 'project', name: '项目', branch: 'main', path: root });
    const standalone = { id: 'standalone', projectId: undefined, title: '通用问答', status: 'completed' as const, workspacePath: root, branch: '', model: 'model', createdAt: new Date().toISOString() } as unknown as Session;
    const projectSession: Session = { id: 'project-session', projectId: 'project', title: '项目分析', status: 'completed', workspacePath: root, branch: 'agent/project', model: 'model', createdAt: new Date().toISOString() };
    store.saveSession(standalone); store.saveSession(projectSession);
    const addCompletedTurn = (sessionId: string, prefix: string, task: string, result: string) => {
      const createdAt = new Date().toISOString();
      store.appendEvent({ id: `${prefix}-user`, sessionId, type: 'user', text: task, createdAt });
      store.appendEvent({ id: `${prefix}-result`, sessionId, type: 'message', text: result, createdAt });
      store.appendEvent({ id: `${prefix}-done`, sessionId, type: 'status', text: 'completed', createdAt });
    };
    addCompletedTurn(standalone.id, 'standalone', '一般问题', '一般回答');
    addCompletedTurn(projectSession.id, 'project', '项目问题', '项目回答');
    rememberCompletedSession(store, standalone);
    rememberCompletedSession(store, projectSession);

    const memories = store.listMemories();
    assert.deepEqual(memories, []);
    assert.deepEqual(sessionMemories(memories), []);
    assert.deepEqual(sessionMemories(memories, 'project'), []);

    store.close(); store = await LocalStore.open(filename);
    assert.equal(store.getSession(standalone.id)?.projectId, undefined);
    assert.deepEqual(store.listMemories(), []);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LocalStore } from '../packages/storage/src';
import { exportShare, parseShare, prepareShareImport, sharedSessionContext } from '../apps/desktop/src/main/sharing';
import { requirementsSource, shouldSyncRequirementsOnStartup, updateRequirements } from '../apps/desktop/src/main/requirements-sync';
import type { Session } from '../packages/domain/src';
import { CodexRuntime } from '../packages/agent-runtime/src';

test('真实SQLite分享往返保留消息和记忆，重新生成ID，不导出本机路径和模型配置，重复记忆跳过', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-sharing-'));
  const source = await LocalStore.open(path.join(root, 'source.db')), destination = await LocalStore.open(path.join(root, 'destination.db'));
  try {
    source.saveProject({ id: 'source-project', path: 'D:\\source-secret-path', name: '原项目', branch: 'main' });
    const session: Session = { id: randomUUID(), projectId: 'source-project', title: '采集异常修复经验', workspacePath: 'D:\\source-private-workspace', branch: 'agent/source', model: 'private-model', providerId: 'private-provider', runtimeThreadId: 'private-thread', createdAt: new Date().toISOString(), status: 'completed', system: 'MES5' };
    source.saveSession(session);
    source.appendEvent({ id: randomUUID(), sessionId: session.id, type: 'message', text: '修复方案\n```csharp\nreturn true;\n```\n测试2项通过，模型Key fixture-value', createdAt: new Date().toISOString() });
    source.saveMemory({ id: randomUUID(), title: '异常回滚', content: '复用现有事务边界', createdAt: new Date().toISOString(), source: 'session', sessionId: session.id, projectId: 'source-project' });
    const content = exportShare(source, { kind: 'session', sessionId: session.id }, text => text.replaceAll('fixture-value', '[已脱敏]'));
    for (const secret of ['source-private-workspace', 'private-model', 'private-provider', 'private-thread', 'fixture-value']) assert.ok(!content.includes(secret));
    const bundle = parseShare(content); assert.equal(bundle.memories.length, 1); assert.ok(bundle.session!.events[0].text.includes('```csharp'));
    destination.saveProject({ id: 'target-project', path: 'D:\\target', name: '接收项目', branch: 'main' });
    const target: Session = { ...session, id: randomUUID(), projectId: 'target-project', workspacePath: 'D:\\new-workspace', imported: true, runtimeThreadId: undefined };
    const prepared = prepareShareImport(destination, bundle, target); destination.importSharedData(prepared.session, prepared.events, prepared.memories);
    assert.notEqual(destination.events(target.id)[0].id, source.events(session.id)[0].id);
    assert.ok(sharedSessionContext(destination, target).includes('return true'));
    assert.equal(prepareShareImport(destination, bundle, target).memories.length, 0);
    assert.equal(destination.listMemories()[0].source, undefined, '分享记忆不绑定发送方项目ID');
    assert.throws(() => parseShare(JSON.stringify({ ...bundle, version: 999 })), /version/);
    assert.throws(() => prepareShareImport(destination, bundle), /请选择本机项目/);
  } finally { source.close(); destination.close(); }
});

test('在线规范按清单校验摘要、原子保存、保留禁用状态，拒绝本地冲突及损坏的更新', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-sync-')), store = await LocalStore.open(path.join(root, 'data.db'));
  const hash = (content: string) => createHash('sha256').update(content).digest('hex');
  let text = '# 开发规范\n复用现有事务。', version = '1';
  const manifest = () => ({ version, documents: [{ key: 'common', name: '团队规范.md', system: '通用', path: 'common.md', sha256: hash(text) }] });
  const transport: typeof fetch = async input => new Response(String(input).endsWith('manifest.json') ? JSON.stringify(manifest()) : text);
  try {
    store.saveRequirementsSync({ url: 'https://updates.example.invalid/standards/manifest.json', automatic: true });
    assert.equal(requirementsSource('https://github.com/zhuangxiaolong/jg_agent.git'), 'https://raw.githubusercontent.com/zhuangxiaolong/jg_agent/main/standards/manifest.json');
    assert.throws(() => requirementsSource('http://example.com'), /HTTPS/);
    const state = await updateRequirements(store, () => {}, () => {}, transport); assert.equal(state.version, '1');
    let document = store.listDocuments()[0]; const originalId = document.id;
    store.setDocumentEnabled(document.id, false); text = '# 开发规范\n构建并验证。'; version = '2';
    await updateRequirements(store, () => {}, () => {}, transport); document = store.listDocuments()[0];
    assert.equal(document.id, originalId); assert.equal(document.enabled, false); assert.equal(document.content, text); assert.equal(document.remote!.version, '2');
    const before = await readFile(path.join(root, 'data.db'));
    await assert.rejects(updateRequirements(store, () => {}, () => {}, async input => new Response(String(input).endsWith('manifest.json') ? JSON.stringify(manifest()) : '破损内容')), /校验失败/);
    assert.deepEqual(await readFile(path.join(root, 'data.db')), before);
    store.saveDocument({ ...document, content: '本地额外规范', digest: hash('本地额外规范') });
    await assert.rejects(updateRequirements(store, () => {}, () => {}, transport), /本地修改/);
    assert.equal(store.listDocuments()[0].content, '本地额外规范');
    const actual = JSON.parse(await readFile('standards/manifest.json', 'utf8'));
    assert.equal(hash(await readFile('standards/development.md', 'utf8')), actual.documents[0].sha256);
  } finally { store.close(); }
});

test('开发规范首次启动默认拉取，后续按自动更新设置后台检查', () => {
  assert.equal(shouldSyncRequirementsOnStartup({ url: 'https://example.invalid', automatic: false }), true);
  assert.equal(shouldSyncRequirementsOnStartup({ url: 'https://example.invalid', automatic: false, version: '1', lastChecked: '2026-11-07T00:00:00Z' }), false);
  assert.equal(shouldSyncRequirementsOnStartup({ url: 'https://example.invalid', automatic: true, version: '1' }), true);
});

test('浏览器工具绑定当前活动任务，截图作为原生图片结果返回，取消后不写回', async () => {
  let called = 0;
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'fixture', browser: async input => { called++; return { text: JSON.stringify(input), imageUrl: 'data:image/png;base64,dGVzdA==' }; } });
  const state = runtime as any, replies: any[] = []; state.child = {}; state.write = (message: any) => replies.push(message);
  state.sessions.add('session'); state.setActive('session', 'turn');
  await state.handleBrowserTool(1, { turnId: 'wrong', arguments: { action: 'snapshot' } }, 'session'); assert.equal(called, 0); assert.equal(replies.pop().result.success, false);
  await state.handleBrowserTool(2, { turnId: 'turn', arguments: { action: 'screenshot' } }, 'session');
  assert.equal(called, 1); assert.equal(replies.pop().result.contentItems[1].type, 'inputImage');
  state.child = undefined; await runtime.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JiraConnector } from '../packages/jira-connector/src';
import { JiraTestImages, sessionTestResult } from '../apps/desktop/src/main/jira-workflow';
import { LocalStore } from '../packages/storage/src';

test('真实HTTP Jira流转失败明确报告部分写入，重试复用已上传图片，评论和状态同一请求', async () => {
  const requests: { method: string; path: string; body: string }[] = []; let rejectTransition = true;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString(), pathname = new URL(request.url!, 'http://localhost').pathname;
    requests.push({ method: request.method!, path: pathname, body });
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET') return json({ transitions: [{ id: '101', name: '提交测试', to: { name: '待测试' } }] });
    if (pathname.endsWith('attachments')) { assert.equal(request.headers['x-atlassian-token'], 'no-check'); return json([{ id: '1', filename: 'test.png' }]); }
    if (pathname.endsWith('transitions') && rejectTransition) return json({ errors: { resolution: '请选择解决结果' } }, 400);
    response.writeHead(204); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-jira-flow-')), filename = path.join(root, 'test.png');
  await writeFile(filename, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=', 'base64'));
  const connector = new JiraConnector({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, account: 'fixture', password: 'synthetic-only' });
  const manager = new JiraTestImages(), images = await manager.add([filename]);
  const input = { key: 'TEST-1', transitionId: '101', comment: '测试：真实合成接口失败用例', imageIds: [images[0].id], assignee: { id: 'tester', displayName: '测试人员', field: 'name' as const } };
  try {
    await assert.rejects(manager.submit(connector, 'scope', input), /图片 test.png 已上传.*经办人已设为.*状态流转未确认成功.*resolution.*请选择解决结果/);
    assert.equal(requests.filter(item => item.path.endsWith('attachments')).length, 1);
    rejectTransition = false;
    assert.match(await manager.submit(connector, 'scope', input), /任务已流转至“待测试”/);
    assert.equal(requests.filter(item => item.path.endsWith('attachments')).length, 1, '同任务重试不重复上传已有图片');
    const payload = JSON.parse(requests.filter(item => item.method === 'POST' && item.path.endsWith('transitions')).at(-1)!.body);
    assert.equal(payload.transition.id, '101'); assert.match(payload.update.comment[0].add.body, /真实合成接口失败用例[\s\S]*\[\^test.png\]/);
    await assert.rejects(manager.submit(connector, 'scope', input), /图片已失效/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('自动带入测试记录限定最新一轮，会话未完成时不声称测试通过', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-test-records-')), store = await LocalStore.open(path.join(root, 'store.db'));
  const id = randomUUID(), now = new Date().toISOString();
  try {
    store.saveProject({ id: 'project', name: '测试项目', path: 'D:\\fixture', branch: 'main' });
    store.saveSession({ id, projectId: 'project', title: '测试任务', workspacePath: 'D:\\fixture-worktree', branch: 'agent/test', status: 'running', model: '', createdAt: now, jiraIssue: { id: '1', key: 'TEST-1', summary: '测试', description: '', status: '进行中', issueType: '任务', url: 'https://jira.example.invalid/browse/TEST-1', fetchedAt: now, attachments: [] } });
    for (const [type, text] of [['user', '旧任务'], ['message', '旧轮结果不应带入'], ['user', '本轮任务'], ['delta', '本轮结果'], ['tool', '执行命令完成：dotnet build\n退出码：0\nBuild succeeded.']] as const) store.appendEvent({ id: randomUUID(), sessionId: id, type, text, createdAt: now });
    const result = sessionTestResult(store, 'TEST-1');
    assert.ok(result.testResult.includes('本轮结果')); assert.ok(result.testResult.includes('Build succeeded')); assert.ok(!result.testResult.includes('旧轮结果')); assert.ok(result.testResult.includes('不能视为测试通过'));
  } finally { store.close(); }
});

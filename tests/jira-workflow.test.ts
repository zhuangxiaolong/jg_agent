import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Session } from '../packages/domain/src';
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

test('自动带入50字内摘要限定最新一轮，不复制工具日志或声称测试通过', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-test-records-')), store = await LocalStore.open(path.join(root, 'store.db'));
  const id = randomUUID(), now = new Date().toISOString();
  try {
    store.saveProject({ id: 'project', name: '测试项目', path: 'D:\\fixture', branch: 'main' });
    store.saveSession({ id, projectId: 'project', title: '测试任务', workspacePath: 'D:\\fixture-worktree', branch: 'agent/test', status: 'running', model: '', createdAt: now, jiraIssue: { id: '1', key: 'TEST-1', summary: '测试', description: '', status: '进行中', issueType: '任务', url: 'https://jira.example.invalid/browse/TEST-1', fetchedAt: now, attachments: [] } });
    for (const [type, text] of [['user', '旧任务'], ['message', '旧轮结果不应带入'], ['user', '本轮任务'], ['delta', '本轮结果'], ['tool', '执行命令完成：dotnet build\n退出码：0\nBuild succeeded.']] as const) store.appendEvent({ id: randomUUID(), sessionId: id, type, text, createdAt: now });
    const result = sessionTestResult(store, 'TEST-1');
    assert.equal(result.sessionId, id);
    assert.ok(result.testResult.includes('本轮结果')); assert.ok(!result.testResult.includes('Build succeeded')); assert.ok(!result.testResult.includes('旧轮结果')); assert.ok(result.testResult.includes('会话未完成，记录待核验'));
    assert.ok(Array.from(result.testResult).length <= 50);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('会话摘要保留最终验证结论和限制，所有自动内容不超过50个字符', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-jira-summary-')), store = await LocalStore.open(path.join(root, 'store.db'));
  const id = randomUUID(), now = new Date().toISOString();
  const session: Session = { id, title: '测试摘要', workspacePath: root, status: 'completed', model: '', createdAt: now, jiraIssue: { id: '1', key: 'TEST-1', summary: '测试', description: '', status: '进行中', issueType: '任务', url: 'https://jira.example.invalid/browse/TEST-1', fetchedAt: now, attachments: [] } };
  const cases: { name: string; status?: Session['status']; events: [AgentEvent['type'], string][]; expected: RegExp; excluded?: RegExp }[] = [
    { name: '长回复优先保留测试失败，不带Markdown和代码块', events: [['message', '# 已完成修改\n' + '实现细节。'.repeat(100) + '\n## 测试结果\n- **构建通过**；**测试失败：2项断言不符。**\n```text\n机密日志\n```']], expected: /测试失败：2项断言不符/, excluded: /实现细节|机密日志|[#*`]/ },
    { name: '长句不截掉后半句未执行的限制', events: [['message', '构建通过，' + '相关情况说明'.repeat(25) + '，测试未执行：环境缺少数据库。']], expected: /测试未执行/, excluded: /相关情况说明/ },
    { name: '构建通过不能掩盖测试受阻', events: [['message', '构建通过。\n测试受阻：缺少运行环境。']], expected: /测试受阻/ },
    { name: '限制句未重复测试关键词时仍保留未执行', events: [['message', '构建通过。\n未执行接口冒烟：缺少数据库。']], expected: /未执行接口冒烟/, excluded: /构建通过/ },
    { name: '超长命令末尾的未执行不会被截断', events: [['message', '测试命令 dotnet test D:/very/long/project/path/ProductionManagement/IMES.ProductionManagement.Domain.Tests.csproj 未执行：缺少数据库。']], expected: /未执行：缺少数据库/, excluded: /D:\// },
    { name: '明确标记未核验，模型自述不升级为已验证通过', events: [['message', '构建通过，测试通过。']], expected: /^会话摘要（待核验）：构建通过，测试通过。$/ },
    { name: '最终重测结论覆盖本轮早期失败', events: [['message', '测试失败：旧错误。'], ['tool', '命令执行完成：npm test\n退出码：0'], ['message', '测试通过：12项。']], expected: /测试通过：12项/, excluded: /旧错误|测试失败/ },
    { name: '流式回复无换行拼接且跳过应用追加核验消息', events: [['delta', '构建通过；测'], ['delta', '试未'], ['delta', '执行。'], ['status', 'completed'], ['message', '### 代码变更已核验\n工作区检测到2个文件变更。\n构建、测试：无法判定。']], expected: /测试未执行/, excluded: /工作区|文件变更|无法判定/ },
    { name: '最后的流式回复优先于之前完整消息', events: [['message', '准备执行测试。'], ['tool', '命令执行完成'], ['delta', '测试'], ['delta', '失败：1项。']], expected: /测试失败：1项/, excluded: /准备执行/ },
    { name: '没有实际回复时不把工具日志作为测试结论', events: [['tool', '命令执行完成：npm test\n退出码：0\n通过'.repeat(1000)]], expected: /暂无测试结论/, excluded: /退出码|命令执行|通过/ },
    { name: '会话失败保留状态提示', status: 'failed', events: [['message', '测试未执行。']], expected: /^会话失败，记录待核验：测试未执行/ },
    { name: '会话中断保留状态提示', status: 'interrupted', events: [['message', '验证未完成。']], expected: /^会话中断，记录待核验/ },
    { name: 'Unicode截断不拆开表情代理对', events: [['message', '已修复' + '😀'.repeat(100)]], expected: /…$/ },
    { name: '没有本轮回复时不复用上一轮结果', events: [], expected: /暂无测试结论/, excluded: /旧轮结果/ },
    { name: 'Markdown链接仅保留可读结论', events: [['message', '- [测试失败：接口超时](file:///D:/fixture/test-results/report.md)']], expected: /测试失败：接口超时/, excluded: /file:|fixture|\[|\]/ },
  ];
  try {
    for (const item of cases) await t.test(item.name, () => {
      store.saveSession({ ...session, status: item.status ?? 'completed' });
      store.appendEvent({ id: randomUUID(), sessionId: id, type: 'user', text: item.name, createdAt: now });
      for (const [type, text] of item.events) store.appendEvent({ id: randomUUID(), sessionId: id, type, text, createdAt: now });
      const { testResult, sessionId } = sessionTestResult(store, 'TEST-1');
      assert.equal(sessionId, id); assert.match(testResult, item.expected);
      if (item.excluded) assert.doesNotMatch(testResult, item.excluded);
      assert.ok(Array.from(testResult).length <= 50, testResult);
      assert.doesNotMatch(testResult, /[\r\n]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });
    const missing = sessionTestResult(store, 'TEST-2');
    assert.equal(missing.sessionId, undefined); assert.match(missing.testResult, /暂无关联会话/);
    assert.ok(Array.from(missing.testResult).length <= 50);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

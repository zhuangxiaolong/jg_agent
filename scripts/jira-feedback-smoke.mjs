import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(tmpdir(), 'jinggong-jira-feedback-'));
const evidenceDirectory = path.resolve(process.env.JINGGONG_TEST_EVIDENCE_DIR || 'test-results');
const executablePath = process.env.JINGGONG_TEST_EXE ? await realpath(path.resolve(process.env.JINGGONG_TEST_EXE)) : undefined;
await mkdir(evidenceDirectory, { recursive: true });
const checks = [], state = { status: '进行中', writes: [] };
const screenshot = name => path.join(evidenceDirectory, `jira-feedback-${name}.png`);
const reportPath = path.join(evidenceDirectory, 'jira-feedback-smoke.json');
const issue = () => ({ id: '1', key: 'TEST-1', fields: { summary: '简短测试反馈验收', description: '本地合成任务，不关联模型会话', status: { name: state.status }, issuetype: { name: '任务' }, attachment: [] } });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' }); response.end(JSON.stringify(value)); };
  if (request.method === 'GET' && url.pathname.endsWith('/myself')) return json({ displayName: '验收用户', timeZone: 'Asia/Shanghai' });
  if (request.method === 'GET' && url.pathname.endsWith('/field')) return json([{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date' } }]);
  if (request.method === 'GET' && url.pathname.endsWith('/project')) return json([{ id: '1', key: 'TEST', name: '反馈验收项目' }]);
  if (request.method === 'GET' && url.pathname.endsWith('/user/assignable/search')) return json([]);
  if (request.method === 'GET' && url.pathname.endsWith('/search')) return json({ startAt: 0, maxResults: 50, total: 1, issues: [issue()] });
  if (request.method === 'GET' && url.pathname.endsWith('/issue/TEST-1')) return json(issue());
  if (request.method === 'GET' && url.pathname.endsWith('/transitions')) return json({ transitions: [{ id: '101', name: '提交测试', to: { name: '待测试' } }] });
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  if (request.method !== 'GET') state.writes.push({ method: request.method, path: url.pathname, body });
  if (request.method === 'POST' && url.pathname.endsWith('/issue/TEST-1/transitions')) {
    state.status = '待测试'; response.writeHead(204); return response.end();
  }
  return json({ errorMessages: ['不存在的合成资源'] }, 404);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let app, page, runtime;
const report = async (passed, extra = {}) => writeFile(reportPath, JSON.stringify({
  passed, date: new Date().toISOString(), checks, testData: root,
  executable: executablePath || '开发 Electron', runtime,
  evidence: '真实 Electron、UI、IPC、HTTP；Jira 为临时本地合成服务，未启动模型会话，未操作用户 Jira。',
  ...extra,
}, null, 2));
try {
  const env = { ...process.env, JINGGONG_TEST_DATA: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }), env, cwd: process.cwd() });
  runtime = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, appPath: app.getAppPath(), execPath: process.execPath, version: app.getVersion() }));
  if (executablePath) {
    const normalizePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert.equal(normalizePath(await realpath(runtime.execPath)), normalizePath(executablePath), '必须由指定的打包程序运行验收');
    assert.equal(runtime.isPackaged, true, '指定打包程序应处于 packaged 模式');
    checks.push('实际进程路径与指定测试程序一致，app.isPackaged 为 true，并记录 app.getAppPath 与版本');
  }
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await expect(page.getByRole('button', { name: /^(?:打开)?全局设置$/ })).toBeEnabled({ timeout: 30000 });
  await page.evaluate(url => window.jinggong.saveJira({ baseUrl: url, account: 'fixture', password: 'synthetic-only', projectKey: 'TEST', dateFieldId: '11116' }), `http://127.0.0.1:${server.address().port}/jira`);
  await page.reload();
  await page.getByRole('button', { name: '查看 Jira 任务 TEST-1', exact: true }).click();
  await page.locator('.jira-workflow > summary').click();
  const feedback = page.getByLabel('Jira 测试结果与补充说明', { exact: true });
  const counter = page.locator('.workflow-comment small');
  const submit = page.getByRole('button', { name: '确认流转并提交反馈', exact: true });
  await expect(feedback).toHaveValue(/暂无关联会话测试结果/);
  const defaultFeedback = await feedback.inputValue(), defaultCharacters = Array.from(defaultFeedback).length;
  assert.ok(defaultCharacters > 0 && defaultCharacters <= 50, '默认无关联会话反馈应在 50 字以内');
  await expect(counter).toHaveText(`${defaultCharacters} 字 · 建议不超过 50 字`);
  await expect(feedback).toHaveAttribute('rows', '3');
  await expect(feedback).toHaveAttribute('maxlength', '28000');
  assert.equal((await page.evaluate(() => window.jinggong.bootstrap())).sessions.length, 0, '验收无需创建或启动模型会话');
  await page.locator('.workflow-comment').scrollIntoViewIfNeeded();
  await page.locator('.workflow-comment').screenshot({ path: screenshot('default') });
  checks.push('无关联会话的默认反馈不超过 50 字，显示建议与当前字数，输入框为 3 行且保留原有手工输入上限');

  await feedback.fill('测试🙂通过');
  await expect(counter).toHaveText('5 字 · 建议不超过 50 字');
  await feedback.fill('测'.repeat(50));
  await expect(counter).toHaveText('50 字 · 建议不超过 50 字');
  await feedback.press('End'); await feedback.pressSequentially('补');
  await expect(counter).toHaveText('51 字 · 建议不超过 50 字，请精简');
  await feedback.fill('测试🙂通过');
  await expect(counter).toHaveText('5 字 · 建议不超过 50 字');
  checks.push('实时字数按 Unicode 字符计算，表情计为 1 字，50 字边界及超过建议后的精简提示正确，缩短后提示恢复');

  const manualFeedback = '测试补充🙂'.repeat(12) + '\n本地合成验收完成，生产环境未执行验收。';
  const manualCharacters = Array.from(manualFeedback).length;
  assert.ok(manualCharacters > 50 && manualFeedback.length < 28000);
  await feedback.fill(manualFeedback);
  await expect(feedback).toHaveValue(manualFeedback);
  await expect(counter).toHaveText(`${manualCharacters} 字 · 建议不超过 50 字，请精简`);
  await page.getByLabel('Jira 目标状态', { exact: true }).selectOption('101');
  await expect(submit).toBeEnabled();
  await page.locator('.workflow-comment').scrollIntoViewIfNeeded();
  await page.locator('.workflow-comment').screenshot({ path: screenshot('manual') });
  checks.push('手工补充超过 50 字时仅提示精简，不截断输入且仍可提交');

  page.once('dialog', dialog => dialog.accept()); await submit.click();
  await expect(page.locator('.jira-workflow')).toContainText('任务已流转至');
  assert.equal(state.writes.length, 1, '只提交一次本地合成 Jira 状态与评论请求');
  assert.equal(state.writes[0].method, 'POST');
  assert.equal(state.writes[0].path, '/jira/rest/api/2/issue/TEST-1/transitions');
  const submitted = JSON.parse(state.writes[0].body);
  assert.equal(submitted.transition.id, '101');
  assert.equal(submitted.update.comment[0].add.body, manualFeedback, 'HTTP 评论应完整保留人工输入的表情和换行');
  assert.equal((await page.evaluate(() => window.jinggong.bootstrap())).sessions.length, 0);
  await page.screenshot({ path: screenshot('submitted'), fullPage: true });
  checks.push('真实 HTTP 流转仅执行一次，超过建议长度的人工评论连同表情和换行原样提交，任务状态刷新成功');
  await report(true, { defaultCharacters, manualCharacters, submittedComment: submitted.update.comment[0].add.body });
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: screenshot('failure'), fullPage: true }).catch(() => {});
  await report(false, { error: error instanceof Error ? error.stack : String(error) }); throw error;
} finally {
  try { if (app) await app.close(); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

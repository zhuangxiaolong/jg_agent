import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(tmpdir(), 'jinggong-assignee-search-'));
const evidenceDirectory = path.resolve(process.env.JINGGONG_TEST_EVIDENCE_DIR || root);
await mkdir(evidenceDirectory, { recursive: true });
const users = [...Array.from({ length: 500 }, (_, index) => ({ name: `dev${String(index).padStart(3, '0')}`, displayName: `开发人员${index}`, active: true })), { name: 'qa_jia', displayName: '张三', active: true }, { name: 'qa_yi', displayName: '张三', active: true }];
const state = { queries: [], delayedFinished: false, assignee: undefined, transitions: 0 }, checks = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' }); response.end(JSON.stringify(value)); };
  if (url.pathname.endsWith('/myself')) return json({ displayName: '验收用户', timeZone: 'Asia/Shanghai' });
  if (url.pathname.endsWith('/field')) return json([{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date' } }]);
  if (url.pathname.endsWith('/project')) return json([{ id: '1', key: 'TEST', name: '测试项目' }]);
  const issue = { id: '1', key: 'TEST-1', fields: { summary: '经办人搜索验收', description: '合成测试任务', status: { name: '进行中' }, issuetype: { name: '任务' }, attachment: [] } };
  if (url.pathname.endsWith('/search') && !url.pathname.endsWith('/assignable/search')) return json({ startAt: 0, maxResults: 50, total: 1, issues: [issue] });
  if (url.pathname.endsWith('/issue/TEST-1')) return json(issue);
  if (url.pathname.endsWith('/user/assignable/search')) {
    const query = url.searchParams.get('query') || ''; state.queries.push(query);
    if (query === 'slow') return setTimeout(() => { state.delayedFinished = true; json([{ name: 'old-result', displayName: '过期搜索结果', active: true }]); }, 1200);
    if (query === 'error') return json({ errorMessages: ['合成搜索失败'] }, 503);
    return json(users.filter(user => `${user.name} ${user.displayName}`.toLowerCase().includes(query.toLowerCase())).slice(0, 50));
  }
  if (request.method === 'GET' && url.pathname.endsWith('/transitions')) return json({ transitions: [{ id: '101', name: '提交测试', to: { name: '待测试' } }] });
  const chunks = []; for await (const chunk of request) chunks.push(chunk); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (url.pathname.endsWith('/assignee')) { state.assignee = body; response.writeHead(204); return response.end(); }
  if (url.pathname.endsWith('/transitions')) { state.transitions++; response.writeHead(204); return response.end(); }
  return json({}, 404);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let app;
try {
  const env = { ...process.env, JINGGONG_TEST_DATA: path.join(root, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], env }); const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await expect(page.getByRole('button', { name: /^(?:打开)?全局设置$/ })).toBeEnabled({ timeout: 30000 });
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(url => window.jinggong.saveJira({ baseUrl: url, account: 'fixture', password: 'synthetic-only', projectKey: 'TEST', dateFieldId: '11116' }), `http://127.0.0.1:${server.address().port}/jira`);
  await page.reload(); await page.getByRole('button', { name: '查看 Jira 任务 TEST-1', exact: true }).click();
  await page.locator('.jira-workflow > summary').click();
  await page.getByLabel('Jira 目标状态').selectOption('101');
  const picker = page.getByRole('combobox', { name: '搜索经办人', exact: true }), flow = page.getByRole('button', { name: '流转并提交反馈', exact: true });
  await picker.fill('张三');
  await expect(page.getByRole('option', { name: '张三 qa_yi', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: '张三 qa_jia', exact: true })).toBeVisible();
  await page.getByRole('option', { name: '张三 qa_yi', exact: true }).click();
  await expect(page.locator('.assignee-selection')).toHaveText('已选择：张三 · qa_yi');
  await page.getByRole('button', { name: '刷新流转选项', exact: true }).click();
  await expect(page.locator('.assignee-selection')).toHaveText('已选择：张三 · qa_yi');
  checks.push('502人合成Jira：中文姓名自动远程搜索，重名人员展示账号并可直接点击选择，刷新状态保留选中人员');

  await page.getByLabel('Jira 目标状态').selectOption('101');
  await page.getByRole('button', { name: '清除经办人选择', exact: true }).click();
  await expect(page.locator('.assignee-selection')).toHaveText('不选择则保持当前经办人');
  await picker.fill('does-not-exist'); await expect(page.getByText('未找到可分配的经办人，请更换姓名或账号。', { exact: true })).toBeVisible();
  await expect(flow).toBeDisabled();
  await picker.fill('error'); await expect(page.locator('.assignee-search-message[role=alert]')).toContainText('暂时不可用');
  await picker.fill('slow'); await expect.poll(() => state.queries.includes('slow')).toBe(true);
  await picker.fill('dev499'); await expect(page.getByRole('option', { name: '开发人员499 dev499', exact: true })).toBeVisible();
  await expect.poll(() => state.delayedFinished).toBe(true);
  await expect(page.getByRole('option', { name: '过期搜索结果 old-result', exact: true })).toHaveCount(0);
  await expect(page.getByRole('option', { name: '开发人员499 dev499', exact: true })).toBeVisible();
  checks.push('无结果和搜索失败明确显示；未选中时不能误提交；慢查询先发后返不会覆盖新搜索结果');

  await picker.press('ArrowDown'); await picker.press('Enter');
  await expect(page.locator('.assignee-selection')).toHaveText('已选择：开发人员499 · dev499');
  await expect(flow).toBeEnabled();
  await page.getByLabel('Jira 测试结果与补充说明').fill('经办人搜索与选择合成验证通过。');
  await picker.fill('张三'); await expect(page.getByRole('option', { name: '张三 qa_yi', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(evidenceDirectory, 'jira-assignee-search.png'), fullPage: true });
  await page.getByRole('option', { name: '张三 qa_yi', exact: true }).click();
  await flow.click();
  await expect(page.locator('.jira-workflow')).toContainText('任务已流转至');
  assert.deepEqual(state.assignee, { name: 'qa_yi' }); assert.equal(state.transitions, 1);
  assert.deepEqual(dialogs, []);
  assert.ok(state.queries.includes('dev499') && state.queries.includes('张三'));
  checks.push('账号搜索、上下键与回车选择通过；真实HTTP流转请求准确提交重名人员所选账号，仅执行一次');
  await writeFile(path.join(evidenceDirectory, 'jira-assignee-smoke.json'), JSON.stringify({ passed: true, checks, testData: root, evidence: '真实Electron/UI/IPC/HTTP，Jira任务和502名经办人为本地合成数据，未操作用户Jira' }, null, 2));
} catch (error) {
  await writeFile(path.join(evidenceDirectory, 'jira-assignee-smoke.json'), JSON.stringify({ passed: false, checks, testData: root, error: String(error) }, null, 2)); throw error;
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

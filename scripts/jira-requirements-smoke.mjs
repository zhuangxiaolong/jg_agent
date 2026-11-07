import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';

// 真实 Electron/IPC/DPAPI/SQLite/Git + 明确合成的本地 HTTP 服务；真实用户 Jira 不在本脚本范围。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-jira-requirements-'));
const data = path.join(root, 'data');
const repo = path.join(root, '本地合成项目');
await mkdir(repo);
await mkdir('test-results', { recursive: true });
const reportPath = 'test-results/jira-requirements-smoke.json';
const screenshotPath = 'test-results/jira-requirements-v03.png';
const jiraPassword = 'synthetic-jira-smoke-password';
const modelSentinel = 'synthetic-model-"-\\-key';
const checks = [];
const state = { unauthorized: false, modelSecretInDescription: false, detailReads: 0, requests: [], lastDetailSummary: '' };
let baseUrl = '';
let app;
const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();
git(['init', '-b', 'main']); git(['config', 'user.name', '合成验收']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.autocrlf', 'false']);
await writeFile(path.join(repo, 'README.md'), '# 本地合成验收项目\n');
git(['add', '--', 'README.md']); git(['commit', '-m', '建立合成验收基线']);
const sourceHead = git(['rev-parse', 'HEAD']);

function issue(number, detail = false, project = 'CD') {
  const summary = detail ? `主进程重新读取的任务快照 ${state.detailReads}` : `合成 Jira 任务 ${number}`;
  if (detail) state.lastDetailSummary = summary;
  return { id: String(10000 + number), key: `${project}-${number}`, fields: {
    summary, description: state.modelSecretInDescription ? modelSentinel : `合成需求 ${number}：核对生产数量，验收时确认数据一致。外部资料仅供分析。`,
    status: { name: '待开发' }, issuetype: { name: '任务' }, priority: { name: '中' }, assignee: { displayName: '合成测试用户' }, updated: '2026-11-04T10:00:00.000+0800',
    attachment: [{ id: '11', filename: '合成需求说明.md', mimeType: 'text/markdown', size: 123, content: `${baseUrl}/secure/attachment/11/spec.md` }], customfield_11116: '2026-11-04',
  } };
}
function json(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json;charset=UTF-8' }); response.end(JSON.stringify(value)); }
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  state.requests.push({ path: url.pathname, method: request.method, startAt: url.searchParams.get('startAt'), jql: url.searchParams.get('jql'), authenticated: request.headers.authorization === `Basic ${Buffer.from(`fixture-user:${jiraPassword}`).toString('base64')}` });
  if (request.headers.authorization !== `Basic ${Buffer.from(`fixture-user:${jiraPassword}`).toString('base64')}` || state.unauthorized) return json(response, { errorMessages: ['synthetic authentication failure'] }, 401);
  if (url.pathname === '/jira/rest/api/2/myself') return json(response, { displayName: '合成测试用户', name: 'fixture-user', timeZone: 'Asia/Shanghai' });
  if (url.pathname === '/jira/rest/api/2/field') return json(response, [{ id: 'customfield_11116', name: '日报日期', schema: { type: 'date', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:datepicker' } }]);
  if (url.pathname === '/jira/rest/api/2/project') return json(response, [{ id: '100', key: 'NEWDEVGROUP', name: '合成同名项目' }, { id: '200', key: 'CD', name: '合成同名项目' }]);
  if (url.pathname === '/jira/rest/api/2/search') {
    const startAt = Number(url.searchParams.get('startAt') ?? 0);
    const jql = url.searchParams.get('jql') ?? '';
    const empty = jql.includes('project = "NEWDEVGROUP"') || jql.includes('cf[') && !jql.includes('cf[11116] = "2026-11-04"');
    return json(response, { startAt, maxResults: 1, total: empty ? 0 : 2, issues: empty || startAt >= 2 ? [] : [issue(startAt === 0 ? 435 : 434)] });
  }
  const key = /^\/jira\/rest\/api\/2\/issue\/(CD|NEWDEVGROUP)-(435|434|1)$/.exec(url.pathname);
  if (key) { state.detailReads++; return json(response, issue(Number(key[2]), true, key[1])); }
  return json(response, { errorMessages: ['synthetic resource missing'] }, 404);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
baseUrl = `http://127.0.0.1:${server.address().port}/jira`;

async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.JINGGONG_TEST_NO_NODE) env.PATH = `${process.env.SystemRoot}\\System32;C:\\Program Files\\Git\\cmd`;
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env });
  const page = await app.firstWindow();
  await page.getByText('精工智能开发平台引擎已就绪', { exact: true }).waitFor({ timeout: 30000 });
  return page;
}
async function assertBrand(page) { assert.ok(!/\bCodex\b/i.test(await page.locator('body').innerText()), '界面固定文案不应出现底层产品名'); }
async function documents(page) { return (await page.evaluate(() => window.jinggong.getSettings())).documents; }
async function waitDocument(page, name) {
  await expect.poll(async () => (await documents(page)).some(document => document.name === name), { timeout: 10000 }).toBe(true);
  return (await documents(page)).find(document => document.name === name);
}
async function databaseSession(id) {
  const SQL = await initSqlJs();
  const database = new SQL.Database(await readFile(path.join(data, 'database/jinggong-agent.db')));
  try { const statement = database.prepare('SELECT value FROM sessions WHERE id = ?'); statement.bind([id]); assert.ok(statement.step()); const value = JSON.parse(statement.get()[0]); statement.free(); return value; }
  finally { database.close(); }
}
async function persistReport(passed, extra = {}) {
  await writeFile(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), passed, evidenceKind: '真实桌面核心链路 + 明确合成本地 HTTP fixture', checks, testData: root, executable: process.env.JINGGONG_TEST_EXE ?? '开发 Electron', nodeOnApplicationPath: !process.env.JINGGONG_TEST_NO_NODE, actualUserJira: '不在本脚本范围：仅访问隔离的合成本地 HTTP 服务，真实用户 Jira 由独立联调记录验证', modelInference: '未执行，未点击发送或使用测试密钥请求模型', screenshot: screenshotPath, ...extra }, null, 2));
}

try {
  let page = await launch();
  await assertBrand(page);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByRole('button', { name: '打开模型设置', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Jira 连接', exact: true }).click();
  await page.locator('#jira-url').fill(`${baseUrl}/projects/NEWDEVGROUP?selectedItem=tasks#top`);
  await page.locator('#jira-account').fill('fixture-user');
  await page.locator('#jira-password').fill(jiraPassword);
  await page.locator('#jira-project-key').fill('NEWDEVGROUP');
  await page.locator('#jira-date-field').fill('11116');
  await dialog.getByRole('button', { name: '保存 Jira 配置', exact: true }).click();
  await expect.poll(() => page.locator('#jira-password').inputValue()).toBe('');
  const settings = await page.evaluate(() => window.jinggong.getSettings());
  assert.equal(settings.jira.baseUrl, baseUrl); assert.equal(settings.jira.hasPassword, true); assert.equal(settings.jira.password, undefined);
  const encryptedBefore = await readFile(path.join(data, 'config/secrets/jira.dpapi'));
  assert.ok(!encryptedBefore.includes(Buffer.from(jiraPassword)));
  assert.equal(await app.evaluate(({ safeStorage }, input) => { const value = JSON.parse(safeStorage.decryptString(Buffer.from(input.bytes))); return value.secret === input.password && value.scope === input.scope; }, { bytes: [...encryptedBefore], password: jiraPassword, scope: `${baseUrl}\nfixture-user` }), true);
  await assert.rejects(page.evaluate(baseUrl => window.jinggong.saveJira({ baseUrl: `${baseUrl}/projects/SYNTHETIC_JIRA_SECRET`, account: 'fixture-user', password: 'SYNTHETIC_JIRA_SECRET' }), baseUrl), /密码|凭据/);
  assert.deepEqual(await readFile(path.join(data, 'config/secrets/jira.dpapi')), encryptedBefore);
  assert.equal((await page.evaluate(() => window.jinggong.getSettings())).jira.projectKey, 'NEWDEVGROUP');
  await assert.rejects(page.evaluate(baseUrl => window.jinggong.saveJira({ baseUrl: baseUrl.replace('/jira', '/different-context'), account: 'fixture-user' }), baseUrl), /重新输入/);
  checks.push('Jira HTTP项目页经真实UI归一为context Base URL；DPAPI可真实解密且scope绑定，Renderer不回显密码；派生项目key不能保存新密码，更换地址不能沿用密钥');
  await dialog.getByRole('button', { name: '测试已保存连接', exact: true }).click();
  await dialog.getByText(/连接成功：合成测试用户/).waitFor();
  await assertBrand(page);
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();

  const profile = await page.evaluate(key => window.jinggong.saveModelProvider({ name: '合成转义凭据验收', baseUrl: 'https://model.example.invalid/v1', models: ['fixture-model'], apiKey: key }), modelSentinel);
  state.modelSecretInDescription = true;
  await assert.rejects(page.evaluate(() => window.jinggong.getJiraIssue('NEWDEVGROUP-1')), /凭据|Token|密码/);
  state.modelSecretInDescription = false;
  checks.push('带引号与反斜杠的已存模型key若出现在Jira原始描述，真实主进程IPC在交给Renderer/SQLite之前拒绝；未请求模型');

  await page.getByRole('button', { name: 'Jira 任务', exact: true }).click();
  await page.locator('details.jira-query-controls > summary').click();
  await expect(page.getByLabel('Jira 项目范围', { exact: true })).toHaveValue('*');
  await expect(page.getByLabel('Jira 查询范围', { exact: true })).toHaveValue('daily');
  await expect(page.getByLabel('仅我的 Jira 任务', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Jira 项目范围', { exact: true }).locator('option[value="CD"]')).toHaveCount(1);
  await expect(page.getByLabel('Jira 项目范围', { exact: true }).locator('option[value="NEWDEVGROUP"]')).toHaveCount(1);
  await expect(page.getByLabel('Jira 项目范围', { exact: true }).locator('option')).toHaveCount(3);
  const jiraToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await expect(page.getByLabel('Jira 任务日期', { exact: true })).toHaveValue(jiraToday);
  await page.getByLabel('Jira 任务日期', { exact: true }).fill('2026-11-04');
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor();
  const defaultQuery = state.requests.filter(request => request.jql).at(-1).jql;
  assert.ok(!defaultQuery.includes('project ='));
  assert.ok(defaultQuery.includes('cf[11116] = "2026-11-04"') && defaultQuery.includes('assignee = currentUser()'));
  await expect(page.getByLabel('Jira 查询条件快照', { exact: true })).toContainText('全部可访问项目');
  await expect(page.getByLabel('Jira 查询条件快照', { exact: true })).toContainText('2026-11-04');
  await expect(page.getByLabel('Jira 查询条件快照', { exact: true })).toContainText('仅本人');
  assert.ok((await page.locator('.jira-issue-row').textContent()).includes('项目 CD'));
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).click();
  await page.getByLabel('Jira 任务详情 CD-435', { exact: true }).waitFor();

  await page.getByLabel('Jira 项目范围', { exact: true }).selectOption('NEWDEVGROUP');
  await page.locator('.jira-stale-notice').waitFor();
  await expect(page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Jira 查询条件快照', { exact: true })).toContainText('全部可访问项目');
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByText('该日期没有匹配任务', { exact: true }).waitFor();
  assert.equal(await page.locator('.jira-issue-row').count(), 0);
  assert.ok((await page.locator('.jira-results .jira-empty').textContent()).includes('检查项目范围、日期和负责人条件'));
  assert.ok(!/日报日期未填写|任务未填写日报/.test(await page.locator('body').innerText()));

  await page.getByLabel('Jira 项目范围', { exact: true }).selectOption('CD');
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor();
  assert.equal(await page.locator('.jira-issue-row').count(), 1);
  assert.ok(state.requests.filter(request => request.jql).at(-1).jql.includes('project = "CD"'));
  await page.getByRole('button', { name: 'Jira 任务下一页', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-434', exact: true }).waitFor();
  await expect(page.getByRole('button', { name: 'Jira 任务下一页', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Jira 任务上一页', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor();
  await page.getByLabel('仅我的 Jira 任务', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true })).toBeDisabled();
  await page.getByLabel('仅我的 Jira 任务', { exact: true }).check();
  await expect(page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor();
  await page.getByLabel('Jira 查询范围', { exact: true }).selectOption('recent');
  await expect(page.getByLabel('Jira 任务日期', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).waitFor();
  assert.ok(!state.requests.filter(request => request.jql).at(-1).jql.includes('cf['));
  await page.getByLabel('Jira 查询范围', { exact: true }).selectOption('daily');
  await page.getByLabel('Jira 任务日期', { exact: true }).fill('2026-11-05');
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByText('该日期没有匹配任务', { exact: true }).waitFor();
  assert.equal(await page.locator('.jira-issue-row').count(), 0);
  state.unauthorized = true;
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Jira 认证失败' }).waitFor();
  assert.equal(await page.locator('.jira-issue-row').count(), 0);
  state.unauthorized = false;
  await page.getByLabel('Jira 任务日期', { exact: true }).fill('2026-11-04');
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).click();
  await page.locator('#jira-panel .jira-issue-details').waitFor();
  let displayedDetail = await page.locator('#jira-panel .jira-issue-details h2').textContent();
  await page.getByText('合成需求说明.md', { exact: true }).waitFor();
  assert.ok(state.requests.some(request => request.startAt === '1' && request.jql?.includes('project = "CD"')));
  checks.push('合成项目列表经真实GET/IPC返回，同名项目按Key区分且无重复；默认全部项目/日报/本人可见CD-435与434分页，NEWDEVGROUP日报为0；项目/负责人/日期/范围改变后旧列表禁用，空结果中性提示，401明确失败');

  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, repo);
  await page.getByRole('button', { name: '添加本地项目', exact: true }).click();
  await expect(page.getByLabel('Jira 关联本地项目', { exact: true })).not.toHaveValue('');
  await expect(page.getByRole('button', { name: '从此任务创建会话', exact: true })).toBeEnabled();
  await page.getByLabel('Jira 项目范围', { exact: true }).selectOption('*');
  await expect(page.getByRole('button', { name: '从此任务创建会话', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Jira 查询条件快照', { exact: true })).toContainText('CD');
  await page.getByLabel('Jira 项目范围', { exact: true }).selectOption('CD');
  await expect(page.getByRole('button', { name: '从此任务创建会话', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).click();
  await page.getByLabel('Jira 任务详情 CD-435', { exact: true }).waitFor();
  displayedDetail = await page.locator('#jira-panel .jira-issue-details h2').textContent();
  await expect(page.getByRole('button', { name: '从此任务创建会话', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '从此任务创建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入任务', exact: true }).waitFor();
  const bootstrap = await page.evaluate(() => window.jinggong.bootstrap());
  assert.equal(bootstrap.sessions.length, 1);
  const session = bootstrap.sessions[0];
  assert.equal(session.jiraIssue.key, 'CD-435');
  assert.notEqual(session.jiraIssue.summary, displayedDetail);
  assert.equal(session.jiraIssue.summary, state.lastDetailSummary);
  assert.equal(session.jiraIssue.url, `${baseUrl}/browse/CD-435`);
  assert.notEqual(session.workspacePath, repo);
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: session.workspacePath, encoding: 'utf8', windowsHide: true }).trim(), session.branch);
  assert.match(session.branch, /^agent\//);
  const prompt = await page.getByRole('textbox', { name: '输入任务', exact: true }).inputValue();
  assert.ok(prompt.includes(session.jiraIssue.key) && prompt.includes(session.jiraIssue.summary));
  assert.equal(session.status, 'idle');
  assert.equal((await page.evaluate(id => window.jinggong.getEvents(id), session.id)).filter(event => ['user', 'delta', 'message'].includes(event.type)).length, 0);
  assert.equal((await databaseSession(session.id)).jiraIssue.summary, session.jiraIssue.summary);
  assert.equal(git(['rev-parse', 'HEAD']), sourceHead); assert.equal(git(['status', '--porcelain']), '');
  checks.push('只替换原生目录选择输入：配置默认NEWDEVGROUP但查询CD时详情/创建绑定CD范围；条件改变后创建禁用且改回仍须刷新；创建再次GET CD-435新快照到SQLite，真实agent Worktree隔离源main，携带prompt但idle未发送');

  await page.getByRole('button', { name: '开发要求与规范', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('文档适用系统', { exact: true }).selectOption('通用');
  const upload = path.join(root, '上传开发要求.md');
  await writeFile(upload, '必须遵循已有代码风格，未执行的测试不能宣称通过。\n');
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, upload);
  await dialog.getByRole('button', { name: '上传资料', exact: true }).click();
  const imported = await waitDocument(page, '上传开发要求.md');
  assert.equal(imported.kind, 'requirement'); assert.equal(imported.system, '通用');

  async function createRequirement(title, content) {
    await dialog.getByRole('button', { name: '新增要求', exact: true }).click();
    await dialog.getByRole('textbox', { name: '开发要求标题', exact: true }).fill(title);
    await dialog.getByRole('textbox', { name: '开发要求正文', exact: true }).fill(content);
    await dialog.getByRole('button', { name: '保存开发要求', exact: true }).click();
    return waitDocument(page, /\.(?:md|txt|json)$/i.test(title) ? title : `${title}.md`);
  }
  const manual = await createRequirement('直接输入要求', '第一次输入：保留人工变更。');
  await dialog.getByRole('button', { name: '查看文档 直接输入要求.md', exact: true }).click();
  await dialog.getByRole('button', { name: '编辑此要求', exact: true }).click();
  await dialog.getByRole('textbox', { name: '开发要求正文', exact: true }).fill('第二次编辑：必须保留人工变更，并检查已有调用链。');
  await dialog.getByRole('button', { name: '保存开发要求', exact: true }).click();
  await expect.poll(async () => (await documents(page)).find(item => item.id === manual.id)?.content).toContain('第二次编辑');
  const edited = (await documents(page)).find(item => item.id === manual.id);
  assert.notEqual(edited.digest, manual.digest);
  const policy = await createRequirement('机器规则.json', JSON.stringify({ rules: [{ type: 'forbid-text', glob: 'README.md', text: '禁止提交标记' }] }, null, 2));
  await assert.rejects(page.evaluate(() => window.jinggong.saveRequirement({ title: '无效.json', content: '{"rules":', system: '通用' })), /JSON/);
  assert.ok(!(await documents(page)).some(item => item.name === '无效.json'));
  await writeFile(path.join(session.workspacePath, 'README.md'), '# 本地合成验收项目\n禁止提交标记\n');
  const checksBeforeDisable = await page.evaluate(id => window.jinggong.checkRequirements(id), session.id);
  assert.equal(checksBeforeDisable.find(item => item.documentId === policy.id).status, 'fail');
  await dialog.getByRole('switch', { name: '停用 机器规则.json', exact: true }).click();
  await expect.poll(async () => (await documents(page)).find(item => item.id === policy.id)?.enabled).toBe(false);
  assert.ok(!(await page.evaluate(id => window.jinggong.checkRequirements(id), session.id)).some(item => item.documentId === policy.id));
  await dialog.getByRole('switch', { name: '启用 机器规则.json', exact: true }).click();
  await expect.poll(async () => (await documents(page)).find(item => item.id === policy.id)?.enabled).toBe(true);
  assert.equal((await page.evaluate(id => window.jinggong.checkRequirements(id), session.id)).find(item => item.documentId === policy.id).status, 'fail');
  const removable = await createRequirement('可删除要求', '仅用于验证显式删除。');
  const row = dialog.locator('.managed-row').filter({ hasText: '可删除要求.md' });
  await row.getByRole('button', { name: '删除文档 可删除要求.md', exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect.poll(async () => (await documents(page)).some(item => item.id === removable.id)).toBe(false);
  checks.push('独立开发要求真实上传MD、直接输入、同ID编辑、启停与显式删除；JSON无效格式拒绝；真实Worktree文件违反forbid-text使checkRequirements失败，停用后移除门禁、重启前再启用');
  await assertBrand(page);
  await page.getByRole('button', { name: '关闭模型设置', exact: true }).click();
  await app.close(); app = undefined;

  page = await launch();
  const restored = await page.evaluate(() => window.jinggong.bootstrap());
  const savedSession = restored.sessions.find(item => item.id === session.id);
  assert.equal(savedSession.jiraIssue.summary, session.jiraIssue.summary);
  assert.equal(savedSession.workspacePath, session.workspacePath);
  assert.equal(restored.settings.jira.baseUrl, baseUrl); assert.equal(restored.settings.jira.hasPassword, true);
  assert.equal(restored.settings.documents.find(item => item.id === manual.id).content, edited.content);
  assert.equal(restored.settings.documents.find(item => item.id === policy.id).enabled, true);
  assert.ok(restored.settings.documents.some(item => item.id === imported.id));
  assert.ok(!restored.settings.documents.some(item => item.id === removable.id));
  assert.equal((await page.evaluate(id => window.jinggong.checkRequirements(id), session.id)).find(item => item.documentId === policy.id).status, 'fail');
  for (const filename of [path.join(data, 'database/jinggong-agent.db'), path.join(data, 'config/secrets/jira.dpapi'), path.join(data, 'config/secrets', `${profile.id}.dpapi`)]) {
    const bytes = await readFile(filename);
    for (const secret of [jiraPassword, modelSentinel]) assert.ok(!bytes.includes(Buffer.from(secret)) && !bytes.includes(Buffer.from(secret, 'utf16le')));
  }
  assert.equal(git(['rev-parse', 'HEAD']), sourceHead); assert.equal(git(['status', '--porcelain']), ''); assert.equal(git(['branch', '--show-current']), 'main');
  await page.getByRole('button', { name: 'Jira 任务', exact: true }).click();
  await page.locator('details.jira-query-controls > summary').click();
  await expect(page.getByLabel('Jira 项目范围', { exact: true })).toHaveValue('*');
  await expect(page.getByLabel('Jira 查询范围', { exact: true })).toHaveValue('daily');
  await expect(page.getByLabel('仅我的 Jira 任务', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Jira 自动抓取状态', { exact: true })).toContainText('已自动更新');
  await page.getByLabel('Jira 项目范围', { exact: true }).selectOption('*');
  await page.getByLabel('Jira 任务日期', { exact: true }).fill('2026-11-04');
  await page.getByRole('button', { name: '抓取任务', exact: true }).click();
  await page.getByRole('button', { name: '查看 Jira 任务 CD-435', exact: true }).click();
  await page.locator('#jira-panel .jira-issue-details').waitFor();
  const restoredQuery = state.requests.filter(request => request.jql).at(-1).jql;
  assert.ok(!restoredQuery.includes('project =') && restoredQuery.includes('cf[11116]') && restoredQuery.includes('assignee = currentUser()'));
  await assertBrand(page);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  assert.ok(state.requests.every(request => request.method === 'GET'));
  assert.ok(state.requests.some(request => request.jql?.includes('cf[11116] = "2026-11-04"')));
  checks.push('真实关闭重启后Jira配置、任务快照、编辑正文和启用状态仍由SQLite恢复；JSON门禁仍失败；数据库/DPAPI无合成密码明文，源main不变，固定UI文案无Codex');
  await app.close(); app = undefined;
  await persistReport(true, { fixtureRequestCount: state.requests.length, fixtureDetailReads: state.detailReads, modelRequests: 0 });
  console.log(JSON.stringify({ passed: true, checks, reportPath, screenshotPath }, null, 2));
} catch (error) {
  const message = String(error).split(jiraPassword).join('[已脱敏]').split(modelSentinel).join('[已脱敏]');
  if (app) {
    try { const page = await app.firstWindow(); await page.screenshot({ path: 'test-results/jira-requirements-failure.png', fullPage: true }); } catch { /* 进程异常退出时仍保留安全报告。 */ }
  }
  await persistReport(false, { error: message });
  throw new Error(message);
} finally {
  if (app) await app.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}

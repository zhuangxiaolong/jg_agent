import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 使用真实主进程、IPC、SQLite 与临时 Git；运行锁由合成令牌模拟，不启动模型推理。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-model-defaults-'));
const output = path.resolve(process.env.JINGGONG_TEST_OUTPUT || path.join(root, 'artifacts'));
const data = path.join(root, 'data'), home = path.join(root, 'home');
const main = path.join(root, 'main.cjs'), bootstrapFile = path.join(root, 'bootstrap.cjs');
const checks = [], logs = [], uiErrors = [];
await Promise.all([mkdir(home), mkdir(path.join(root, 'appdata')), mkdir(path.join(root, 'localappdata')), mkdir(output, { recursive: true })]);
await build({ entryPoints: ['apps/desktop/src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: main, external: ['electron'], define: { __dirname: JSON.stringify(path.resolve('dist')) }, plugins: [
  { name: 'fixture-sqljs', setup(build) { build.onResolve({ filter: /^sql\.js$/ }, () => ({ path: path.resolve('node_modules/sql.js/dist/sql-wasm.js'), external: true })); } },
  { name: 'fixture-lifecycle', setup(build) { build.onLoad({ filter: /apps[\\/]desktop[\\/]src[\\/]main[\\/]index\.ts$/ }, async args => ({ contents: await readFile(args.path, 'utf8') + '\n;(globalThis as any).__sessionDefaultsFixture = { getStore: () => store, runs };', loader: 'ts' })); } }
], logLevel: 'silent' });
await writeFile(bootstrapFile, [
  'const electron=require("electron");',
  'electron.app.setPath("appData",' + JSON.stringify(path.join(root, 'appdata')) + ');',
  'globalThis.__defaultsFetches=[];',
  'globalThis.fetch=async(input)=>{const url=String(input?.url||input);globalThis.__defaultsFetches.push(url);if(url.startsWith("https://jira.example.invalid/rest/api/2/issue/TEST-1"))return new Response(JSON.stringify({id:"fixture-issue",key:"TEST-1",fields:{summary:"合成模型默认值入口",description:"仅离线测试",status:{name:"Open"},issuetype:{name:"Bug"},attachment:[]}}),{headers:{"Content-Type":"application/json"}});throw new Error("合成验收禁止访问外部网络");};',
  'require(' + JSON.stringify(main) + ');'
].join('\n'));
const env = { ...process.env, JINGGONG_TEST_DATA: data, USERPROFILE: home, HOME: home, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), NODE_PATH: path.resolve('node_modules') };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
async function launch() {
  app = await electron.launch({ args: [bootstrapFile], cwd: process.cwd(), env });
  app.process().stdout?.on('data', chunk => logs.push(String(chunk)));
  app.process().stderr?.on('data', chunk => logs.push(String(chunk)));
  page = await app.firstWindow();
  page.on('pageerror', error => uiErrors.push(error.message));
  await page.route(/^https?:/, route => route.abort('blockedbyclient'));
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
}
async function close() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined); await app.close().catch(() => undefined); app = undefined; } }
const snapshot = () => page.evaluate(() => window.jinggong.bootstrap());
const defaults = () => app.evaluate(() => globalThis.__sessionDefaultsFixture.getStore().getSessionModelDefaults());
const create = input => page.evaluate(input => window.jinggong.createSession(input), input);
const configure = (id, input) => page.evaluate(({ id, input }) => window.jinggong.configureSession(id, input), { id, input });
function assertModel(session, providerId, model, reasoningEffort, runtimeKind) {
  assert.equal(session.providerId, providerId); assert.equal(session.model, model); assert.equal(session.reasoningEffort, reasoningEffort);
  if (runtimeKind) assert.equal(session.runtimeKind, runtimeKind);
}
async function createUi(action, expected, label) {
  const before = new Set((await snapshot()).sessions.map(item => item.id));
  await action();
  let created;
  await expect.poll(async () => { created = (await snapshot()).sessions.find(item => !before.has(item.id)); return !!created; }, { timeout: 30000 }).toBe(true);
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  assertModel(created, expected.providerId, expected.model, expected.reasoningEffort);
  await app.evaluate((_electron, id) => globalThis.__sessionDefaultsFixture.getStore().appendEvent({ id: 'keep-' + id, sessionId: id, type: 'user', text: '保留合成会话，避免空会话清理影响入口验收', createdAt: new Date().toISOString() }), created.id);
  checks.push(label);
  return created;
}
let result;
try {
  await launch();
  await page.evaluate(() => window.jinggong.saveRuntimeKind('codex'));
  const a = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '合成默认中转站A', baseUrl: 'https://a.example.invalid/v1', models: ['model-a', 'model-a2'], apiKey: 'synthetic-default-key-a' }));
  const b = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '合成默认中转站B', baseUrl: 'https://b.example.invalid/v1', models: ['model-b', 'model-b2'], apiKey: 'synthetic-default-key-b' }));
  assert.equal(await defaults(), undefined);
  for (const runtimeKind of ['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp']) assertModel(await create({ runtimeKind }), a.id, 'model-a', undefined, runtimeKind);
  checks.push('没有已保存偏好时，四 Runtime 保持原首中转站/首模型及模型默认推理强度');
  const source = await create({ runtimeKind: 'jinggong' });
  await configure(source.id, { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  assert.deepEqual(await defaults(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  assert.equal((await snapshot()).settings.runtimeKind, 'codex');
  for (const runtimeKind of ['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp']) assertModel(await create({ runtimeKind }), b.id, 'model-b2', 'high', runtimeKind);
  checks.push('成功保存非首中转站/模型和 high 后，四 Runtime 新建均继承，未改变全局 Runtime 默认');
  assertModel(await create({}), b.id, 'model-b2', 'high', 'claude_agent_sdk');
  await configure(source.id, { runtimeKind: 'claude_agent_sdk' });
  assert.deepEqual(await defaults(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  assert.equal((await snapshot()).settings.runtimeKind, 'codex');
  checks.push('单独切换 Runtime 不覆盖模型偏好，省略 Runtime 的 IPC 继续采用既有创建规则');

  await assert.rejects(configure(source.id, { providerId: b.id, model: 'removed-model', reasoningEffort: 'low' }), /无效/);
  await app.evaluate((_electron, id) => { globalThis.__defaultsTicket = globalThis.__sessionDefaultsFixture.runs.begin(id); }, source.id);
  await assert.rejects(configure(source.id, { providerId: a.id, model: 'model-a2', reasoningEffort: 'low' }), /请等待当前会话/);
  await app.evaluate(() => globalThis.__sessionDefaultsFixture.runs.finish(globalThis.__defaultsTicket));
  assert.deepEqual(await defaults(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  assertModel(await create({ runtimeKind: 'codex' }), b.id, 'model-b2', 'high', 'codex');
  checks.push('无效模型及真实主进程运行锁拒绝保存后，下一新会话仍使用最后成功配置');
  await app.evaluate(() => { const store = globalThis.__sessionDefaultsFixture.getStore(); globalThis.__defaultsOriginalSave = store.saveSession; store.saveSession = function(session, options) { if (options?.rememberModelDefaults) throw new Error('合成保存失败'); return globalThis.__defaultsOriginalSave.call(this, session, options); }; });
  await assert.rejects(configure(source.id, { providerId: b.id, model: 'model-b2', reasoningEffort: 'low' }), /合成保存失败/);
  await app.evaluate(() => { globalThis.__sessionDefaultsFixture.getStore().saveSession = globalThis.__defaultsOriginalSave; });
  assert.deepEqual(await defaults(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  checks.push('持久化接口失败时不提前更新新会话默认值');
  await configure(source.id, { providerId: b.id, model: 'model-b2', reasoningEffort: undefined });
  assert.deepEqual(await defaults(), { providerId: b.id, model: 'model-b2' });
  assertModel(await create({ runtimeKind: 'codex' }), b.id, 'model-b2', undefined, 'codex');
  await configure(source.id, { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  checks.push('明确保存模型默认推理会清除旧强度，后续新会话不残留 high');

  await close(); await launch();
  assert.deepEqual(await defaults(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  assertModel(await create({ runtimeKind: 'codex' }), b.id, 'model-b2', 'high', 'codex');
  assert.equal((await snapshot()).settings.runtimeKind, 'codex');
  checks.push('关闭并重新启动真实 Electron 后，模型偏好和推理强度持久化保留');
  for (const item of (await snapshot()).sessions) await page.evaluate(id => window.jinggong.deleteSession(id), item.id);
  await page.reload();
  await createUi(() => page.locator('.welcome-screen').getByRole('button', { name: '新建会话', exact: true }).click(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' }, '欢迎页新建入口继承已保存模型与 high');
  await createUi(() => page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' }, '顶部新建入口继承已保存模型与 high');
  await createUi(() => page.keyboard.press('Control+n'), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' }, 'Ctrl+N 新建入口继承已保存模型与 high');
  const repo = path.join(root, '合成项目'); await mkdir(repo);
  const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
  git(['init', '-b', 'main']); await writeFile(path.join(repo, 'README.md'), '# 合成默认模型回归\n'); git(['add', '.']); git(['-c', 'user.name=默认模型验收', '-c', 'user.email=test@example.invalid', 'commit', '-m', '建立默认模型验收样本']);
  await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
  const project = await page.evaluate(() => window.jinggong.selectProject());
  await page.reload();
  const projectGroup = page.getByRole('region', { name: '项目 ' + project.name, exact: true });
  if (await projectGroup.locator('.project-item').getAttribute('aria-expanded') !== 'true') await projectGroup.locator('.project-item').click();
  await createUi(() => page.getByRole('region', { name: '项目 ' + project.name, exact: true }).getByRole('button', { name: '新建会话', exact: true }).click(), { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' }, '项目组内新建入口创建真实 Git Worktree，并继承已保存模型与 high');
  await page.evaluate(() => window.jinggong.saveJira({ baseUrl: 'https://jira.example.invalid', account: 'synthetic-account', password: 'synthetic-jira-default-password', projectKey: 'TEST' }));
  const jiraSession = await create({ runtimeKind: 'jinggong', projectId: project.id, jiraIssueKey: 'TEST-1', jiraProjectKey: 'TEST', baseBranch: 'main' });
  assertModel(jiraSession, b.id, 'model-b2', 'high', 'jinggong'); assert.equal(jiraSession.jiraIssue.key, 'TEST-1');
  checks.push('Jira 关联新建链路复用相同默认值，Jira 返回由进程内合成响应提供');
  await page.screenshot({ path: path.join(output, 'new-session-saved-model-high.png'), fullPage: true });

  const c = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '合成无凭据中转站C', baseUrl: 'https://c.example.invalid/v1', models: ['model-c'] }));
  await configure(jiraSession.id, { providerId: c.id, model: 'model-c', reasoningEffort: 'xhigh' });
  assertModel(await create({ runtimeKind: 'codex' }), c.id, 'model-c', 'xhigh', 'codex');
  assertModel(await create({ runtimeKind: 'grok_build_acp' }), a.id, 'model-a', undefined, 'grok_build_acp');
  checks.push('跨 Runtime 不兼容时保持既有 Grok 凭据门槛，回退可用首模型及模型默认推理');
  await configure(jiraSession.id, { providerId: b.id, model: 'model-b2', reasoningEffort: 'high' });
  await page.evaluate(({ id }) => window.jinggong.saveModelProvider({ id, name: '合成默认中转站B', baseUrl: 'https://b.example.invalid/v1', models: ['model-b'] }), { id: b.id });
  assertModel(await create({ runtimeKind: 'codex' }), a.id, 'model-a', undefined, 'codex');
  checks.push('已保存模型被删除时保守回退现首项，不沿用失效模型或旧推理强度');
  await page.evaluate(id => window.jinggong.deleteModelProvider(id), b.id);
  assertModel(await create({ runtimeKind: 'codex' }), a.id, 'model-a', undefined, 'codex');
  assertModel(await create({ runtimeKind: 'grok_build_acp' }), a.id, 'model-a', undefined, 'grok_build_acp');
  checks.push('已保存中转站被删除时，普通及 Grok 新建均回退有效配置');
  await page.evaluate(async ({ a, c }) => { await window.jinggong.deleteModelProvider(a); await window.jinggong.deleteModelProvider(c); }, { a: a.id, c: c.id });
  assertModel(await create({ runtimeKind: 'codex' }), undefined, '', undefined, 'codex');
  await assert.rejects(create({ runtimeKind: 'grok_build_acp' }), /配置模型和 API Key/);
  checks.push('全部中转站删除后，普通会话保留空配置流程，Grok 仍拒绝无可用配置创建');
  assert.deepEqual(uiErrors, []);
  result = { passed: true, checks, scope: '真实 Electron/当前源码主进程/预加载IPC/SQLite/临时Git，四Runtime无推理；合成运行令牌和Jira响应；隔离Home/userData/凭据', testData: root };
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'session-model-defaults-failed.png'), fullPage: true }).catch(() => undefined);
  result = { passed: false, checks, error: String(error?.stack || error), uiErrors, testData: root };
  throw error;
} finally {
  await close();
  if (result) { const text = JSON.stringify(result, null, 2); await writeFile(path.join(output, 'session-model-defaults-smoke.json'), text); await writeFile(path.join(output, 'session-model-defaults-smoke.log'), text + '\n'); console.log(text); }
  await writeFile(path.join(output, 'session-model-defaults-process.log'), logs.join(''));
  if (result?.passed) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

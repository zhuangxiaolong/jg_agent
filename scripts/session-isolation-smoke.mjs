import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// UI 合成运行测试：真实 Electron、临时 SQLite/Git/附件；仅替换本测试进程的运行 IPC。
// 发送请求保持未结束并可单独完成/失败/取消，不配置凭据，不访问模型或 Jira。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-isolation-'));
const dataRoot = path.join(root, 'data');
const checks = [];
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const input = () => page.getByRole('textbox', { name: '输入任务', exact: true });
const sendButton = () => page.getByRole('button', { name: '发送任务', exact: true });
const stopButton = () => page.getByRole('button', { name: '停止', exact: true });
const boot = () => page.evaluate(() => window.jinggong.bootstrap());

async function fixture(name) {
  const repo = path.join(root, name);
  await mkdir(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  await writeFile(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(['add', '.']);
  git(['-c', 'user.name=会话隔离验收', '-c', 'user.email=test@example.invalid', 'commit', '-m', '建立会话隔离测试']);
  return repo;
}

async function installSyntheticRuns() {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    // Electron 私有 Map 仅用于独立测试进程，复用真实读取逻辑且不改变产品桥接。
    const handlers = ipcMain._invokeHandlers;
    if (!(handlers instanceof Map)) throw new Error('当前 Electron 不支持测试 IPC 包装');
    const originalBoot = handlers.get('app:bootstrap');
    const originalSettings = handlers.get('settings:get');
    const originalEvents = handlers.get('session:events');
    if (!originalBoot || !originalSettings || !originalEvents) throw new Error('桌面 IPC 尚未就绪');
    const state = { runs: new Map(), events: new Map(), sends: [], cancelled: [], eventId: 0 };
    const settings = value => ({ ...value, providers: [{ id: 'isolation-fixture', name: '本地隔离测试', baseUrl: 'https://fixture.example.invalid/v1', models: ['fixture-model'], hasKey: true }] });
    const publish = (id, type, text) => {
      const event = { id: `isolation-event-${++state.eventId}`, sessionId: id, type, text, createdAt: new Date().toISOString() };
      state.events.set(id, [...(state.events.get(id) || []), event]);
      for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('agent:event', event);
    };
    state.finish = (id, status = 'completed') => {
      const run = state.runs.get(id);
      if (!run?.resolve || run.status !== 'running') throw new Error(`没有待结束的合成运行：${id}`);
      run.status = status;
      publish(id, status === 'failed' ? 'error' : 'message', status === 'failed' ? '隔离测试：会话 A 合成失败' : `隔离测试：${status}`);
      publish(id, 'status', status);
      const resolve = run.resolve;
      delete run.resolve;
      resolve(status === 'failed' ? { ok: false, error: '隔离测试：会话 A 合成失败' } : { ok: true, value: undefined });
    };
    globalThis.__sessionIsolationFixture = state;
    ipcMain.removeHandler('app:bootstrap');
    ipcMain.handle('app:bootstrap', async (...args) => {
      const result = await originalBoot(...args);
      if (!result.ok) return result;
      const value = result.value;
      const health = { kind: 'codex', available: true, compatible: true, version: 'fixture-ui-only', detail: 'UI 合成运行，不访问模型' };
      const response = { ok: true, value: { ...value, activeSessionIds: [...state.runs].filter(([_id, run]) => run.status === 'running').map(([id]) => id), settings: settings(value.settings), runtime: health, runtimes: { ...value.runtimes, codex: health }, sessions: value.sessions.map(session => ({ ...session, providerId: 'isolation-fixture', model: 'fixture-model', status: state.runs.get(session.id)?.status || session.status })) } };
      if (state.finishDuringBootstrap) {
        const id = state.finishDuringBootstrap;
        delete state.finishDuringBootstrap;
        if (!response.value.activeSessionIds.includes(id)) throw new Error('竞态测试必须先捕获运行中的会话快照');
        // 初始 effect 在同一同步栈中 invoke bootstrap 后注册 onEvent；本处理器已 await
        // 真实 bootstrap，注册已完成。先发终态事件，再延迟返回已捕获的旧活动快照。
        state.finish(id, 'completed');
        await new Promise(resolve => setTimeout(resolve, 50));
        state.bootstrapRace = { sessionId: id, capturedActiveSessionIds: response.value.activeSessionIds, capturedStatus: response.value.sessions.find(session => session.id === id)?.status, returnedAfterCompletion: state.runs.get(id)?.status === 'completed' };
      }
      return response;
    });
    ipcMain.removeHandler('settings:get');
    ipcMain.handle('settings:get', async (...args) => {
      const result = await originalSettings(...args);
      return result.ok ? { ok: true, value: settings(result.value) } : result;
    });
    ipcMain.removeHandler('session:events');
    ipcMain.handle('session:events', async (event, id) => {
      const result = await originalEvents(event, id);
      return result.ok ? { ok: true, value: [...result.value, ...(state.events.get(id) || [])] } : result;
    });
    ipcMain.removeHandler('session:send');
    ipcMain.handle('session:send', (_event, id, payload) => {
      if (state.runs.get(id)?.status === 'running') return { ok: false, error: '当前会话已有运行任务' };
      state.sends.push({ id, prompt: payload.prompt, attachmentIds: payload.attachmentIds });
      publish(id, 'user', payload.prompt);
      publish(id, 'status', 'running');
      return new Promise(resolve => state.runs.set(id, { status: 'running', resolve }));
    });
    ipcMain.removeHandler('session:cancel');
    ipcMain.handle('session:cancel', (_event, id) => {
      state.cancelled.push(id);
      state.finish(id, 'interrupted');
      return { ok: true, value: undefined };
    });
    ipcMain.removeHandler('notification:complete');
    ipcMain.handle('notification:complete', () => ({ ok: true, value: undefined }));
  });
}

async function createSession(project, alias) {
  const previous = new Set((await boot()).sessions.map(session => session.id));
  if (project) {
    const group = page.getByRole('region', { name: `项目 ${project.name}`, exact: true });
    if (await group.locator('.project-item').getAttribute('aria-expanded') !== 'true') await group.locator('.project-item').click();
    await group.getByRole('button', { name: '新建会话', exact: true }).click();
  } else {
    // 独立会话作为隔离验收夹具显式创建；通用新建入口会继承当前选中项目。
    await page.evaluate(() => window.jinggong.createSession({}));
    await page.reload();
  }
  let created;
  await expect.poll(async () => {
    created = (await boot()).sessions.find(session => !previous.has(session.id));
    return created?.id || '';
  }, { timeout: 30000 }).not.toBe('');
  assert.ok(created, '新会话应真实保存到临时数据库');
  await expect(page.locator('.session-item.selected')).toHaveAttribute('title', created.title);
  await expect(page.getByLabel('当前会话本地项目', { exact: true })).toHaveValue(project?.id || '');
  await expect(input()).toBeEnabled({ timeout: 30000 });
  await expect(sendButton()).toBeVisible();
  if (alias) {
    await page.locator('.session-item.selected').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
    await page.getByRole('textbox', { name: '会话别名', exact: true }).fill(alias);
    await page.getByRole('button', { name: '保存会话别名', exact: true }).click();
    await expect(page.locator('.session-item.selected')).toHaveAttribute('title', alias);
  }
  return { ...created, alias };
}

async function choose(session) {
  await page.locator('.session-item').filter({ has: page.locator('.session-name', { hasText: session.alias }) }).click();
  await expect(page.locator('.workspace-header')).toContainText(session.alias);
}

async function startRun(session, text) {
  await input().fill(text);
  await expect(sendButton()).toBeEnabled();
  await sendButton().click();
  await expect(input()).toBeDisabled();
  await expect(stopButton()).toBeVisible();
  await expect.poll(() => app.evaluate((_electron, id) => globalThis.__sessionIsolationFixture.runs.get(id)?.status, session.id)).toBe('running');
}

async function finishRun(session, status) {
  await app.evaluate((_electron, { id, status }) => globalThis.__sessionIsolationFixture.finish(id, status), { id: session.id, status });
  await expect.poll(() => app.evaluate((_electron, id) => globalThis.__sessionIsolationFixture.runs.get(id)?.status, session.id)).toBe(status);
}

async function draftWithAttachment(text, filename) {
  await input().fill(text);
  const attachment = path.join(root, filename);
  await writeFile(attachment, `${text}\n`, 'utf8');
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, attachment);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.locator('.composer-attachment')).toContainText(filename);
}

try {
  await mkdir('test-results', { recursive: true });
  const repos = await Promise.all([fixture('隔离项目A'), fixture('隔离项目B')]);
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), cwd: process.cwd(), env });
  page = await app.firstWindow();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
  await installSyntheticRuns();
  const projects = [];
  for (const repo of repos) {
    await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
    projects.push(await page.evaluate(() => window.jinggong.selectProject()));
  }
  await page.reload();
  await expect(page.locator('.project-item')).toHaveCount(2);
  const sessionA = await createSession(projects[0], '隔离验收 A');
  await page.reload();
  await expect(input()).toBeEnabled();
  await startRun(sessionA, '合成任务 A：保持运行以验证会话隔离');
  const standalone = await createSession(undefined, '隔离验收独立会话');
  await expect(stopButton()).toHaveCount(0);
  await expect(page.locator('.working-indicator')).toHaveCount(0);
  await input().fill('新独立会话可输入');
  await expect(sendButton()).toBeEnabled();
  checks.push('项目 A 运行时，新建独立会话可输入和发送，未显示停止或运行提示');

  const sessionB = await createSession(projects[1], '隔离验收 B');
  await expect(stopButton()).toHaveCount(0);
  await startRun(sessionB, '合成任务 B：与会话 A 并行');
  await choose(sessionA);
  await expect(input()).toBeDisabled();
  await expect(stopButton()).toBeVisible();
  await choose(sessionB);
  await expect(input()).toBeDisabled();
  await expect(stopButton()).toBeVisible();
  checks.push('项目 B 可并行发送，切回 A/B 各自保持运行锁定与停止按钮');

  await choose(standalone);
  await draftWithAttachment('独立会话自己的草稿', '独立会话附件.md');
  await finishRun(sessionA, 'completed');
  await expect(input()).toBeEnabled();
  await expect(input()).toHaveValue('独立会话自己的草稿');
  await expect(page.locator('.composer-attachment')).toContainText('独立会话附件.md');
  // 等待 A 的 send Promise 回调读取保存的事件后再判断，避免只检查状态事件的瞬间。
  await expect.poll(() => page.evaluate(async id => (await window.jinggong.getEvents(id)).filter(event => event.type === 'status' && event.text === 'completed').length, sessionA.id)).toBe(1);
  await choose(sessionB);
  await expect(input()).toBeDisabled();
  await expect(stopButton()).toBeVisible();
  await page.screenshot({ path: 'test-results/session-isolation-parallel.png' });
  checks.push('后台 A 完成未清除独立会话的草稿/附件，也未解锁仍在运行的 B');

  await stopButton().click();
  await expect(input()).toBeEnabled({ timeout: 30000 });
  await expect(stopButton()).toHaveCount(0);
  assert.deepEqual(await app.evaluate(() => globalThis.__sessionIsolationFixture.cancelled), [sessionB.id]);
  checks.push('B 的停止请求仅携带 B 的会话 ID，A 完成状态保持独立');

  await choose(sessionA);
  await expect(input()).toBeEnabled();
  await startRun(sessionA, '合成任务 A 第二轮：测试后台失败');
  await choose(sessionB);
  await draftWithAttachment('会话 B 的草稿应保持', '会话B附件.md');
  await finishRun(sessionA, 'failed');
  await expect(input()).toHaveValue('会话 B 的草稿应保持');
  await expect(page.locator('.composer-attachment')).toContainText('会话B附件.md');
  await expect(page.getByRole('alert').filter({ hasText: '会话 A 合成失败' })).toHaveCount(0);
  await expect(input()).toBeEnabled();
  await expect(stopButton()).toHaveCount(0);
  await page.screenshot({ path: 'test-results/session-isolation-background-failure.png' });
  checks.push('后台 A 失败未污染当前 B 的错误、草稿、附件和可输入状态');

  await choose(sessionA);
  await startRun(sessionA, '合成任务 A 第三轮：刷新恢复运行状态');
  await choose(sessionB);
  await startRun(sessionB, '合成任务 B 第二轮：刷新恢复运行状态');
  await page.reload();
  await expect(input()).toBeDisabled({ timeout: 30000 });
  await choose(sessionA);
  await expect(input()).toBeDisabled();
  await expect(stopButton()).toBeVisible();
  await choose(sessionB);
  await expect(input()).toBeDisabled();
  await expect(stopButton()).toBeVisible();
  await createSession(undefined, '刷新后新建独立会话');
  await expect(input()).toBeEnabled();
  await expect(stopButton()).toHaveCount(0);
  checks.push('渲染器刷新从 activeSessionIds 恢复 A/B 运行状态，刷新后新会话仍可输入');

  await choose(sessionA);
  await stopButton().click();
  await expect(input()).toBeEnabled();
  await choose(sessionB);
  await expect(input()).toBeDisabled();
  await expect(stopButton()).toBeVisible();
  await stopButton().click();
  await expect(input()).toBeEnabled();
  checks.push('刷新后停止 A 不影响仍在运行的 B，B 可独立停止');

  await choose(sessionA);
  await startRun(sessionA, '合成任务 A 第四轮：终态事件先于初始快照返回');
  await app.evaluate((_electron, id) => { globalThis.__sessionIsolationFixture.finishDuringBootstrap = id; }, sessionA.id);
  await page.reload();
  await choose(sessionA);
  await expect(input()).toBeEnabled({ timeout: 30000 });
  await expect(stopButton()).toHaveCount(0);
  await expect(page.locator('.working-indicator')).toHaveCount(0);
  await expect(page.locator('.composer-caption .status-label')).toContainText('已完成');
  const bootstrapRace = await app.evaluate(() => globalThis.__sessionIsolationFixture.bootstrapRace);
  assert.equal(bootstrapRace.sessionId, sessionA.id);
  assert.equal(bootstrapRace.capturedStatus, 'running');
  assert.ok(bootstrapRace.capturedActiveSessionIds.includes(sessionA.id));
  assert.equal(bootstrapRace.returnedAfterCompletion, true);
  await page.screenshot({ path: 'test-results/session-isolation-bootstrap-race.png' });
  checks.push('初始快照中的旧 activeSessionIds 不覆盖已先到达的完成事件，会话可输入且无停止/运行提示');

  const summary = await app.evaluate(() => ({ sends: globalThis.__sessionIsolationFixture.sends, cancelled: globalThis.__sessionIsolationFixture.cancelled, statuses: [...globalThis.__sessionIsolationFixture.runs].map(([id, run]) => ({ id, status: run.status })), bootstrapRace: globalThis.__sessionIsolationFixture.bootstrapRace }));
  assert.equal(summary.sends.length, 6);
  assert.deepEqual(summary.cancelled, [sessionB.id, sessionA.id, sessionB.id]);
  assert.equal(summary.statuses.find(run => run.id === sessionB.id)?.status, 'interrupted');
  assert.equal(summary.statuses.find(run => run.id === sessionA.id)?.status, 'completed');
  const report = { date: new Date().toISOString(), passed: true, scope: '真实 Electron UI + 合成运行 IPC；未调用真实模型/Jira', checks, testData: root, ...summary };
  await writeFile('test-results/session-isolation-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page?.screenshot({ path: 'test-results/session-isolation-failure.png' }).catch(() => undefined);
  await writeFile('test-results/session-isolation-smoke.json', JSON.stringify({ date: new Date().toISOString(), passed: false, scope: '真实 Electron UI + 合成运行 IPC', checks, testData: root, error: error.stack || String(error) }, null, 2));
  throw error;
} finally { await app?.close(); }

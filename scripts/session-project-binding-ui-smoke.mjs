import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// 使用真实 App 与 Chromium、异步合成桥接，不启动桌面程序或调用真实模型。
const artifactRoot = process.env.JINGGONG_UI_ARTIFACT_ROOT || path.join(process.env.LOCALAPPDATA || 'C:/Users/Administrator/AppData/Local', 'JinggongAgent/verification/session-project-auto-bind-20261113');
await mkdir(artifactRoot, { recursive: true });
async function installedChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '';
  if (!root || !existsSync(root)) return undefined;
  const folders = (await readdir(root, { withFileTypes: true })).filter(item => /^chromium-\d+$/.test(item.name)).sort((a, b) => Number(b.name.slice(9)) - Number(a.name.slice(9)));
  for (const folder of folders) {
    for (const relative of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const candidate = path.join(root, folder.name, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function installFixture() {
  const now = '2026-11-13T00:00:00Z';
  const copy = value => JSON.parse(JSON.stringify(value));
  const provider = { id: 'common', name: '合成中转站', baseUrl: 'https://relay.invalid/v1', models: ['gpt-test'], hasKey: true };
  const settings = { runtimeKind: 'codex', preferences: { theme: 'dark', style: 'minimal', completionSound: 'off' }, providers: [provider], jira: { baseUrl: '', account: '', hasPassword: false }, documents: [], memories: [], update: { state: 'disabled', message: '合成离线回归' }, appVersion: '0.6.9', updateUrl: 'https://update.invalid' };
  const health = { available: true, compatible: true, version: '1.0.67', detail: '合成运行时状态' };
  const projects = [
    { id: 'project-a', name: '项目 A', path: 'C:/synthetic-projects/A', branch: 'feature/only-a', collapsed: false },
    { id: 'project-b', name: '项目 B', path: 'C:/synthetic-projects/B', branch: 'release', collapsed: false }
  ];
  const state = {
    sessions: [{ id: 'binding-session', title: '合成项目绑定会话', createdAt: now, workspacePath: 'C:/synthetic-workspaces/independent', runtimeKind: 'codex', providerId: 'common', model: 'gpt-test', status: 'idle' }],
    events: { 'binding-session': [{ id: 'history-1', sessionId: 'binding-session', type: 'user', text: '需要保留的合成历史消息', createdAt: now }] },
    calls: [], sequence: 0, diffs: [], diffDelay: 0, diffPending: 0, diffMaxPending: 0
  };
  const listeners = new Set();
  let mode = 'normal';
  let pending;
  const sessionById = id => {
    const item = state.sessions.find(session => session.id === id);
    if (!item) throw new Error('未知合成会话');
    return item;
  };
  const bootstrap = () => ({ projects: copy(projects), sessions: copy(state.sessions), activeSessionIds: state.sessions.filter(item => ['running', 'waiting-approval'].includes(item.status)).map(item => item.id), provider: { baseUrl: provider.baseUrl, model: 'gpt-test', hasKey: true }, runtime: health, runtimes: { codex: health, jinggong: health, claude_agent_sdk: health, grok_build_acp: health }, dataDirectory: 'C:/synthetic-data', gitVersion: 'synthetic', settings: copy(settings), layout: { leftVisible: true, rightVisible: false, bottomVisible: false, leftWidth: 220, rightWidth: 420, bottomHeight: 180 }, closeToTray: false });
  window.jinggong = {
    bootstrap: async () => { state.calls.push({ action: 'bootstrap' }); return bootstrap(); },
    getSettings: async () => copy(settings),
    saveLayout: async value => copy(value),
    getEvents: async id => copy(state.events[id] || []),
    listProjectBranches: async id => { state.calls.push({ action: 'branches', projectId: id }); return id === 'project-a' ? ['feature/only-a', 'main'] : ['release']; },
    bindSessionProject: async (id, projectId, baseBranch) => {
      state.calls.push({ action: 'bind', sessionId: id, projectId, baseBranch });
      if (mode === 'fail') throw new Error('合成绑定失败');
      if (mode === 'defer') await new Promise(resolve => { pending = resolve; });
      const item = sessionById(id);
      if (projectId) Object.assign(item, { projectId, baseBranch, branch: baseBranch, workspacePath: projects.find(project => project.id === projectId).path });
      else {
        delete item.projectId; delete item.baseBranch; delete item.branch;
        item.workspacePath = 'C:/synthetic-workspaces/independent';
      }
      return copy(item);
    },
    setProjectCollapsed: async (id, collapsed) => { projects.find(item => item.id === id).collapsed = collapsed; },
    deleteSession: async () => { throw new Error('回归期间不应删除已有历史的会话'); },
    listAgentTasks: async () => [], getFileDiff: async () => null,
    getDiff: async id => {
      const files = copy(state.diffs), delay = state.diffDelay;
      state.calls.push({ action: 'diff', sessionId: id });
      state.diffMaxPending = Math.max(state.diffMaxPending, ++state.diffPending);
      try { if (delay) await new Promise(resolve => setTimeout(resolve, delay)); return files; }
      finally { state.diffPending--; }
    },
    getGitState: async () => ({ branch: 'agent/synthetic', commits: [], remotes: [], dirty: false }),
    getProjectGitState: async target => ({ branch: projects.find(item => item.id === (typeof target === 'string' ? sessionById(target).projectId : target.projectId))?.branch || 'main', commits: [], remotes: [], dirty: false }),
    listVerificationRuns: async () => [], onVerification: () => () => {},
    browserState: async id => ({ sessionId: id, visible: false, tabs: [], downloads: [] }), setBrowserViewport: async () => {},
    notifyCompletion: async () => {}, markSessionRead: async () => {},
    onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    onBrowserState: () => () => {}, onUpdateStatus: () => () => {}, onSessionTitleChanged: () => () => {}, onAgentTaskEvent: () => () => {}
  };
  window.__state = () => copy({ ...state, pending: !!pending });
  window.__bindMode = value => { mode = value; };
  window.__files = (files, delay = 0) => { state.diffs = copy(files); state.diffDelay = delay; };
  window.__completeBinding = () => { if (!pending) throw new Error('没有等待中的合成绑定'); const resolve = pending; pending = undefined; resolve(); };
  window.__status = status => {
    sessionById('binding-session').status = status;
    const event = { id: 'status-' + (++state.sequence), sessionId: 'binding-session', type: 'status', text: status, createdAt: now };
    state.events['binding-session'].push(event);
    listeners.forEach(fn => fn(copy(event)));
  };
  createRoot(document.getElementById('root')).render(React.createElement(App));
}

const bundle = await build({ stdin: { contents: "import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './apps/desktop/src/renderer/App';import './apps/desktop/src/renderer/styles.css';(" + installFixture.toString() + ')();', loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, outdir: 'memory-session-project-binding', platform: 'browser', jsx: 'automatic', logLevel: 'silent' });
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
const executablePath = await installedChromium();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));
await page.route(/^https?:/, route => route.abort('blockedbyclient'));
const picker = () => page.getByLabel('当前会话本地项目', { exact: true });
const branchPicker = () => page.getByLabel('当前会话基准分支', { exact: true });
const snapshot = () => page.evaluate(() => window.__state());
const bindCalls = state => state.calls.filter(item => item.action === 'bind');
let result;
try {
  await page.setContent('<html lang="zh-CN" data-theme="dark" data-style="minimal"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(picker()).toBeEnabled();
  await expect(picker()).toHaveValue('');
  await expect(page.getByRole('button', { name: /^(绑定项目|切换项目|解除关联)$/ })).toHaveCount(0);
  const originalHistory = (await snapshot()).events['binding-session'];
  await picker().selectOption('project-a');
  await expect(picker()).toHaveValue('project-a');
  await expect(branchPicker()).toHaveCount(0);
  await expect(picker()).toBeEnabled();
  let state = await snapshot();
  assert.deepEqual(bindCalls(state), [{ action: 'bind', sessionId: 'binding-session', projectId: 'project-a', baseBranch: 'feature/only-a' }]);
  assert.deepEqual(state.events['binding-session'], originalHistory);
  checks.push('选择项目 A 立即调用绑定，使用 A 的基准分支，无额外绑定按钮且历史不变');

  await picker().selectOption('project-b');
  await expect(picker()).toHaveValue('project-b');
  assert.equal((await snapshot()).sessions[0].branch, 'release');
  await expect(picker()).toBeEnabled();
  state = await snapshot();
  assert.equal(bindCalls(state).length, 2);
  assert.equal(bindCalls(state).at(-1).baseBranch, 'release');
  assert.deepEqual(state.events['binding-session'], originalHistory);
  checks.push('从 A 切 B 立即绑定，采用 B 的 release，未串用 A 的私有 feature 分支');
  await page.screenshot({ path: path.join(artifactRoot, 'project-b-auto-bound.png'), fullPage: true });

  await picker().selectOption('project-b');
  await expect(picker()).toBeEnabled();
  assert.equal(bindCalls(await snapshot()).length, 2);
  checks.push('重复选择当前项目不重复调用绑定接口');

  await page.evaluate(() => window.__bindMode('fail'));
  const beforeFailure = await snapshot();
  await picker().selectOption('project-a');
  await expect(page.getByRole('alert')).toContainText('合成绑定失败');
  await expect(picker()).toHaveValue('project-b');
  await expect(picker()).toBeEnabled();
  state = await snapshot();
  assert.equal(bindCalls(state).length, 3);
  assert.deepEqual(state.sessions, beforeFailure.sessions);
  assert.deepEqual(state.events, beforeFailure.events);
  checks.push('绑定接口失败后选择器回到原项目，原会话、目录和聊天历史保持不变');
  await page.screenshot({ path: path.join(artifactRoot, 'project-bind-failure-rollback.png'), fullPage: true });

  await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('仅检查项目绑定锁，不发送');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  await page.evaluate(() => window.__bindMode('defer'));
  await picker().selectOption('project-a');
  await expect.poll(async () => (await snapshot()).pending).toBe(true);
  await expect(picker()).toBeDisabled();
  await expect(branchPicker()).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  assert.equal((await snapshot()).sessions[0].projectId, 'project-b');
  await page.screenshot({ path: path.join(artifactRoot, 'project-binding-busy-lock.png'), fullPage: true });
  await page.evaluate(() => window.__completeBinding());
  await expect(picker()).toHaveValue('project-a');
  await expect(picker()).toBeEnabled();
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  assert.equal(bindCalls(await snapshot()).length, 4);
  checks.push('异步绑定等待中项目、分支和发送均锁定；完成后恢复操作并切换到目标项目');

  await page.evaluate(() => window.__status('running'));
  await expect(picker()).toBeDisabled();
  await expect(branchPicker()).toHaveCount(0);
  const runningCalls = bindCalls(await snapshot()).length;
  await page.evaluate(() => window.__status('completed'));
  await expect(picker()).toBeEnabled();
  assert.equal(bindCalls(await snapshot()).length, runningCalls);
  checks.push('会话运行中禁用项目和分支选择，结束后恢复且不额外调用绑定');

  await page.getByRole('button', { name: '显示右侧面板', exact: true }).click();
  await page.locator('#git-panel-tab').click();
  await expect(page.getByLabel('会话执行权限', { exact: true })).toHaveCount(0);
  const changedFile = name => ({ path: name, status: 'added', additions: 1, deletions: 0, diff: `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+实际修改\n` });
  await expect.poll(async () => (await snapshot()).diffPending).toBe(0);
  await page.evaluate(file => { window.__files([file], 2600); window.__status('running'); }, changedFile('live-first.txt'));
  await expect(page.locator('.diff-file-row')).toContainText('live-first.txt', { timeout: 12000 });
  assert.equal((await snapshot()).sessions[0].status, 'running');
  assert.equal((await snapshot()).diffMaxPending, 1, '后台轮询不重叠慢请求');
  await expect(page.locator('#git-panel-tab span')).toHaveText('1');
  await page.evaluate(file => window.__files([file], 2600), changedFile('live-next.txt'));
  await expect(page.locator('.diff-file-row')).toContainText('live-next.txt', { timeout: 12000 });
  await expect.poll(async () => (await snapshot()).diffPending, { timeout: 7000 }).toBe(1);
  await page.evaluate(file => { window.__files([file]); window.__status('failed'); }, changedFile('final.txt'));
  await expect(page.locator('.diff-file-row')).toContainText('final.txt');
  await expect.poll(async () => (await snapshot()).diffPending, { timeout: 7000 }).toBe(0);
  await expect(page.locator('.diff-file-row')).toContainText('final.txt');
  const stoppedCalls = (await snapshot()).calls.filter(item => item.action === 'diff').length;
  await page.waitForTimeout(2300);
  assert.equal((await snapshot()).calls.filter(item => item.action === 'diff').length, stoppedCalls, '终态后停止后台轮询');
  checks.push('文件变更在任务结束前自动出现在 Git；慢请求不重叠，终态刷新不被迟到结果覆盖，终态停止轮询且界面不重复提示执行权限');
  await page.screenshot({ path: path.join(artifactRoot, 'live-session-git.png'), fullPage: true });
  await page.getByRole('button', { name: '隐藏右侧面板', exact: true }).click();

  await page.evaluate(() => window.__bindMode('normal'));
  const beforeUnlink = await snapshot();
  await picker().selectOption('');
  await expect(picker()).toHaveValue('');
  await expect(picker()).toBeEnabled();
  await expect(branchPicker()).toHaveCount(0);
  state = await snapshot();
  assert.equal(bindCalls(state).at(-1).projectId, '');
  assert.equal(bindCalls(state).at(-1).baseBranch, undefined);
  assert.equal(state.sessions[0].projectId, undefined);
  assert.deepEqual(state.events, beforeUnlink.events);
  await expect(page.getByText('需要保留的合成历史消息', { exact: true })).toBeVisible();
  await expect(page.getByText(/当前目录：|原目录已保留：|不会自动复制到当前目录/)).toHaveCount(0);
  checks.push('选择不关联项目立即自动解绑，隐藏基准分支并保留历史，不出现目录迁移聊天提示');
  assert.deepEqual(errors, []);
  checks.push('全程无浏览器异常，HTTP/HTTPS 网络请求全部拦截，未启动 EXE 或真实模型');
  await page.screenshot({ path: path.join(artifactRoot, 'project-auto-unlinked.png'), fullPage: true });
  result = { passed: true, checks, bindingCalls: bindCalls(state), errors, artifactRoot, scope: '真实 Chromium 与 React App；异步合成桥接/会话状态；不验证真实主进程、Git Worktree 或模型服务' };
} catch (error) {
  await page.screenshot({ path: path.join(artifactRoot, 'project-binding-failed.png'), fullPage: true }).catch(() => {});
  result = { passed: false, checks, errors, error: String(error?.stack || error), state: await snapshot().catch(() => null), artifactRoot };
  throw error;
} finally {
  if (result) {
    const report = JSON.stringify(result, null, 2);
    await writeFile(path.join(artifactRoot, 'session-project-binding-ui-smoke.json'), report, 'utf8');
    await writeFile(path.join(artifactRoot, 'session-project-binding-ui-smoke.log'), report + '\n', 'utf8');
    console.log(report);
  }
  await browser.close();
}

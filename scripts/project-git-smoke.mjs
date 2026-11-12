import assert from 'node:assert/strict';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const expect = baseExpect.configure({ timeout: 30000 });

// 所有远端均为临时本地裸仓库；不连接真实项目、模型或网络服务。
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-project-git-')));
const dataRoot = path.join(root, 'data');
const checks = [];
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
let session;
let projectA;
let projectB;

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'disabled-hooks')}`, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
}
async function commit(cwd, filename, content, message) {
  await writeFile(path.join(cwd, filename), content, 'utf8');
  git(cwd, ['add', '--', filename]);
  git(cwd, ['-c', 'user.name=项目Git验收', '-c', 'user.email=test@example.invalid', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}
async function fixture(name, branch, remote) {
  const repo = path.join(root, name);
  await mkdir(repo);
  git(repo, ['init', '-b', branch]);
  git(repo, ['config', 'core.autocrlf', 'false']);
  await commit(repo, 'README.md', `# ${name}\n初始代码\n`, '建立项目Git验收基线');
  if (!remote) return { repo };
  const bare = path.join(root, `${name}.git`);
  const peer = path.join(root, `${name}远端副本`);
  git(root, ['init', '--bare', '-b', branch, bare]);
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['push', '-u', 'origin', branch]);
  git(root, ['clone', bare, peer]);
  git(peer, ['config', 'core.autocrlf', 'false']);
  return { repo, bare, peer };
}
async function launch() {
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env, cwd: process.cwd() });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await expect(page.locator('.brand strong')).toHaveText('精工Agent');
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await app.evaluate(({ dialog }) => {
    globalThis.__projectGitConfirmations = [];
    globalThis.__projectGitResponse = 1;
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__projectGitConfirmations.push({ title: options.title, message: options.message, detail: options.detail });
      return { response: globalThis.__projectGitResponse, checkboxChecked: false };
    };
  });
}
const bootstrap = () => page.evaluate(() => window.jinggong.bootstrap());
const picker = () => page.getByLabel('当前会话本地项目', { exact: true });
const projectGit = () => page.getByRole('region', { name: '项目仓库 Git', exact: true });
const fetchButton = () => projectGit().getByRole('button', { name: '获取远程更新', exact: true });
const pullButton = () => projectGit().getByRole('button', { name: '拉取项目代码', exact: true });
const pushButton = () => projectGit().getByRole('button', { name: '推送项目分支', exact: true });
async function refreshProject() {
  const button = projectGit().getByRole('button', { name: '刷新项目 Git 状态', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
}
async function currentSession(id) { return (await bootstrap()).sessions.find(item => item.id === id); }
async function bindProject(id, target) {
  await picker().selectOption(target.id);
  await expect(page.getByLabel('当前会话基准分支', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: (await currentSession(id)).projectId ? '切换项目' : '绑定项目', exact: true }).click();
  await expect.poll(async () => (await currentSession(id))?.projectId).toBe(target.id);
  await expect(picker()).toHaveValue(target.id);
  await expect(picker()).toBeEnabled();
}
async function confirmResponse(response) {
  await app.evaluate((_electron, value) => { globalThis.__projectGitResponse = value; }, response);
}
function assertWorkspaceUnchanged(workspace, head) {
  assert.equal(git(workspace, ['rev-parse', 'HEAD']), head, '项目操作不能移动会话工作区的 HEAD');
  assert.equal(git(workspace, ['status', '--porcelain']), '', '项目操作不能修改会话工作区');
}
async function saveReport(passed, extra = {}) {
  await mkdir('test-results', { recursive: true });
  const report = { date: new Date().toISOString(), passed, checks, executable: process.env.JINGGONG_TEST_EXE || '开发 Electron', testData: root, ...extra };
  await writeFile('test-results/project-git-smoke.json', JSON.stringify(report, null, 2));
  await writeFile('test-results/project-git-smoke.md', `# 项目 Git 桌面验收\n\n- 结果：${passed ? '通过' : '失败'}\n- 时间：${report.date}\n- 执行程序：${report.executable}\n- 临时数据：${root}\n\n${checks.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n${extra.error ? `\n失败原因：${extra.error}\n` : ''}`);
  return report;
}

try {
  const [a, b] = await Promise.all([fixture('项目A 含空格', 'main', true), fixture('项目B', 'release', false)]);
  await mkdir('test-results', { recursive: true });
  await launch();
  await page.keyboard.press('Control+n');
  await expect(picker()).toBeVisible();
  const projects = [];
  for (const repo of [a.repo, b.repo]) {
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, repo);
    projects.push(await page.evaluate(() => window.jinggong.selectProject()));
  }
  [projectA, projectB] = projects;
  assert.ok(projectA && projectB);
  await page.reload();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await expect(picker()).toBeVisible();
  session = (await bootstrap()).sessions[0];
  await expect(page.getByRole('button', { name: 'Git', exact: true })).toBeDisabled();
  await assert.rejects(page.evaluate(id => window.jinggong.getProjectGitState(id), session.id), /关联|项目/);
  session = await page.evaluate(id => window.jinggong.renameSession(id, '项目 Git 主会话'), session.id);
  await page.reload();
  await expect(picker()).toBeVisible();
  checks.push('独立会话禁用 Git 入口，项目 Git IPC 同样拒绝未绑定会话');

  const selectedProjectHead = await commit(a.peer, '项目选择拉取.txt', '无需创建或绑定会话即可拉取项目\n', '验证选择项目后直接拉取');
  git(a.peer, ['push', 'origin', 'main']);
  await page.locator('.project-item').filter({ hasText: projectA.name }).click();
  await expect(page.getByRole('button', { name: 'Git', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await expect(projectGit()).toContainText(a.repo);
  await expect(pullButton()).toBeEnabled();
  assert.equal((await currentSession(session.id)).projectId, undefined);
  await pullButton().click();
  await expect(pullButton()).toBeEnabled();
  await expect.poll(() => git(a.repo, ['rev-parse', 'HEAD'])).toBe(selectedProjectHead);
  assert.equal(await readFile(path.join(a.repo, '项目选择拉取.txt'), 'utf8'), '无需创建或绑定会话即可拉取项目\n');
  assert.equal((await currentSession(session.id)).projectId, undefined);
  await assert.rejects(page.evaluate(() => window.jinggong.getProjectGitState({ projectId: '000000000000000000000000' })), /项目|不存在/);
  checks.push('左侧仅选择项目即可启用主界面 Git 并真实快进拉取，无需绑定或创建项目会话；无效项目ID被拒绝');

  await bindProject(session.id, projectA);
  session = await currentSession(session.id);
  const workspace = session.workspacePath;
  const workspaceHead = git(workspace, ['rev-parse', 'HEAD']);
  const initialContent = await readFile(path.join(workspace, 'README.md'), 'utf8');
  const initialHead = git(a.repo, ['rev-parse', 'HEAD']);
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await expect(projectGit()).toBeVisible();
  await expect(projectGit()).toContainText(a.repo);
  await expect(projectGit()).toContainText('main');
  await expect(projectGit().getByLabel('项目远程仓库', { exact: true })).toHaveValue('origin');
  await expect(fetchButton()).toBeEnabled();
  await expect(pullButton()).toBeEnabled();
  await expect(pushButton()).toBeEnabled();
  checks.push('绑定项目后直接在主界面 Git 显示实际项目目录/main 分支及获取、拉取、推送入口');

  const remoteHead = await commit(a.peer, 'README.md', '# 项目A远程更新\n从主界面拉取\n', '远程更新项目代码');
  git(a.peer, ['push', 'origin', 'main']);
  await fetchButton().click();
  await expect(fetchButton()).toBeEnabled();
  await expect.poll(() => git(a.repo, ['rev-parse', 'refs/remotes/origin/main'])).toBe(remoteHead);
  assert.equal(git(a.repo, ['rev-parse', 'HEAD']), initialHead);
  assert.equal(await readFile(path.join(a.repo, 'README.md'), 'utf8'), initialContent);
  assertWorkspaceUnchanged(workspace, workspaceHead);
  checks.push('获取远程更新真实更新 origin/main，不移动项目当前分支或修改项目/会话文件');

  const confirmationsBeforePull = (await app.evaluate(() => globalThis.__projectGitConfirmations)).length;
  await pullButton().click();
  await expect(pullButton()).toBeEnabled();
  await expect.poll(() => git(a.repo, ['rev-parse', 'HEAD'])).toBe(remoteHead);
  assert.equal(await readFile(path.join(a.repo, 'README.md'), 'utf8'), '# 项目A远程更新\n从主界面拉取\n');
  assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), initialContent);
  assertWorkspaceUnchanged(workspace, workspaceHead);
  assert.equal(git(a.repo, ['branch', '--show-current']), 'main');
  assert.equal((await app.evaluate(() => globalThis.__projectGitConfirmations)).length, confirmationsBeforePull, '项目拉取不应弹出确认框');
  checks.push('项目拉取直接执行真实 main 快进，不弹确认框；会话隔离分支 HEAD/内容保持原样');

  const dirtyFile = path.join(a.repo, '未提交阻断.txt');
  await writeFile(dirtyFile, '本地未提交内容不能被拉取覆盖\n');
  await refreshProject();
  await expect(pullButton()).toBeDisabled();
  await expect(pushButton()).toBeDisabled();
  await expect(fetchButton()).toBeEnabled();
  await assert.rejects(page.evaluate(id => window.jinggong.pullProjectChanges(id, 'origin'), session.id), /未提交|变更|整理/);
  await assert.rejects(page.evaluate(id => window.jinggong.pushProjectChanges(id, 'origin'), session.id), /未提交|变更|整理/);
  assert.equal(await readFile(dirtyFile, 'utf8'), '本地未提交内容不能被拉取覆盖\n');
  assert.equal(git(a.repo, ['rev-parse', 'HEAD']), remoteHead);
  await rm(dirtyFile);
  await refreshProject();
  await expect(pullButton()).toBeEnabled();
  checks.push('项目存在未跟踪文件时 UI 禁用拉取/推送，直接 IPC 也拒绝且保留本地文件');

  const pushedHead = await commit(a.repo, '本地推送.txt', '通过主界面推送\n', '准备项目分支推送');
  await refreshProject();
  await pushButton().click();
  await expect(pushButton()).toBeEnabled();
  await expect.poll(() => git(a.bare, ['rev-parse', 'refs/heads/main'])).toBe(pushedHead);
  assertWorkspaceUnchanged(workspace, workspaceHead);
  checks.push('主界面推送真实更新所选项目远程 main，不推送或修改会话 agent 分支');

  git(a.peer, ['pull', '--ff-only', 'origin', 'main']);
  await commit(a.peer, '远端独立提交.txt', '制造分支分歧\n', '准备远端分歧');
  git(a.peer, ['push', 'origin', 'main']);
  const localDiverged = await commit(a.repo, '本地独立提交.txt', '保留本地独立提交\n', '准备本地分歧');
  await refreshProject();
  await pullButton().click();
  await expect(pullButton()).toBeEnabled();
  await expect(projectGit().locator('.form-error')).toContainText(/分歧|分叉|快进/);
  assert.equal(git(a.repo, ['rev-parse', 'HEAD']), localDiverged);
  assert.equal(git(a.repo, ['status', '--porcelain']), '');
  assert.equal(git(a.repo, ['ls-files', '-u']), '');
  assertWorkspaceUnchanged(workspace, workspaceHead);
  checks.push('远程/本地分歧时拒绝拉取，不创建合并提交、冲突文件或移动本地 HEAD');

  await bindProject(session.id, projectB);
  await expect(projectGit()).toContainText(b.repo);
  await expect(projectGit()).toContainText('release');
  await expect(projectGit()).not.toContainText(a.repo);
  await expect(projectGit().locator('.form-error')).toHaveCount(0);
  await expect(fetchButton()).toBeDisabled();
  await expect(pullButton()).toBeDisabled();
  await expect(pushButton()).toBeDisabled();
  const bState = await page.evaluate(id => window.jinggong.getProjectGitState(id), session.id);
  assert.equal(bState.branch, 'release');
  assert.deepEqual(bState.remotes, []);
  assert.equal(git(a.repo, ['rev-parse', 'HEAD']), localDiverged);
  checks.push('同一会话切换项目后 Git 随绑定更新实际目录/release 分支，旧项目错误清空，无远程时禁用网络操作');
  await page.screenshot({ path: 'test-results/project-git-project-switch.png' });

  // 显式准备独立会话，再验证无项目选择时的通用新建入口。
  await page.evaluate(() => window.jinggong.createSession({}));
  await page.reload();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await page.keyboard.press('Control+n');
  await expect(picker()).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Git', exact: true })).toBeDisabled();
  const standalone = (await bootstrap()).sessions.find(item => !item.projectId);
  assert.ok(standalone);
  await assert.rejects(page.evaluate(id => window.jinggong.pullProjectChanges(id, 'origin'), standalone.id), /关联|项目/);
  checks.push('切换到新独立会话后项目 Git 不可操作，不遗留上个会话目标');

  // 回到原会话再次绑定项目A，保留主面板截图，便于检查常见窗口尺寸。
  if (!await page.locator(`#project-sessions-${projectB.id}`).isVisible()) await page.locator('.project-item').filter({ hasText: projectB.name }).click();
  await page.locator('.session-item').filter({ hasText: '项目 Git 主会话' }).click();
  await expect(picker()).toHaveValue(projectB.id);
  await bindProject(session.id, projectA);
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await expect(projectGit()).toContainText(a.repo);
  for (const [width, height] of [[1366, 768], [1600, 900]]) {
    await page.setViewportSize({ width, height });
    await expect(projectGit()).toBeVisible();
    await expect(pullButton()).toBeVisible();
    const sizes = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, panelWidth: document.querySelector('#git-panel').clientWidth, panelScrollWidth: document.querySelector('#git-panel').scrollWidth }));
    assert.ok(sizes.documentWidth <= sizes.width + 1, JSON.stringify(sizes));
    assert.ok(sizes.panelScrollWidth <= sizes.panelWidth + 1, JSON.stringify(sizes));
    await page.screenshot({ path: `test-results/project-git-${width}x${height}.png` });
  }
  checks.push('1366×768、1600×900 主界面 Git 无横向溢出，项目拉取按钮可见并保存截图');
  console.log(JSON.stringify(await saveReport(true), null, 2));
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await page?.screenshot({ path: 'test-results/project-git-failure.png' }).catch(() => undefined);
  await saveReport(false, { error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await app?.close();
}

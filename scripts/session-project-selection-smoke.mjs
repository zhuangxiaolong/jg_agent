import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 Electron、SQLite 与 Git Worktree；仅使用临时数据，不配置模型或 Jira。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-project-selection-'));
const dataRoot = path.join(root, 'data');
const checks = [];
const createdSessions = [];
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
const bootstrap = () => page.evaluate(() => window.jinggong.bootstrap());
const topCreate = () => page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true });
const welcomeCreate = () => page.locator('.welcome-screen').getByRole('button', { name: '新建会话', exact: true });
const picker = () => page.getByLabel('当前会话本地项目', { exact: true });
const projectGroup = project => page.getByRole('region', { name: `项目 ${project.name}`, exact: true });
const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
const canonical = value => path.resolve(value).replace(/\\/g, '/').toLowerCase();

async function fixture(name, branch) {
  const repo = path.join(root, name);
  await mkdir(repo);
  git(repo, ['init', '-b', branch]);
  await writeFile(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=项目关联验收', '-c', 'user.email=test@example.invalid', 'commit', '-m', '建立项目关联验收样本']);
  return repo;
}

async function renameSelected(alias) {
  await page.locator('.session-item.selected').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.getByRole('textbox', { name: '会话别名', exact: true }).fill(alias);
  await page.getByRole('button', { name: '保存会话别名', exact: true }).click();
  await expect(page.locator('.session-item.selected')).toHaveAttribute('title', alias);
}

async function createFrom(action, project, alias) {
  const before = new Set((await bootstrap()).sessions.map(session => session.id));
  await action();
  let created;
  await expect.poll(async () => {
    const additions = (await bootstrap()).sessions.filter(session => !before.has(session.id));
    assert.ok(additions.length <= 1, '单次创建只能新增一个会话');
    created = additions[0];
    return created?.id || '';
  }, { timeout: 30000 }).not.toBe('');
  await expect(topCreate()).toBeEnabled({ timeout: 30000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toBeVisible();
  await expect(picker()).toHaveValue(project?.id || '');
  assert.equal(created.projectId, project?.id, alias);
  assert.equal(created.workspaceId, undefined);
  assert.equal(Object.hasOwn(created, 'mode'), false);
  assert.ok(path.isAbsolute(created.workspacePath));
  const actualPath = await realpath(created.workspacePath);
  if (project) {
    assert.equal(created.baseBranch, project.branch, `${alias} 必须使用目标项目分支`);
    assert.ok(created.branch?.startsWith('agent/'));
    assert.notEqual(canonical(actualPath), canonical(await realpath(project.path)));
    assert.equal(canonical(git(actualPath, ['rev-parse', '--show-toplevel'])), canonical(actualPath));
    assert.equal(git(actualPath, ['branch', '--show-current']), created.branch);
    const registered = git(project.path, ['worktree', 'list', '--porcelain']);
    assert.ok(registered.split(/\r?\n/).some(line => line.startsWith('worktree ') && canonical(line.slice(9)) === canonical(actualPath)), '隔离目录必须登记为真实 Git Worktree');
    await expect(projectGroup(project).locator('.project-item')).toHaveClass(/selected/);
    await expect(projectGroup(project).locator('.project-item')).toHaveAttribute('aria-expanded', 'true');
    await expect(projectGroup(project).locator('.session-item.selected')).toHaveCount(1);
    await expect(page.locator('.standalone-sessions .session-item.selected')).toHaveCount(0);
    assert.equal((await readFile(path.join(actualPath, 'README.md'), 'utf8')).replace(/\r\n/g, '\n'), `# ${project.name}\n`);
  } else {
    assert.equal(created.baseBranch, undefined);
    assert.equal(created.branch, undefined);
    assert.equal(canonical(actualPath), canonical(await realpath(path.join(dataRoot, 'sessions', created.id))));
    await expect(page.locator('.project-item.selected')).toHaveCount(0);
    await expect(page.locator('.standalone-sessions .session-item.selected')).toHaveCount(1);
  }
  await renameSelected(alias);
  createdSessions.push({ id: created.id, alias, projectId: created.projectId, baseBranch: created.baseBranch, workspacePath: created.workspacePath });
  return { ...created, alias };
}

async function addProject(repo) {
  const before = new Set((await bootstrap()).projects.map(project => project.id));
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  let added;
  await expect.poll(async () => {
    added = (await bootstrap()).projects.find(project => !before.has(project.id));
    return added?.id || '';
  }, { timeout: 30000 }).not.toBe('');
  await expect(projectGroup(added).locator('.project-item')).toHaveClass(/selected/);
  await expect(page.locator('.session-item.selected')).toHaveCount(0);
  await expect(welcomeCreate()).toBeVisible();
  await expect(topCreate()).toBeEnabled({ timeout: 30000 });
  return added;
}

async function choose(session, project) {
  const group = project ? projectGroup(project) : page.locator('.standalone-sessions');
  if (project && await group.locator('.project-item').getAttribute('aria-expanded') !== 'true') await group.locator('.project-item').click();
  await group.locator('.session-item').filter({ has: page.locator('.session-name', { hasText: session.alias }) }).click();
  await expect(page.locator('.session-item.selected')).toHaveAttribute('title', session.alias);
  await expect(picker()).toHaveValue(project?.id || '');
}

try {
  await mkdir('test-results', { recursive: true });
  const [repoA, repoB] = await Promise.all([fixture('关联项目 A', 'feature/only-a'), fixture('关联项目 B', 'release')]);
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), cwd: process.cwd(), env });
  page = await app.firstWindow();
  await expect(topCreate()).toBeEnabled({ timeout: 30000 });
  assert.equal((await bootstrap()).projects.length, 0);
  const standalone = await createFrom(() => welcomeCreate().click(), undefined, '无项目欢迎页会话');
  await createFrom(() => topCreate().click(), undefined, '无项目顶部会话');
  await createFrom(() => page.keyboard.press('Control+n'), undefined, '无项目快捷键会话');
  checks.push('无本地项目时，欢迎页、顶部按钮和 Ctrl+N 均创建真实独立会话，保存在独立列表');

  const projectA = await addProject(repoA);
  const sessionA = await createFrom(() => welcomeCreate().click(), projectA, '项目 A 欢迎页会话');
  await createFrom(() => topCreate().click(), projectA, '项目 A 顶部会话');
  checks.push('添加项目 A 后欢迎页和顶部新建自动关联 A，使用 A 专有 feature/only-a 分支并创建真实隔离 Worktree');

  const projectB = await addProject(repoB);
  await createFrom(() => topCreate().click(), projectB, '项目 B 添加后顶部会话');
  checks.push('添加项目 B 后主界面选中 B，顶部新建自动关联 B 的 release 分支');

  await choose(sessionA, projectA);
  await expect(page.getByLabel('当前会话基准分支', { exact: true })).toHaveValue('feature/only-a');
  await projectGroup(projectB).locator('.project-item').click();
  await expect(projectGroup(projectB).locator('.project-item')).toHaveClass(/selected/);
  await expect(page.locator('.session-item.selected')).toHaveAttribute('title', sessionA.alias);
  await expect(picker()).toHaveValue(projectA.id);
  await createFrom(() => page.keyboard.press('Control+n'), projectB, '项目 B 切换后快捷键会话');
  checks.push('A 会话仍显示时点击项目 B，Ctrl+N 关联新选中的 B；未把 A 专有分支带到 B，也未使用旧快捷键闭包');

  if (await projectGroup(projectA).locator('.project-item').getAttribute('aria-expanded') !== 'true') await projectGroup(projectA).locator('.project-item').click();
  await projectGroup(projectB).locator('.project-item').click();
  await expect(projectGroup(projectB).locator('.project-item')).toHaveClass(/selected/);
  await createFrom(() => projectGroup(projectA).getByRole('button', { name: '新建会话', exact: true }).click(), projectA, '项目 A 显式入口会话');
  checks.push('主界面选中 B 时，项目 A 组内的显式新建入口仍关联 A，展开 A 列表并选中新会话');

  await choose(standalone);
  await expect(page.locator('.project-item.selected')).toHaveCount(0);
  await createFrom(() => topCreate().click(), undefined, '选择独立会话后顶部会话');
  const last = await createFrom(() => page.keyboard.press('Control+n'), undefined, '选择独立会话后快捷键会话');
  checks.push('选择已有独立会话后清除项目选择，顶部按钮和 Ctrl+N 继续创建独立会话');

  await page.reload();
  await expect(topCreate()).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('.session-item.selected')).toHaveAttribute('title', last.alias);
  await expect(picker()).toHaveValue('');
  const saved = await bootstrap();
  for (const expected of createdSessions) {
    const actual = saved.sessions.find(session => session.id === expected.id);
    assert.ok(actual, '创建结果必须在刷新后仍可从真实 SQLite 读取');
    assert.equal(actual.projectId, expected.projectId);
    assert.equal(actual.baseBranch, expected.baseBranch);
    assert.equal(actual.workspacePath, expected.workspacePath);
  }
  checks.push('页面刷新后全部会话的项目、基准分支、隔离目录及最新会话选择持久化保持');
  await page.screenshot({ path: 'test-results/session-project-selection-smoke.png' });
  const report = { date: new Date().toISOString(), passed: true, checks, createdSessions, testData: root, executable: process.env.JINGGONG_TEST_EXE || '开发 Electron' };
  await writeFile('test-results/session-project-selection-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await page?.screenshot({ path: 'test-results/session-project-selection-failure.png' }).catch(() => undefined);
  await writeFile('test-results/session-project-selection-smoke.json', JSON.stringify({ date: new Date().toISOString(), passed: false, checks, createdSessions, testData: root, error: error.message }, null, 2));
  throw error;
} finally { await app?.close(); }

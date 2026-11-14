import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 使用临时 Git 仓库和独立 SQLite 数据验证真实桌面交互，不配置模型或 Jira。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-project-context-menu-'));
const env = { ...process.env, JINGGONG_TEST_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
let app, page;
const bootstrap = () => page.evaluate(() => window.jinggong.bootstrap());
const group = project => page.getByRole('region', { name: `项目 ${project.name}`, exact: true });
const row = project => group(project).locator('.project-item');
const menu = () => page.getByRole('menu');
const create = () => page.getByRole('menuitem', { name: '新建会话', exact: true });
const picker = () => page.getByLabel('当前会话本地项目', { exact: true });

async function addProject(name) {
  const repo = path.join(root, name);
  await mkdir(repo);
  const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
  git(['init', '-b', 'main']);
  await writeFile(path.join(repo, 'README.md'), `# ${name}\n`);
  git(['add', '.']);
  git(['-c', 'user.name=项目菜单验收', '-c', 'user.email=test@example.invalid', 'commit', '-m', '创建菜单验收样本']);
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  await expect(page.locator('.top-nav button')).toBeEnabled();
  const project = (await bootstrap()).projects.find(item => item.name === name);
  assert.ok(project);
  assert.equal((await realpath(project.path)).toLowerCase(), (await realpath(repo)).toLowerCase());
  return project;
}

async function expectCreated(project, before) {
  let created;
  await expect.poll(async () => {
    const additions = (await bootstrap()).sessions.filter(item => !before.has(item.id));
    assert.ok(additions.length <= 1, '一次菜单操作只能创建一个会话');
    created = additions[0];
    return created?.projectId;
  }, { timeout: 30000 }).toBe(project.id);
  await expect(page.locator('.top-nav button')).toBeEnabled();
  await expect(menu()).toHaveCount(0);
  await expect(picker()).toHaveValue(project.id);
  await expect(row(project)).toHaveClass(/selected/);
  await expect(row(project)).toHaveAttribute('aria-expanded', 'true');
  assert.equal(path.resolve(created.workspacePath), path.resolve(project.path));
  await page.getByRole('textbox', { name: '输入任务', exact: true }).fill(`保留 ${created.id} 的未发送草稿`);
  return created;
}

try {
  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  page = await app.firstWindow();
  await expect(page.locator('.top-nav button')).toBeEnabled({ timeout: 30000 });
  const projectA = await addProject('菜单项目 A');
  const projectB = await addProject('菜单项目 B');
  await expect(row(projectB)).toHaveClass(/selected/);
  await row(projectA).click();
  await expect(row(projectA)).toHaveClass(/selected/);
  await expect(row(projectA)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.project-group').getByRole('button', { name: '新建会话', exact: true })).toHaveCount(0);
  assert.equal((await bootstrap()).sessions.length, 0);
  checks.push('本地项目无常驻新建会话按钮；单击只选择项目并展开，不创建会话');

  await row(projectB).click({ button: 'right' });
  await expect(row(projectB)).toHaveAttribute('aria-expanded', 'false');
  await expect(row(projectA)).toHaveClass(/selected/);
  await expect(create()).toBeFocused();
  await expect(page.getByRole('menuitem', { name: '修改名称', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '删除项目', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'project-context-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0);
  await expect(row(projectB)).toBeFocused();
  checks.push('右键折叠项目显示新建、改名和删除；不切换选择或折叠状态，Escape 恢复焦点');

  await page.keyboard.press('Shift+F10');
  await expect(create()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '修改名称', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  const sessionB = await expectCreated(projectB, new Set());
  checks.push('Shift+F10、方向键、Home 和 Enter 可新建会话，绑定右键目标 B 并自动展开，使用本地项目目录');

  await row(projectA).click({ button: 'right' });
  await create().click();
  const sessionA = await expectCreated(projectA, new Set([sessionB.id]));
  checks.push('当前为 B 时右键 A 新建，准确绑定 A；B 的未发送草稿会话保留');

  await group(projectA).locator('.session-item.selected').click({ button: 'right' });
  await expect(create()).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '修改名称', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await row(projectA).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称', exact: true }).click();
  await page.getByRole('textbox', { name: '项目显示名称', exact: true }).fill('菜单改名验收');
  await page.getByRole('button', { name: '保存项目显示名称', exact: true }).click();
  await expect(page.locator('.project-item.selected')).toHaveText('菜单改名验收');
  checks.push('会话右键菜单不增加项目创建入口，项目原有改名操作正常');

  const beforeShortcut = new Set([sessionA.id, sessionB.id]);
  await page.keyboard.press('Control+n');
  await expectCreated({ ...projectA, name: '菜单改名验收' }, beforeShortcut);
  checks.push('顶部 Ctrl+N 新建入口仍可用，继承当前所选项目');
  await page.screenshot({ path: path.join(root, 'project-session-created.png') });
  console.log(JSON.stringify({ passed: true, checks, artifactRoot: root }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ passed: false, checks, artifactRoot: root, error: String(error?.stack || error) }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
}

import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';

const phase = process.env.UI_REDESIGN_PHASE === 'before' ? 'before' : 'after';
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-ui-redesign-'));
const repo = path.join(root, '样本项目');
const data = path.join(root, 'data');
const screenshots = path.resolve('docs/UI改造/screenshots');
await mkdir(repo);
await mkdir(screenshots, { recursive: true });
const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
git(['init', '-b', 'main']);
git(['config', 'user.name', '精工界面验收']);
git(['config', 'user.email', 'ui-test@example.invalid']);
await writeFile(path.join(repo, 'README.md'), '# 隔离 UI 验收项目\n');
git(['add', '.']);
git(['commit', '-m', '创建 UI 验收项目']);

let app;
try {
  const env = { ...process.env, JINGGONG_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await expect(page.locator('.runtime-summary')).toBeVisible({ timeout: 30000 });
  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
  }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  await expect(page.locator('.project-item')).toBeVisible();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('新建会话项目', { exact: true }).selectOption({ label: '样本项目' });
  await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入任务' })).toBeVisible();

  for (const [width, height] of [[1600, 900], [1366, 768]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await expect(page.locator('.inspector-tabs')).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width,
      workspace: document.querySelector('.workspace')?.getBoundingClientRect().width,
      inspector: document.querySelector('.inspector')?.getBoundingClientRect().width,
      theme: document.documentElement.dataset.theme,
      style: document.documentElement.dataset.style
    }));
    if (layout.documentWidth > layout.viewportWidth) throw new Error(`整体横向溢出：${JSON.stringify(layout)}`);
    await page.screenshot({ path: path.join(screenshots, `${phase}-${width}x${height}.png`) });
    console.log(`${phase} ${width}x${height}: ${JSON.stringify(layout)}`);
  }
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}

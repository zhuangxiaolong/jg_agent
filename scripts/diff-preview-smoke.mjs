import assert from 'node:assert/strict';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const expect = baseExpect.configure({ timeout: 30000 });

// 只在临时仓库和独立数据目录中验收真实 Git/桌面交互，不配置模型或访问用户项目。
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-diff-preview-')));
const repo = path.join(root, '差异预览样本 空格');
const dataRoot = path.join(root, 'data');
const checks = [];
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'disabled-hooks')}`, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
}
const bootstrap = () => page.evaluate(() => window.jinggong.bootstrap());
const preview = () => page.locator('#diff-panel .diff-preview');
const body = () => page.locator('#diff-panel pre[aria-label="文件代码差异"]');
const expand = () => page.getByRole('button', { name: '展开文件代码差异', exact: true });
const collapse = () => page.getByRole('button', { name: '收起文件代码差异', exact: true });
const handle = () => page.getByRole('separator', { name: '调整代码差异高度', exact: true });
const file = filename => page.locator('#diff-panel .diff-file-row').filter({ hasText: filename });

async function refreshDiff() {
  const button = page.getByRole('button', { name: '刷新代码差异', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toBeEnabled();
}
async function openDiff() {
  await page.getByRole('button', { name: /^Git/ }).click();
  await expect(page.locator('#diff-panel')).toBeVisible();
}
async function expectCollapsed() {
  await expect(preview()).toBeVisible();
  await expect(expand()).toBeVisible();
  await expect(expand()).toHaveAttribute('aria-expanded', 'false');
  await expect(body()).toBeHidden();
  await expect(handle()).toBeHidden();
}
async function expectExpanded() {
  await expect(collapse()).toBeVisible();
  await expect(collapse()).toHaveAttribute('aria-expanded', 'true');
  await expect(body()).toBeVisible();
  await expect(handle()).toBeVisible();
}
async function height() {
  return Number(await handle().getAttribute('aria-valuenow'));
}
async function bounds() {
  return { min: Number(await handle().getAttribute('aria-valuemin')), max: Number(await handle().getAttribute('aria-valuemax')) };
}
async function drag(dy) {
  const box = await handle().boundingBox();
  assert.ok(box, '差异高度手柄必须有可拖动区域');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.body.dataset.resizing ?? '')).toBe('');
}
async function assertUsableLayout() {
  const metrics = await page.locator('#diff-panel.diff-content').evaluate(container => {
    const tree = container.querySelector('.file-list');
    const preview = container.querySelector('.diff-preview');
    const view = container.querySelector('.diff-view');
    const box = element => element?.getBoundingClientRect().toJSON();
    return { container: box(container), tree: box(tree), preview: box(preview), view: box(view), width: innerWidth, documentWidth: document.documentElement.scrollWidth, containerHeight: container.clientHeight, viewHeight: view?.clientHeight, scrollHeight: view?.scrollHeight };
  });
  assert.ok(metrics.tree && metrics.preview && metrics.view, JSON.stringify(metrics));
  assert.ok(metrics.tree.height >= 60, `最大差异高度仍需保留文件树：${JSON.stringify(metrics)}`);
  assert.ok(metrics.viewHeight > 35, `差异正文仍需有可用高度：${JSON.stringify(metrics)}`);
  assert.ok(metrics.preview.y >= metrics.container.y - 1 && metrics.preview.bottom <= metrics.container.bottom + 1, `详情不能越出面板：${JSON.stringify(metrics)}`);
  assert.ok(metrics.documentWidth <= metrics.width + 1, `页面不能横向溢出：${JSON.stringify(metrics)}`);
  const limits = await bounds();
  assert.equal(limits.max, Math.max(0, Math.floor(metrics.containerHeight - 80)), '最大高度应按容器预留文件树空间');
  assert.equal(limits.min, Math.min(160, limits.max));
  assert.ok(await height() >= limits.min && await height() <= limits.max);
  return metrics;
}
async function setSize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
}
async function report(passed, extra = {}) {
  const result = { passed, date: new Date().toISOString(), checks, executable: process.env.JINGGONG_TEST_EXE || '开发 Electron', scope: '临时本地仓库与隔离数据；未连接用户项目、模型或远程 Git 服务', ...extra };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/diff-preview-smoke.json', JSON.stringify(result, null, 2));
  await writeFile('test-results/diff-preview-smoke.md', `# Git 差异预览交互测试\n\n- 结果：${passed ? '通过' : '失败'}\n- 时间：${result.date}\n- 执行程序：${result.executable}\n- 范围：${result.scope}\n\n${checks.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n${extra.error ? `\n失败原因：${extra.error}\n` : ''}`);
  return result;
}

try {
  await mkdir('test-results', { recursive: true });
  await mkdir(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, 'README.md'), '# 差异预览基线\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=差异预览测试', '-c', 'user.email=diff-preview@example.invalid', 'commit', '-m', '创建差异预览测试基线']);
  const initialHead = git(repo, ['rev-parse', 'HEAD']);
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env, cwd: process.cwd() });
  page = await app.firstWindow();
  await expect(page.locator('.brand strong')).toHaveText('精工Agent');
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  assert.equal((await bootstrap()).settings.providers.length, 0);
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, repo);
  const project = await page.evaluate(() => window.jinggong.selectProject());
  assert.ok(project);
  const sessions = [];
  for (const name of ['差异预览会话一', '差异预览会话二']) {
    const session = await page.evaluate(id => window.jinggong.createSession({ projectId: id }), project.id);
    await page.evaluate(({ id, name }) => window.jinggong.renameSession(id, name), { id: session.id, name });
    await writeFile(path.join(session.workspacePath, 'README.md'), `# 差异预览基线\n${name}的真实差异\n${Array.from({ length: 120 }, (_, index) => `差异正文第 ${index + 1} 行`).join('\n')}\n`);
    await writeFile(path.join(session.workspacePath, '另一个文件.txt'), `${name}的第二个差异文件\n`);
    for (let index = 0; index < 20; index += 1) await writeFile(path.join(session.workspacePath, `树列表样本${String(index).padStart(2, '0')}.txt`), `文件树滚动样本 ${index}\n`);
    sessions.push({ ...session, name });
  }
  await page.evaluate(id => window.jinggong.setProjectCollapsed(id, false), project.id);
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(sessions[1].name) })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(sessions[1].name) }).click();
  await setSize(1440, 900);
  await openDiff();
  await expect(file('README.md')).toBeVisible();
  await expectCollapsed();
  await page.screenshot({ path: 'test-results/diff-preview-collapsed.png' });
  checks.push('初次打开代码变更时详情默认收起，标题可展开，文件树可用');

  const initiallySelected = await page.locator('#diff-panel .diff-file-row.selected .diff-tree-name').textContent();
  assert.ok(initiallySelected, '默认选择的文件应有名称');
  await expand().click();
  await expectExpanded();
  await expect(preview()).toContainText(initiallySelected);
  assert.equal(await height(), 320);
  await file('README.md').click();
  await expect(preview()).toContainText('README.md');
  await expect(body()).toContainText('差异预览会话二的真实差异');
  await collapse().click();
  await expectCollapsed();
  await refreshDiff();
  await expectCollapsed();
  checks.push('标题展开/收起及 aria-expanded 正确，刷新差异保持收起状态');

  await file('另一个文件.txt').click();
  await expectExpanded();
  await expect(preview()).toContainText('另一个文件.txt');
  await expect(body()).toContainText('差异预览会话二的第二个差异文件');
  await collapse().click();
  await file('README.md').click({ button: 'right' });
  await expectCollapsed();
  await page.getByRole('menuitem', { name: '查看对比', exact: true }).click();
  await expectExpanded();
  await expect(preview()).toContainText('README.md');
  await expect(body()).toContainText('差异预览会话二的真实差异');
  checks.push('点击文件自动展开对应差异；右键仅选中文件，“查看对比”再展开');

  const startHeight = await height();
  await drag(-55);
  assert.ok(await height() >= startHeight + 50, '上拖应增大差异高度');
  await drag(35);
  assert.ok(await height() <= startHeight + 25, '下拖应缩小差异高度');
  await handle().dblclick();
  await expect.poll(height).toBe(320);
  await handle().focus();
  await page.keyboard.press('ArrowUp');
  assert.ok(await height() > 320, '向上键应增大差异高度');
  await page.keyboard.press('ArrowDown');
  assert.equal(await height(), 320, '向下键应恢复前一个高度');
  await page.keyboard.press('End');
  assert.equal(await height(), (await bounds()).max);
  await assertUsableLayout();
  await page.keyboard.press('Home');
  assert.equal(await height(), 320);
  await drag(-2000);
  assert.equal(await height(), (await bounds()).max);
  await assertUsableLayout();
  await drag(2000);
  assert.equal(await height(), (await bounds()).min);
  await assertUsableLayout();
  await handle().dblclick();
  assert.equal(await height(), 320);
  checks.push('真实鼠标上/下拖动、上下限、双击恢复及方向键/Home/End 正常，最大高度保留文件树');

  const activeDragBox = await handle().boundingBox();
  assert.ok(activeDragBox);
  await page.mouse.move(activeDragBox.x + activeDragBox.width / 2, activeDragBox.y + activeDragBox.height / 2);
  await page.mouse.down();
  await collapse().focus();
  await page.keyboard.press('Enter');
  await expectCollapsed();
  await expect.poll(() => page.evaluate(() => document.body.dataset.resizing ?? '')).toBe('');
  await page.mouse.up();
  await expand().click();
  await expectExpanded();
  checks.push('拖动过程中用键盘收起详情会清理全局拖动状态，重新展开后仍可正常操作');

  for (const [width, height] of [[1366, 768], [1600, 900], [1000, 700]]) {
    await setSize(width, height);
    await expectExpanded();
    await handle().focus();
    await page.keyboard.press('End');
    await assertUsableLayout();
    await page.screenshot({ path: `test-results/diff-preview-expanded-${width}x${height}.png` });
  }
  await setSize(1440, 900);
  await handle().dblclick();
  await expect.poll(height).toBe(320);
  await page.screenshot({ path: 'test-results/diff-preview-expanded.png' });
  checks.push('1366×768、1600×900、1000×700 窗口中高度边界随容器变化，详情/文件树可用且页面无横向溢出');

  await page.reload();
  await openDiff();
  await expectCollapsed();
  await file('README.md').click();
  await expectExpanded();
  await expect(body()).toContainText('差异预览会话二的真实差异');
  await drag(-60);
  assert.notEqual(await height(), 320);
  await page.reload();
  await openDiff();
  await expectCollapsed();
  await file('README.md').click();
  await expectExpanded();
  assert.equal(await height(), 320);
  checks.push('直接项目会话内容来自共享项目目录；刷新页面不记忆展开状态或临时调整高度');

  const selectedName = await page.locator('.session-item.selected .session-name').textContent();
  const selectedSession = sessions.find(item => item.name === selectedName);
  assert.ok(selectedSession);
  git(selectedSession.workspacePath, ['restore', '--', 'README.md']);
  for (const filename of ['另一个文件.txt', ...Array.from({ length: 20 }, (_, index) => `树列表样本${String(index).padStart(2, '0')}.txt`)]) await rm(path.join(selectedSession.workspacePath, filename));
  await refreshDiff();
  await expect(preview()).toHaveCount(0);
  await expect(page.locator('#diff-panel')).toContainText('项目目录暂无变更');
  assert.equal(git(repo, ['rev-parse', 'HEAD']), initialHead);
  assert.equal(git(repo, ['status', '--porcelain']), '');
  assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), '# 差异预览基线\n');
  checks.push('清空差异后移除详情且显示空态；原项目 HEAD 与文件未被会话差异操作修改');
  console.log(JSON.stringify(await report(true), null, 2));
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await page?.screenshot({ path: 'test-results/diff-preview-failure.png' }).catch(() => undefined);
  await report(false, { error: error instanceof Error ? error.message : String(error), testData: root });
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

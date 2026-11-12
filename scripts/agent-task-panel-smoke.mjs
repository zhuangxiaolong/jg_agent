import assert from 'node:assert/strict';
import { _electron as electron, expect as baseExpect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 Electron/SQLite/Git 会话切换回归；不读取实际项目，不调用模型。
const expect = baseExpect.configure({ timeout: 30000 });
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-agent-panel-')));
const repo = path.join(root, '会话隔离样本');
await mkdir(repo);
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
git(['init', '-b', 'main']);
await writeFile(path.join(repo, 'README.md'), '# 子 Agent 面板会话隔离回归\n');
git(['add', '.']);
git(['-c', 'user.name=会话隔离回归', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', '建立临时回归样本']);
const env = { ...process.env, JINGGONG_TEST_DATA: path.join(root, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const checks = [];
try {
  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
  const page = await app.firstWindow();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  await expect(page.locator('.project-item')).toHaveCount(1);
  await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.locator('.session-item')).toHaveCount(1);
  const initial = (await page.evaluate(() => window.jinggong.bootstrap())).sessions[0];
  await page.evaluate(id => window.jinggong.renameSession(id, '历史任务会话'), initial.id);
  // 通过原有 API 建立历史任务样本，确认面板仍能检查已有契约与失败原因。
  const task = await page.evaluate(sessionId => window.jinggong.createAgentTask({ sessionId, name: '历史任务隔离样本', role: 'review', description: '仅验证面板在新建会话后不会查询旧任务', outputExpectations: ['检查历史事件'], acceptanceCriteria: ['新会话不出现旧任务'] }), initial.id);
  await page.locator('#agents-panel-tab').click();
  await page.getByRole('button', { name: '刷新子任务', exact: true }).click();
  await expect(page.locator('.agent-task-row')).toContainText(task.name);
  await expect(page.locator('.agent-task-form')).toHaveCount(0);
  await expect(page.locator('#agents-panel')).toContainText('自动子 Agent 暂不可用');
  checks.push('展示已有任务和真实能力限制，移除手工新建表单');
  await page.evaluate(() => {
    window.__agentPanelErrors = [];
    const observer = new MutationObserver(() => {
      for (const element of document.querySelectorAll('[role="alert"]')) if (element.textContent) window.__agentPanelErrors.push(element.textContent);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  for (let index = 0; index < 3; index++) {
    await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
    await expect(page.locator('.session-item')).toHaveCount(index + 2);
    await expect(page.locator('.agent-task-row')).toHaveCount(0);
    await page.getByRole('button', { name: '刷新子任务', exact: true }).click();
    await expect(page.getByRole('button', { name: '刷新子任务', exact: true })).toBeEnabled();
    await page.waitForTimeout(250);
    const errors = await page.evaluate(() => window.__agentPanelErrors);
    assert.equal(errors.some(value => value.includes('子 Agent 任务不存在')), false, errors.join('\n'));
    if (index < 2) {
      await page.locator('.session-item').filter({ hasText: '历史任务会话' }).click();
      await expect(page.locator('.agent-task-row')).toContainText(task.name);
    }
  }
  checks.push('历史任务会话与三个新会话交替切换，未出现旧任务或“子 Agent 任务不存在”');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/agent-task-panel.png', fullPage: true });
  await writeFile('test-results/agent-task-panel.json', JSON.stringify({ checkedAt: new Date().toISOString(), checks, modelExecution: '未执行' }, null, 2));
  console.log(JSON.stringify({ checks, passed: checks.length }, null, 2));
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

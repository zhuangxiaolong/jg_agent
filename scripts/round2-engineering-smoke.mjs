import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 Electron/Git/SQLite 工程集成检查；未调用模型，也不是 MES/WMS 业务验收。
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'jinggong-round2-')));
const repo = path.join(root, '隔离工程样本');
const data = path.join(root, 'data');
const output = path.resolve('docs/jinggong_agent_round2/screenshots');
await mkdir(repo); await mkdir(output, { recursive: true });
const git = (cwd, args) => execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
git(repo, ['init', '-b', 'main']);
git(repo, ['config', 'user.name', '工程集成检查']);
git(repo, ['config', 'user.email', 'round2@example.invalid']);
await writeFile(path.join(repo, 'README.md'), '# 临时工程样本\n\n仅用于桌面工程能力检查，不代表业务功能验收。\n');
git(repo, ['add', '.']); git(repo, ['commit', '-m', '创建临时工程检查样本']);
const checks = [];
let app;
async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await expect(page.locator('.runtime-summary')).toBeVisible({ timeout: 30000 });
  return page;
}
try {
  let page = await launch();
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  await expect(page.locator('.project-item')).toBeVisible();
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('新建会话项目', { exact: true }).selectOption({ label: '隔离工程样本' });
  await dialog.getByLabel('新建会话模式', { exact: true }).selectOption('develop');
  await dialog.getByLabel('新建会话 Runtime', { exact: true }).selectOption('codex');
  await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入任务' })).toBeVisible();
  const boot = await page.evaluate(() => window.jinggong.bootstrap());
  const session = boot.sessions[0];
  assert.equal(session.mode, 'develop');
  const parentHead = git(session.workspacePath, ['rev-parse', 'HEAD']);
  await page.locator('#agents-panel-tab').click();
  const form = page.locator('form.agent-task-form');
  await form.getByLabel('任务名称', { exact: true }).fill('检查契约与真实证据边界');
  await form.getByLabel('任务描述', { exact: true }).fill('检查临时工程目录和证据关联条件，列出不能自动确认的事项。');
  await form.getByLabel('期望交付（每行一项）', { exact: true }).fill('输出代码位置和待确认清单');
  await form.getByLabel('验收标准（每行一项）', { exact: true }).fill('每条结论有可核对的代码引用\n未执行的测试必须明确说明');
  await form.getByRole('button', { name: '创建只读任务', exact: true }).click();
  await expect(page.locator('.agent-task-row').first()).toContainText('已阻塞');
  let task = (await page.evaluate(id => window.jinggong.listAgentTasks(id), session.id))[0];
  assert.equal(task.executionStatus, 'BLOCKED'); assert.equal(task.attempt, 0);
  let detail = await page.evaluate(({ sessionId, taskId }) => window.jinggong.taskEngineering.detail(sessionId, taskId), { sessionId: session.id, taskId: task.id });
  assert.equal(detail.contracts.length, 1);
  assert.deepEqual(detail.contracts[0].contract.acceptanceCriteria, ['每条结论有可核对的代码引用', '未执行的测试必须明确说明']);
  assert.equal(detail.governance.tokenUsage, 'unknown'); assert.equal(detail.governance.costUsage, 'unknown');
  assert.ok(detail.events.some(event => event.eventType === 'governance.blocked'));
  assert.equal(detail.events.some(event => event.eventType === 'model.turn_started'), false);
  checks.push('真实 UI 建立验收标准与契约；Codex 严格治理在消耗 attempt、读取凭据和调用模型前阻塞');
  await page.evaluate(({ sessionId, taskId, version }) => window.jinggong.taskEngineering.revise({ sessionId, taskId, expectedContractVersion: version, goal: '核对工程边界与未覆盖项', outputExpectations: ['提供审查说明与证据引用'], acceptanceCriteria: ['明确未执行的业务验收'] }), { sessionId: session.id, taskId: task.id, version: task.contractVersion });
  await page.getByRole('button', { name: '刷新子任务', exact: true }).click();
  detail = await page.evaluate(({ sessionId, taskId }) => window.jinggong.taskEngineering.detail(sessionId, taskId), { sessionId: session.id, taskId: task.id });
  assert.equal(detail.contracts.length, 2); assert.equal(detail.task.executionStatus, 'BLOCKED');
  await assert.rejects(page.evaluate(({ sessionId, taskId, state }) => window.jinggong.taskEngineering.resolveAcceptance({ sessionId, taskId, expectedStateVersion: state, decision: 'accept', comment: '没有真实验证不能验收' }), { sessionId: session.id, taskId: task.id, state: detail.task.stateVersion }), /真实通过证据/);
  checks.push('契约修改保留两版与事件，修订不能解锁治理门禁；无证据不能验收通过');

  const alternate = await page.evaluate(projectId => window.jinggong.createSession({ projectId, mode: 'read', runtimeKind: 'jinggong' }), session.projectId);
  const alternateTask = await page.evaluate(sessionId => window.jinggong.createAgentTask({ sessionId, name: '精工 Runtime 能力检查', role: 'review', description: '只检查严格能力门禁，不调用模型', outputExpectations: ['门禁原因'], acceptanceCriteria: ['能力不足时阻塞并保留契约'] }), alternate.id);
  const alternateDetail = await page.evaluate(({ sessionId, taskId }) => window.jinggong.taskEngineering.detail(sessionId, taskId), { sessionId: alternate.id, taskId: alternateTask.id });
  assert.equal(alternateDetail.task.executionStatus, 'BLOCKED'); assert.equal(alternateDetail.task.attempt, 0);
  assert.equal(alternateDetail.contracts[0].contract.runtimeKind, 'jinggong');
  checks.push('精工 Runtime 同样执行真实能力门禁；未知 Usage 不显示精确数值');

  const workspaceTask = await page.evaluate(sessionId => window.jinggong.createAgentTask({ sessionId, name: '隔离开发成果保留检查', role: 'developer', description: '在独立工作区检查人工成果保留与集成预检', workspaceMode: 'worktree', outputExpectations: ['保留独立目录与差异'], acceptanceCriteria: ['未提交成果不能集成；父分支不变化'] }), session.id);
  let workspaceDetail = await page.evaluate(({ sessionId, taskId, state }) => window.jinggong.taskEngineering.createWorkspace({ sessionId, taskId, expectedStateVersion: state }), { sessionId: session.id, taskId: workspaceTask.id, state: workspaceTask.stateVersion });
  assert.ok(workspaceDetail.workspace?.path); assert.notEqual(workspaceDetail.workspace.path, session.workspacePath);
  assert.equal(workspaceDetail.workspace.baseCommit, parentHead);
  await writeFile(path.join(workspaceDetail.workspace.path, '人工检查记录.md'), '临时检查写入：只用于证明未提交成果被保留，不属于 Agent 执行输出。\n');
  const currentWorkspaceTask = (await page.evaluate(id => window.jinggong.listAgentTasks(id), session.id)).find(item => item.id === workspaceTask.id);
  workspaceDetail = await page.evaluate(({ sessionId, taskId, state }) => window.jinggong.taskEngineering.prepareIntegration({ sessionId, taskId, expectedStateVersion: state }), { sessionId: session.id, taskId: workspaceTask.id, state: currentWorkspaceTask.stateVersion });
  assert.equal(workspaceDetail.integration.autoIntegration, false); assert.equal(workspaceDetail.integration.requiresApproval, true);
  assert.equal(workspaceDetail.integration.ready, false);
  assert.ok(workspaceDetail.integration.blockers.some(blocker => blocker.code === 'SOURCE_DIRTY'));
  assert.ok(workspaceDetail.changes.some(change => change.path === '人工检查记录.md'));
  assert.equal(git(session.workspacePath, ['rev-parse', 'HEAD']), parentHead);
  checks.push('真实 Worktree 从冻结基准创建并持久绑定；未提交成果阻断集成，实际无 merge/commit/push/cleanup');

  await page.getByRole('button', { name: '刷新子任务', exact: true }).click();
  await page.locator('.agent-task-row').filter({ hasText: '隔离开发成果保留检查' }).click();
  await expect(page.locator('.task-workspace-panel')).toBeVisible();
  await page.locator('.task-workspace-panel > summary').click();
  await expect(page.locator('.task-workspace-panel')).toContainText(workspaceDetail.workspace.path);
  await page.locator('.task-workspace-panel').getByRole('button', { name: '生成人工集成预检', exact: true }).click();
  await expect(page.locator('.task-workspace-panel')).toContainText('SOURCE_DIRTY', { timeout: 30000 });
  for (const [width, height] of [[1600, 900], [1366, 768]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.locator('.task-workspace-panel').scrollIntoViewIfNeeded();
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(dimensions.document <= dimensions.viewport, JSON.stringify(dimensions));
    await page.screenshot({ path: path.join(output, `round2-workspace-${width}x${height}.png`) });
  }
  await page.locator('.agent-task-row').filter({ hasText: '检查契约与真实证据边界' }).click();
  await page.locator('.task-engineering summary').filter({ hasText: 'Runtime 能力、预算与恢复' }).click();
  await page.locator('.task-engineering').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'round2-governance-1366x768.png') });
  checks.push('1600×900 与1366×768 实际 Electron 页面截图；页面无整体横向溢出');

  await app.close(); app = undefined;
  page = await launch();
  const restored = await page.evaluate(id => window.jinggong.listAgentTasks(id), session.id);
  assert.equal(restored.find(item => item.id === task.id).executionStatus, 'BLOCKED');
  assert.equal(restored.find(item => item.id === task.id).attempt, 0);
  const retained = await page.evaluate(({ sessionId, taskId }) => window.jinggong.taskEngineering.workspace(sessionId, taskId), { sessionId: session.id, taskId: workspaceTask.id });
  assert.equal(retained.workspace.path, workspaceDetail.workspace.path);
  assert.match(await readFile(path.join(retained.workspace.path, '人工检查记录.md'), 'utf8'), /临时检查写入/);
  checks.push('真实应用关闭再启动后，契约门禁与 Worktree 映射/未提交文件完整保留，未自动重试');
  const result = { checkedAt: new Date().toISOString(), passed: checks.length, checks, limitations: ['未调用真实模型', '未执行非生产 MES/WMS 业务任务', '原生模型请求与工具硬限额不支持，受控新任务保持门禁', '截图来自隔离工程样本，不是业务验收截图'] };
  await writeFile(path.resolve('docs/jinggong_agent_round2/阶段5-Electron工程集成结果.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close();
  // 只清理本脚本创建的临时测试目录，真实用户工作区不在此范围。
  await rm(root, { recursive: true, force: true });
}

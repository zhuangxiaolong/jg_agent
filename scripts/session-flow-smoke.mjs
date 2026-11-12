import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import initSqlJs from 'sql.js';

// 仅使用临时数据与合成 Git 仓库；不配置凭据，不访问真实 Jira 或模型。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-flow-'));
const dataRoot = path.join(root, 'data');
const checks = [];
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
const require = createRequire(import.meta.url);
let app;
let page;
async function launch() {
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env, cwd: process.cwd() });
  page = await app.firstWindow();
  await expect(page.locator('.brand strong')).toHaveText('精工Agent', { timeout: 30000 });
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
}
async function fixture(name) {
  const repo = path.join(root, name); await mkdir(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  git(['init', '-b', 'main']);
  await writeFile(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(['add', '.']); git(['-c', 'user.name=会话流程验收', '-c', 'user.email=test@example.invalid', 'commit', '-m', '建立会话流程测试']);
  git(['branch', 'feature']);
  return repo;
}
async function updateOfflineSession(id, update) {
  const filename = path.join(dataRoot, 'database', 'jinggong-agent.db');
  const SQL = await initSqlJs({ locateFile: name => require.resolve(`sql.js/dist/${name}`) });
  const db = new SQL.Database(await readFile(filename));
  try {
    const row = db.exec('SELECT value FROM sessions WHERE id = ?', [id])[0]?.values[0]?.[0];
    assert.equal(typeof row, 'string');
    db.run('UPDATE sessions SET value = ? WHERE id = ?', [JSON.stringify(update(JSON.parse(row))), id]);
    await writeFile(filename, db.export());
  } finally { db.close(); }
}
function offlineJira() {
  const now = new Date().toISOString();
  return {
    jiraIssue: { id: 'fixture-1', key: 'TEST-1', summary: '离线合成 Jira 任务标题不应占据会话顶部', description: '用于验证需求提示不阻断会话，不访问真实 Jira。', status: 'Open', issueType: 'Story', url: 'https://jira.example.invalid/browse/TEST-1', fetchedAt: now, attachments: [] },
    requirementAdmission: { id: randomUUID(), status: 'blocked', implementationAllowed: false, projectGeneration: 'unknown', taskType: 'ui', snapshotHash: 'a'.repeat(64), templateVersion: 'fixture', ruleVersion: 'fixture', checkedAt: now,
      items: [{ id: randomUUID(), itemKey: 'fixture-rule', title: '离线待确认事项', status: 'missing', riskLevel: 'high', blockingStage: 'implementation', overrideAllowed: false, finding: '此项只作测试提示', evidence: [], updatedAt: now }],
      resolutions: [], acceptanceCriteria: [], stageBlockers: ['implementation'] },
  };
}
const picker = () => page.getByLabel('当前会话本地项目', { exact: true });
const branchPicker = () => page.getByLabel('当前会话基准分支', { exact: true });
const bootstrap = () => page.evaluate(() => window.jinggong.bootstrap());
async function currentSession(id) { return (await bootstrap()).sessions.find(session => session.id === id); }
async function waitForBinding(id, projectId) {
  await expect.poll(async () => (await currentSession(id))?.projectId || '', { timeout: 30000 }).toBe(projectId || '');
  await expect(picker()).toHaveValue(projectId || '');
  await expect(picker()).toBeEnabled({ timeout: 30000 });
}
async function inspectLayout(width, height) {
  await page.setViewportSize({ width, height });
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeVisible();
  const result = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell');
    const textarea = document.querySelector('.composer textarea').getBoundingClientRect();
    const send = document.querySelector('.send-button').getBoundingClientRect();
    const requirement = document.querySelector('.requirement-admission').getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, shellWidth: shell.scrollWidth, textarea: { x: textarea.x, y: textarea.y, right: textarea.right, bottom: textarea.bottom }, send: { x: send.x, y: send.y, right: send.right, bottom: send.bottom }, requirementHeight: requirement.height };
  });
  assert.ok(result.documentWidth <= width + 1, JSON.stringify(result));
  assert.ok(result.shellWidth <= width + 1, JSON.stringify(result));
  for (const rect of [result.textarea, result.send]) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.right <= width + 1 && rect.bottom <= height + 1, JSON.stringify(result));
  assert.ok(result.requirementHeight <= 64, JSON.stringify(result));
  const screenshot = `test-results/current-ui-${width}x${height}.png`;
  await page.screenshot({ path: screenshot });
  checks.push(`${width}×${height} 无横向溢出，输入区/发送按钮在可视区域，需求提示保持紧凑；截图 ${screenshot}`);
}

try {
  const repos = await Promise.all([fixture('项目A'), fixture('项目B')]);
  await launch();
  // 先保留未选中项目的会话，使添加项目后的重载仍可验证独立会话入口。
  await page.keyboard.press('Control+n');
  await expect(picker()).toBeVisible();
  const projects = [];
  for (const repo of repos) {
    await app.evaluate(({ dialog }, repo) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repo] }); }, repo);
    projects.push(await page.evaluate(() => window.jinggong.selectProject()));
  }
  assert.ok(projects[0] && projects[1]);
  const [projectA, projectB] = projects;
  await page.reload();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled();
  await page.keyboard.press('Control+n');
  await expect(page.getByRole('textbox', { name: '输入任务', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let session = (await bootstrap()).sessions[0];
  const id = session.id;
  assert.equal(session.projectId, undefined); assert.equal(session.workspaceId, undefined); assert.equal(Object.hasOwn(session, 'mode'), false);
  assert.equal((await bootstrap()).layout.bottomVisible, false);
  await expect(page.locator('#bottom-panel')).toBeHidden();
  const standalonePath = session.workspacePath;
  await writeFile(path.join(standalonePath, '保留的独立文件.txt'), '独立目录内容需要保留\n', 'utf8');
  checks.push('Ctrl+N 在未选中项目时直接创建独立会话，无创建弹窗/工作区关联/mode 字段；底部面板默认隐藏');
  await picker().selectOption(projectA.id);
  await expect(branchPicker()).toBeEnabled();
  await branchPicker().selectOption('feature');
  await page.getByRole('button', { name: '绑定项目', exact: true }).click();
  await waitForBinding(id, projectA.id);
  session = await currentSession(id);
  const firstProjectPath = session.workspacePath;
  assert.equal(session.baseBranch, 'feature');
  await writeFile(path.join(firstProjectPath, 'README.md'), '# 项目A的未提交修改\n', 'utf8');
  await writeFile(path.join(firstProjectPath, '未跟踪文件.txt'), '不能在换项目时删除\n', 'utf8');
  assert.equal(await readFile(path.join(standalonePath, '保留的独立文件.txt'), 'utf8'), '独立目录内容需要保留\n');
  checks.push('独立会话可绑定本地项目及选定分支，原独立目录保留');
  await app.close(); app = undefined;
  await updateOfflineSession(id, saved => ({ ...saved, runtimeThreadId: randomUUID(), runtimeNativeSessionId: 'fixture-native-session', runtimeVersion: 'fixture-runtime', runtimeCapabilitiesVersion: 2, ...offlineJira() }));
  await launch();
  await expect(picker()).toHaveValue(projectA.id);
  await expect(picker()).toBeEnabled();
  await picker().selectOption(projectB.id);
  await expect(branchPicker()).toBeEnabled();
  await page.getByRole('button', { name: '切换项目', exact: true }).click();
  await waitForBinding(id, projectB.id);
  session = await currentSession(id);
  const secondProjectPath = session.workspacePath;
  assert.notEqual(secondProjectPath, firstProjectPath);
  assert.equal(await readFile(path.join(firstProjectPath, 'README.md'), 'utf8'), '# 项目A的未提交修改\n');
  assert.equal(await readFile(path.join(firstProjectPath, '未跟踪文件.txt'), 'utf8'), '不能在换项目时删除\n');
  for (const key of ['runtimeThreadId', 'runtimeNativeSessionId', 'runtimeVersion', 'runtimeCapabilitiesVersion']) assert.equal(session[key], undefined);
  assert.equal((await page.evaluate(id => window.jinggong.getEvents(id), id)).some(event => event.text.includes(firstProjectPath) && event.text.includes('原目录已保留')), true);
  checks.push('已绑定会话可切换另一本地项目，原脏 Worktree/未跟踪文件保留，Runtime 元数据清空并记录恢复路径');
  await writeFile(path.join(secondProjectPath, '项目B保留文件.txt'), '项目B的文件同样保留\n', 'utf8');
  await picker().selectOption('');
  await waitForBinding(id, undefined);
  session = await currentSession(id);
  assert.equal(await realpath(session.workspacePath), await realpath(standalonePath)); assert.equal(session.branch, undefined); assert.equal(session.baseBranch, undefined);
  assert.equal(await readFile(path.join(standalonePath, '保留的独立文件.txt'), 'utf8'), '独立目录内容需要保留\n');
  assert.equal(await readFile(path.join(secondProjectPath, '项目B保留文件.txt'), 'utf8'), '项目B的文件同样保留\n');
  await expect(branchPicker()).toHaveCount(0);
  await expect(page.getByRole('button', { name: '解除关联', exact: true })).toHaveCount(0);
  checks.push('选择不关联项目后自动解除绑定并恢复原独立目录，旧项目文件保留且分支字段清空');
  await page.reload();
  await waitForBinding(id, undefined);
  assert.equal((await currentSession(id)).workspacePath, session.workspacePath);
  await expect(page.locator('.standalone-sessions .session-item.selected')).toHaveCount(1);
  checks.push('自动解除后刷新页面仍为独立会话，项目绑定与独立目录持久化保持');
  await picker().selectOption(projectA.id);
  await expect(branchPicker()).toBeEnabled();
  await page.getByRole('button', { name: '绑定项目', exact: true }).click();
  await waitForBinding(id, projectA.id);
  session = await currentSession(id);
  assert.notEqual(session.workspacePath, firstProjectPath); assert.ok((await stat(firstProjectPath)).isDirectory());
  assert.equal(Object.hasOwn(session, 'mode'), false);
  checks.push('再次绑定同一项目创建新 Worktree，不与保留目录/分支冲突，新会话仍无 mode 字段');
  const admission = page.locator('.requirement-admission');
  await expect(admission).toBeVisible();
  assert.equal(await admission.locator('details').evaluate(element => element.open), false);
  await expect(admission).toContainText('不阻断开发');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeVisible();
  await expect(page.locator('.session-jira-link, .session-runtime-banner, .runtime-summary')).toHaveCount(0);
  await expect(page.locator('.workspace-header .session-runtime-picker')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全局设置', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /一键执行|添加本地项目/ })).toHaveCount(0);
  assert.equal(await page.locator('.sidebar').innerText().then(text => /Runtime|只读|工作区/.test(text)), false);
  assert.equal(await page.locator('.workspace-header').innerText().then(text => /只读|全局设置/.test(text)), false);
  checks.push('准入提示默认折叠且发送按钮可见；无顶部 Jira 摘要/Runtime 状态/只读标签/重复设置/Jira 添加本地项目与一键执行');
  await mkdir('test-results', { recursive: true });
  await inspectLayout(1366, 768);
  await inspectLayout(1600, 900);
  const task = await page.evaluate(id => window.jinggong.createAgentTask({ sessionId: id, name: '绑定保护验收', role: 'requirement', description: '用于验证已有子任务后绑定保持不变', outputExpectations: ['记录绑定保持不变'], acceptanceCriteria: ['不能跨项目重绑'], maxAttempts: 1 }), id);
  await page.waitForFunction(async ({ id, taskId }) => !(await window.jinggong.listAgentTasks(id)).some(item => item.id === taskId && ['PENDING', 'RUNNING', 'WAITING'].includes(item.status)), { id, taskId: task.id });
  await assert.rejects(() => page.evaluate(id => window.jinggong.bindSessionProject(id, ''), id), /已有子 Agent 任务/);
  await picker().selectOption('');
  await expect(page.getByRole('alert')).toContainText('已有子 Agent 任务');
  await expect(picker()).toBeEnabled();
  await expect(picker()).toHaveValue(projectA.id);
  assert.equal((await currentSession(id)).workspacePath, session.workspacePath);
  checks.push('会话已有子 Agent 任务时拒绝自动解除并显示原项目，原目录与任务依赖保持不变');
  const report = { date: new Date().toISOString(), passed: true, checks, executable: process.env.JINGGONG_TEST_EXE || '开发 Electron', testData: root, firstProjectPath, secondProjectPath, currentPath: session.workspacePath };
  await writeFile('test-results/session-flow-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await mkdir('test-results', { recursive: true });
  await page?.screenshot({ path: 'test-results/current-ui-failure.png' }).catch(() => undefined);
  await writeFile('test-results/session-flow-smoke.json', JSON.stringify({ date: new Date().toISOString(), passed: false, checks, testData: root, error: error.message }, null, 2));
  throw error;
} finally { await app?.close(); }

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { GitConnector } from '../packages/git-connector/src';
import { TaskWorkspaceCreationError, TaskWorkspaceManager, type TaskWorkspaceRecord, type TaskWorkspaceRepository } from '../packages/git-connector/src/task-workspace';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '--all']);
  await git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function fixture(repository?: TaskWorkspaceRepository) {
  const root = await mkdtemp(join(tmpdir(), '精工任务 Worktree '));
  const repo = join(root, '中文 项目');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', '精工测试']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(repo, 'source.txt'), '原始内容\n');
  await writeFile(join(repo, 'delete.txt'), '待删除内容\n');
  const mainHead = await commit(repo, '建立主分支基线');
  const connector = new GitConnector(join(root, '受管 工作区'));
  const project = await connector.register(repo);
  const parent = await connector.createWorkspace(project, 'parent-session');
  await writeFile(join(parent.path, 'parent-only.txt'), '仅父会话提交\n');
  const base = await commit(parent.path, '建立父会话基线');
  const parentSession = { id: 'parent-session', projectId: project.id, workspacePath: parent.path, branch: parent.branch };
  const manager = new TaskWorkspaceManager(connector, repository);
  return { root, repo, connector, project, parent, parentSession, manager, base, mainHead };
}

test('任务从父会话受管分支创建真实独立Worktree，128位ID稳定缩短并保留映射', async () => {
  const records = new Map<string, TaskWorkspaceRecord>();
  const setup = await fixture({ get: id => records.get(id), save: record => { records.set(record.taskId, record); } });
  try {
    const taskId = 't'.repeat(128);
    const first = await setup.manager.create({ taskId, project: setup.project, parentSession: setup.parentSession });
    const second = await setup.manager.create({ taskId: 'another-task', project: setup.project, parentSession: setup.parentSession });
    assert.equal(first.baseCommit, setup.base);
    assert.equal(first.baseBranch, setup.parent.branch);
    assert.match(basename(first.path), /^task-[a-f0-9]{32}$/);
    assert.notEqual(first.path, second.path);
    assert.notEqual(first.branch, second.branch);
    assert.equal(await readFile(join(first.path, 'parent-only.txt'), 'utf8'), '仅父会话提交\n');
    assert.equal(first.retained, true);
    const restarted = new TaskWorkspaceManager(setup.connector, { get: id => records.get(id), save: record => { records.set(record.taskId, record); } });
    assert.deepEqual(await restarted.create({ taskId, project: setup.project, parentSession: setup.parentSession }), first);
    assert.equal(await git(setup.repo, ['rev-parse', 'main']), setup.mainHead);
    assert.equal(await git(setup.parent.path, ['rev-parse', 'HEAD']), setup.base);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('源任务干净且有独立提交仍显示基准以来成果，预检不会执行集成或改变refs/index/文件', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'committed', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'source.txt'), '真实子任务成果\n');
    const sourceHead = await commit(record.path, '提交子任务成果');
    assert.deepEqual(await setup.connector.diff(record.path), []);
    const before = await git(setup.repo, ['show-ref']);
    const inspected = await setup.manager.inspect(record);
    assert.equal(inspected.metadata.dirty, false);
    assert.equal(inspected.changes.changes[0].layer, 'committed');
    assert.match(inspected.changes.changes[0].diff, /真实子任务成果/);
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert.equal(plan.ready, true, JSON.stringify(plan.blockers));
    assert.equal(plan.requiresApproval, true);
    assert.equal(plan.autoIntegration, false);
    assert.equal(plan.source.head, sourceHead);
    assert.equal(plan.target.head, setup.base);
    assert.match(plan.source.fingerprint!, /^[a-f0-9]{64}$/);
    assert.match(plan.target.fingerprint!, /^[a-f0-9]{64}$/);
    assert.match(plan.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    assert.equal(await git(setup.repo, ['show-ref']), before);
    assert.equal(await git(setup.parent.path, ['diff', '--cached']), '');
    assert.equal(await readFile(join(setup.parent.path, 'source.txt'), 'utf8'), '原始内容\n');
    assert.equal(await git(setup.repo, ['rev-parse', 'main']), setup.mainHead);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('inspect分别展示已提交、暂存、未暂存与未跟踪真实diff；未提交源只允许查看', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'all-layers', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'source.txt'), '已提交成果\n');
    await commit(record.path, '提交第一步');
    await writeFile(join(record.path, 'source.txt'), '已暂存成果\n');
    await git(record.path, ['add', '--', 'source.txt']);
    await writeFile(join(record.path, 'source.txt'), '尚未暂存成果\n');
    await writeFile(join(record.path, 'new.txt'), '未跟踪成果\n');
    const inspected = await setup.manager.inspect(record);
    assert.deepEqual(new Set(inspected.changes.changes.map(change => change.layer)), new Set(['committed', 'staged', 'unstaged', 'untracked']));
    for (const phrase of ['已提交成果', '已暂存成果', '尚未暂存成果', '未跟踪成果']) assert(inspected.changes.changes.some(change => change.diff.includes(phrase)));
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert.equal(plan.ready, false);
    assert(plan.blockers.some(item => item.code === 'SOURCE_DIRTY'));
    assert.equal(await readFile(join(record.path, 'new.txt'), 'utf8'), '未跟踪成果\n');
    assert.equal((await setup.connector.inspectWorkspace(setup.parent.path)).dirty, false);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('父会话脏状态拒绝创建；目标未提交与基准漂移分别阻断且保留双方成果', async () => {
  const setup = await fixture();
  try {
    await writeFile(join(setup.parent.path, 'uncommitted.txt'), '父会话未提交');
    await assert.rejects(setup.manager.create({ taskId: 'dirty-parent', project: setup.project, parentSession: setup.parentSession }), /未提交/);
    await rm(join(setup.parent.path, 'uncommitted.txt'));
    const record = await setup.manager.create({ taskId: 'target-drift', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'source.txt'), '子任务修改\n');
    const sourceHead = await commit(record.path, '提交子任务修改');
    await writeFile(join(setup.parent.path, 'target-only.txt'), '目标未提交成果\n');
    const dirtyPlan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(dirtyPlan.blockers.some(item => item.code === 'TARGET_DIRTY'));
    const targetHead = await commit(setup.parent.path, '推进父会话');
    const driftPlan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert.equal(driftPlan.ready, false);
    assert(driftPlan.blockers.some(item => item.code === 'BASE_DRIFT'));
    assert.equal(driftPlan.target.head, targetHead);
    assert.equal(driftPlan.source.head, sourceHead);
    assert.equal(await git(record.path, ['rev-parse', 'HEAD']), sourceHead);
    assert.equal(await readFile(join(setup.parent.path, 'target-only.txt'), 'utf8'), '目标未提交成果\n');
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('同文件与文件/目录祖先重叠只标潜在冲突，删除和重命名原路径仍参与检查', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'overlap', project: setup.project, parentSession: setup.parentSession });
    await rename(join(record.path, 'source.txt'), join(record.path, 'renamed.txt'));
    await rm(join(record.path, 'delete.txt'));
    await writeFile(join(record.path, 'directory'), '子任务新增同名文件\n');
    await commit(record.path, '提交重命名删除和文件');
    await writeFile(join(setup.parent.path, 'source.txt'), '目标修改旧路径\n');
    await mkdir(join(setup.parent.path, 'directory'));
    await writeFile(join(setup.parent.path, 'directory', 'child.txt'), '目标新增目录内容\n');
    await commit(setup.parent.path, '提交目标重叠变更');
    const inspected = await setup.manager.inspect(record);
    assert(inspected.changes.changes.some(item => item.status === 'R' && item.previousPath === 'source.txt' && item.path === 'renamed.txt'));
    assert(inspected.changes.changes.some(item => item.status === 'D' && item.path === 'delete.txt'));
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert.equal(plan.ready, false);
    assert(plan.potentialConflictFiles.includes('source.txt'));
    assert(plan.potentialConflictFiles.includes('directory'));
    assert(plan.blockers.some(item => item.code === 'POTENTIAL_PATH_CONFLICT' && item.message.includes('尚未执行merge验证')));
    assert.equal(await readFile(join(record.path, 'directory'), 'utf8'), '子任务新增同名文件\n');
    assert.equal(await readFile(join(setup.parent.path, 'directory', 'child.txt'), 'utf8'), '目标新增目录内容\n');
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('目标被忽略的同名文件即使dirty=false也阻断，预检不读取或覆盖正文', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'ignored-file', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'incoming.txt'), '源提交新增文件\n');
    await commit(record.path, '提交新增文件');
    await writeFile(join(setup.repo, '.git', 'info', 'exclude'), 'incoming.txt\n');
    await writeFile(join(setup.parent.path, 'incoming.txt'), '必须保留的本地忽略正文\n');
    assert.equal((await setup.connector.inspectWorkspace(setup.parent.path)).dirty, false);
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert.equal(plan.ready, false);
    assert(plan.blockers.some(item => item.code === 'TARGET_PATH_RISK' && item.message.includes('被忽略')));
    assert(!JSON.stringify(plan).includes('必须保留的本地忽略正文'));
    assert.equal(await readFile(join(setup.parent.path, 'incoming.txt'), 'utf8'), '必须保留的本地忽略正文\n');
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('跨仓库、伪造映射与非祖先基准拒绝集成', async () => {
  const setup = await fixture();
  const other = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'repository-check', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'source.txt'), '源任务提交\n');
    await commit(record.path, '提交源成果');
    const otherWorkspace = await setup.connector.createWorkspace(other.project, 'other-parent');
    const cross = await setup.manager.prepareIntegration(record, { id: 'other-parent', projectId: other.project.id, workspacePath: otherWorkspace.path, branch: otherWorkspace.branch });
    assert(cross.blockers.some(item => item.code === 'REPOSITORY_MISMATCH'));
    await assert.rejects(setup.manager.inspect({ ...record, path: other.parent.path }), /映射/);
    await assert.rejects(setup.manager.inspect({ ...record, baseCommit: 'HEAD' }), /映射/);
    const tree = await git(record.path, ['rev-parse', 'HEAD^{tree}']);
    const orphan = await git(record.path, ['commit-tree', tree, '-m', '建立无父历史']);
    await git(record.path, ['update-ref', `refs/heads/${record.branch}`, orphan]);
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'BASE_NOT_ANCESTOR'));
    assert.equal(await git(record.path, ['rev-parse', 'HEAD']), orphan);
  } finally { await rm(setup.root, { recursive: true, force: true }); await rm(other.root, { recursive: true, force: true }); }
});

test('真实未解决Git冲突阻断，预检不会执行merge或清理冲突现场', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'unmerged', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'source.txt'), '源任务同一行\n');
    const sourceHead = await commit(record.path, '提交源冲突一侧');
    await writeFile(join(setup.parent.path, 'source.txt'), '父任务同一行\n');
    await commit(setup.parent.path, '提交目标冲突一侧');
    await assert.rejects(git(record.path, ['merge', '--no-edit', setup.parent.branch]));
    const conflictBefore = await git(record.path, ['ls-files', '--unmerged']);
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'SOURCE_UNMERGED'));
    assert.equal(await git(record.path, ['ls-files', '--unmerged']), conflictBefore);
    assert.equal(await git(record.path, ['rev-parse', 'HEAD']), sourceHead);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('源敏感路径不读正文，硬链接成果保留但拒绝集成', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'unsafe-files', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, '.env'), 'SYNTHETIC_VALUE=不可进入诊断正文');
    let inspected = await setup.manager.inspect(record);
    assert(inspected.changes.changes.some(item => item.path === '.env' && item.unsafeReasons.length));
    assert(!JSON.stringify(inspected).includes('不可进入诊断正文'));
    await rm(join(record.path, '.env'));
    await writeFile(join(record.path, 'source.txt'), '安全文字但外部硬链接\n');
    await commit(record.path, '提交普通文本成果');
    const external = join(setup.root, '外部原件.txt');
    await writeFile(external, '安全文字但外部硬链接\n');
    await rm(join(record.path, 'source.txt'));
    await link(external, join(record.path, 'source.txt'));
    assert.equal((await setup.connector.inspectWorkspace(record.path)).dirty, false);
    inspected = await setup.manager.inspect(record);
    assert(inspected.changes.changes.some(item => item.unsafeReasons.some(reason => reason.includes('硬链接'))));
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'SOURCE_UNSAFE_PATH'));
    assert.equal(await readFile(external, 'utf8'), '安全文字但外部硬链接\n');
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('超大真实diff显式截断并阻断，不能把部分检查当成可集成', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'large-change', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'large.txt'), Array.from({ length: 100000 }, (_, index) => `真实大文件第${index}行\n`).join(''));
    await commit(record.path, '提交大文件');
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert.equal(plan.ready, false);
    assert(plan.blockers.some(item => item.code === 'SOURCE_TRUNCATED'));
    assert.equal((await stat(join(record.path, 'large.txt'))).size > 512 * 1024, true);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('目录联接成果不能越过任务路径边界，目标联接也不能成为集成入口', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'junction-guard', project: setup.project, parentSession: setup.parentSession });
    const external = join(setup.root, '外部目录');
    await mkdir(external);
    await writeFile(join(external, 'original.txt'), '外部原件保持不变\n');
    await symlink(external, join(record.path, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
    const inspected = await setup.manager.inspect(record);
    assert(inspected.changes.changes.some(item => item.unsafeReasons.length));
    let plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'SOURCE_UNSAFE_PATH'));
    await rm(join(record.path, 'junction'));
    await mkdir(join(record.path, 'junction'));
    await writeFile(join(record.path, 'junction', 'new.txt'), '任务目录文件\n');
    await commit(record.path, '提交安全目录成果');
    await symlink(external, join(setup.parent.path, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
    plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'TARGET_PATH_RISK'));
    assert.equal(await readFile(join(external, 'original.txt'), 'utf8'), '外部原件保持不变\n');
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('创建后记录保存失败通过异常返回保留映射，不删除工作区或分支', async () => {
  let saveAttempts = 0;
  const setup = await fixture({ get: () => undefined, save: () => { saveAttempts++; throw new Error('模拟持久化失败'); } });
  try {
    let record: TaskWorkspaceRecord | undefined;
    await assert.rejects(setup.manager.create({ taskId: 'save-failed', project: setup.project, parentSession: setup.parentSession }), (error: unknown) => {
      assert(error instanceof TaskWorkspaceCreationError);
      record = error.workspace;
      assert.match(error.message, /持久化失败/);
      return true;
    });
    assert(record);
    assert.equal(record.retained, true);
    assert.equal((await stat(record.path)).isDirectory(), true);
    assert.equal(await git(record.path, ['rev-parse', 'HEAD']), setup.base);
    assert.equal(await git(setup.repo, ['rev-parse', `refs/heads/${record.branch}`]), setup.base);
    assert.equal(saveAttempts, 1);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('相同porcelain状态的正文再次变化也会改变指纹并报告检查不稳定', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'content-race', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'source.txt'), '源已提交成果\n');
    await commit(record.path, '提交源成果');
    await writeFile(join(record.path, 'source.txt'), '源脏正文第一版\n');
    const original = setup.connector.changesSince.bind(setup.connector);
    let changed = false;
    setup.connector.changesSince = async (...args) => {
      const value = await original(...args);
      if (!changed && args[0] === record.path) { changed = true; await writeFile(join(record.path, 'source.txt'), '源脏正文第二版\n'); }
      return value;
    };
    const inspected = await setup.manager.inspect(record);
    assert.equal(inspected.stable, false);
    assert(inspected.changes.changes.some(item => item.diff.includes('源脏正文第二版')));
    setup.connector.changesSince = original;
    await git(record.path, ['restore', '--', 'source.txt']);
    await writeFile(join(setup.parent.path, 'source.txt'), '目标脏正文第一版\n');
    changed = false;
    setup.connector.changesSince = async (...args) => {
      const value = await original(...args);
      if (!changed && args[0] === setup.parent.path) { changed = true; await writeFile(join(setup.parent.path, 'source.txt'), '目标脏正文第二版\n'); }
      return value;
    };
    const plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'WORKSPACE_CHANGED'));
    assert.equal(await readFile(join(setup.parent.path, 'source.txt'), 'utf8'), '目标脏正文第二版\n');
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('隐藏索引标志即使dirty=false也不能绕过源和目标预检', async () => {
  const setup = await fixture();
  try {
    const record = await setup.manager.create({ taskId: 'index-flags', project: setup.project, parentSession: setup.parentSession });
    await writeFile(join(record.path, 'source.txt'), '已提交任务成果\n');
    await commit(record.path, '提交成果');
    await git(record.path, ['update-index', '--assume-unchanged', '--', 'source.txt']);
    await writeFile(join(record.path, 'source.txt'), '源被隐藏修改\n');
    assert.equal((await setup.connector.inspectWorkspace(record.path)).dirty, false);
    let plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'SOURCE_UNSAFE_INDEX'));
    await git(record.path, ['update-index', '--no-assume-unchanged', '--', 'source.txt']);
    await git(record.path, ['restore', '--', 'source.txt']);
    await git(setup.parent.path, ['update-index', '--skip-worktree', '--', 'source.txt']);
    await writeFile(join(setup.parent.path, 'source.txt'), '目标被隐藏修改\n');
    assert.equal((await setup.connector.inspectWorkspace(setup.parent.path)).dirty, false);
    plan = await setup.manager.prepareIntegration(record, setup.parentSession);
    assert(plan.blockers.some(item => item.code === 'TARGET_UNSAFE_INDEX'));
    assert.equal(await readFile(join(setup.parent.path, 'source.txt'), 'utf8'), '目标被隐藏修改\n');
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

test('创建期间父HEAD变化后保留新工作区并报告失败，不回滚他人提交', async () => {
  const setup = await fixture();
  try {
    const original = setup.connector.createWorkspace.bind(setup.connector);
    setup.connector.createWorkspace = async (...args) => {
      const created = await original(...args);
      await writeFile(join(setup.parent.path, 'concurrent.txt'), '并发父会话成果\n');
      await commit(setup.parent.path, '模拟创建期间并发提交');
      return created;
    };
    await assert.rejects(setup.manager.create({ taskId: 'creation-race', project: setup.project, parentSession: setup.parentSession }), (error: unknown) => {
      assert(error instanceof TaskWorkspaceCreationError);
      assert.equal(error.workspace.baseCommit, setup.base);
      return true;
    });
    assert.equal(await readFile(join(setup.parent.path, 'concurrent.txt'), 'utf8'), '并发父会话成果\n');
    assert.notEqual(await git(setup.parent.path, ['rev-parse', 'HEAD']), setup.base);
    assert.equal(await git(setup.repo, ['rev-parse', 'main']), setup.mainHead);
  } finally { await rm(setup.root, { recursive: true, force: true }); }
});

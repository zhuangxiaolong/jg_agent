import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalStore } from '../packages/storage/src';
import { GitConnector } from '../packages/git-connector/src';
import { createAgentTask, createTaskContract } from '../packages/agent-orchestrator/src';
import { TaskWorkspaceService } from '../apps/desktop/src/main/task-workspaces';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '--all']); await git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}
async function fixture(t: TestContext, cleanText?: (text: string) => string) {
  const root = await mkdtemp(join(tmpdir(), '精工工作区服务 ')); const repo = join(root, '中文 项目');
  await mkdir(repo); await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', '工作区服务测试']); await git(repo, ['config', 'user.email', 'workspace@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(repo, 'source.txt'), '主分支原始内容\n'); const mainHead = await commit(repo, '建立主分支基线');
  const connector = new GitConnector(join(root, '受管 工作区')); const project = await connector.register(repo);
  const sessionId = randomUUID(); const parent = await connector.createWorkspace(project, sessionId);
  await writeFile(join(parent.path, 'parent.txt'), '仅父会话拥有的基线内容\n'); const base = await commit(parent.path, '建立父会话基线');
  const database = join(root, 'local.db'); let store = await LocalStore.open(database);
  store.saveProject(project); store.saveSession({ id: sessionId, projectId: project.id, title: '父开发会话', workspacePath: parent.path, branch: parent.branch, status: 'idle', createdAt: new Date().toISOString(), model: 'test', runtimeKind: 'codex' });
  let service = new TaskWorkspaceService(store, connector, cleanText);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const current = (taskId = 'task') => store.listAgentTasks(sessionId).find(item => item.id === taskId)!;
  const target = (taskId = 'task') => ({ sessionId, taskId, expectedStateVersion: current(taskId).stateVersion! });
  const createTask = (taskId: string, workspaceMode: 'read' | 'worktree' = 'worktree') => {
    const task = createAgentTask({ id: taskId, sessionId, projectId: project.id, name: taskId, role: 'developer', description: '工作区贯通验证', workspaceMode, runtimeKind: 'codex' });
    store.saveAgentTaskContract(task, createTaskContract(task, workspaceMode === 'worktree' ? { acceptanceCriteria: ['真实构建和测试通过'] } : {}), 0, 'local-user');
  };
  createTask('task');
  return { root, repo, project, parent, sessionId, base, mainHead, connector, current, target, createTask,
    get store() { return store; }, get service() { return service; },
    async reopen() { store.close(); store = await LocalStore.open(database); service = new TaskWorkspaceService(store, connector, cleanText); },
  };
}

test('真实工作区创建贯通SQLite，重复create幂等，重启从审计映射恢复', async t => {
  const f = await fixture(t);
  const first = await f.service.create(f.target()); const taskPath = first.workspace!.path;
  assert.notEqual(taskPath, f.parent.path); assert.notEqual(taskPath, f.repo);
  assert.equal(first.workspace!.baseCommit, f.base); assert.equal(first.workspace!.retained, true);
  assert.equal(await readFile(join(taskPath, 'parent.txt'), 'utf8'), '仅父会话拥有的基线内容\n');
  const version = f.current().stateVersion; const refs = await git(f.repo, ['show-ref']);
  const repeated = await f.service.create(f.target());
  assert.equal(repeated.workspace!.path, taskPath); assert.equal(f.current().stateVersion, version);
  assert.equal(await git(f.repo, ['show-ref']), refs);
  assert.equal(f.store.listTaskLifecycleEvents(f.sessionId, 'task').filter(event => event.eventType === 'workspace.created').length, 1);
  await f.reopen();
  assert.equal((await f.service.detail(f.sessionId, 'task')).workspace!.path, taskPath);
  assert.equal((await f.service.create(f.target())).workspace!.path, taskPath);
  assert.equal(f.current().workspacePath, taskPath);
});

test('工作区服务拒绝只读任务、跨会话范围、过期CAS和任意路径输入', async t => {
  const f = await fixture(t); f.createTask('read-task', 'read');
  await assert.rejects(f.service.create(f.target('read-task')), /隔离开发任务/);
  const otherSession = randomUUID();
  f.store.saveSession({ id: otherSession, projectId: f.project.id, title: '另一个会话', workspacePath: f.parent.path, branch: f.parent.branch, status: 'idle', createdAt: new Date().toISOString(), model: 'test' });
  await assert.rejects(f.service.create({ ...f.target(), sessionId: otherSession }), /不存在|不属于/);
  await assert.rejects(f.service.create({ ...f.target(), expectedStateVersion: 0 }), /状态已变化/);
  await assert.rejects(f.service.create({ ...f.target(), workspacePath: f.repo }));
  assert.equal(f.current().workspacePath, undefined);
  assert.equal(f.store.listTaskLifecycleEvents(f.sessionId, 'task').some(event => event.eventType === 'workspace.created'), false);
});

test('脏父会话不创建任务目录，源和目标未提交成果均阻断预检且原样保留', async t => {
  const f = await fixture(t);
  await writeFile(join(f.parent.path, 'source.txt'), '父会话未提交成果\n');
  await assert.rejects(f.service.create(f.target()), /未提交/);
  assert.equal(f.current().workspacePath, undefined);
  await git(f.parent.path, ['restore', '--', 'source.txt']);
  const taskPath = (await f.service.create(f.target())).workspace!.path;
  await writeFile(join(taskPath, 'source.txt'), '任务未提交成果\n');
  const sourceDirty = await f.service.prepareIntegration(f.target());
  assert.equal(sourceDirty.integration!.ready, false);
  assert.ok(sourceDirty.integration!.blockers.some(item => item.code === 'SOURCE_DIRTY'));
  await commit(taskPath, '提交任务成果');
  await writeFile(join(f.parent.path, 'target-only.txt'), '父会话需要保留的未提交内容\n');
  const targetDirty = await f.service.prepareIntegration(f.target());
  assert.equal(targetDirty.integration!.ready, false);
  assert.ok(targetDirty.integration!.blockers.some(item => item.code === 'TARGET_DIRTY'));
  assert.equal(await readFile(join(taskPath, 'source.txt'), 'utf8'), '任务未提交成果\n');
  assert.equal(await readFile(join(f.parent.path, 'target-only.txt'), 'utf8'), '父会话需要保留的未提交内容\n');
  assert.equal((await stat(taskPath)).isDirectory(), true);
});

test('干净源提交可生成待人工确认的集成计划，预检不执行merge或清理', async t => {
  const f = await fixture(t); const taskPath = (await f.service.create(f.target())).workspace!.path;
  await writeFile(join(taskPath, 'source.txt'), '任务已经提交的成果\n'); const sourceHead = await commit(taskPath, '提交任务成果');
  const refs = await git(f.repo, ['show-ref']); const sourceIndex = await git(taskPath, ['diff', '--cached']);
  const parentIndex = await git(f.parent.path, ['diff', '--cached']);
  const detail = await f.service.prepareIntegration(f.target());
  assert.equal(detail.integration!.ready, true, JSON.stringify(detail.integration!.blockers));
  assert.equal(detail.integration!.autoIntegration, false); assert.equal(detail.integration!.requiresApproval, true);
  assert.equal(detail.integration!.source.head, sourceHead); assert.equal(detail.integration!.target.head, f.base);
  assert.equal(await git(f.repo, ['show-ref']), refs);
  assert.equal(await git(taskPath, ['diff', '--cached']), sourceIndex); assert.equal(await git(f.parent.path, ['diff', '--cached']), parentIndex);
  assert.equal(await readFile(join(f.parent.path, 'source.txt'), 'utf8'), '主分支原始内容\n');
  assert.equal(await git(f.repo, ['rev-parse', 'main']), f.mainHead);
  assert.equal((await stat(taskPath)).isDirectory(), true);
  assert.equal(f.store.listTaskLifecycleEvents(f.sessionId, 'task').at(-1)?.eventType, 'workspace.integration_prepared');
});

test('服务真实diff输出使用脱敏callback，原始文件和Git成果不被改写', async t => {
  const sentinel = 'SYNTHETIC_SENSITIVE_DIFF_VALUE'; let calls = 0;
  const f = await fixture(t, text => { calls += 1; return text.replaceAll(sentinel, '[已脱敏]'); });
  const taskPath = (await f.service.create(f.target())).workspace!.path;
  await writeFile(join(taskPath, 'source.txt'), `${sentinel}\n`); await commit(taskPath, '提交包含合成敏感标识的样本');
  const detail = await f.service.detail(f.sessionId, 'task');
  assert.ok(calls > 0); assert.ok(detail.changes!.some(change => change.diff.includes('[已脱敏]')));
  assert.equal(JSON.stringify(detail).includes(sentinel), false);
  assert.equal(await readFile(join(taskPath, 'source.txt'), 'utf8'), `${sentinel}\n`);
  assert.ok(detail.changes!.some(change => /^[a-f0-9]{64}$/.test(change.contentHash)));
});

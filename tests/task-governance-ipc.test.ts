import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project, TaskCheckpoint, TaskPlan, TaskPlanStep } from '../packages/domain/src';
import { GitConnector } from '../packages/git-connector/src';
import { projectFingerprint, registerTaskGovernanceIpc } from '../apps/desktop/src/main/task-governance-ipc';

class MemoryStore {
  plans: TaskPlan[] = []; steps: TaskPlanStep[] = []; checkpoints: TaskCheckpoint[] = [];
  listTaskPlans(taskId?: string) { return this.plans.filter(item => taskId === undefined || item.taskId === taskId); }
  saveTaskPlan(value: TaskPlan) { this.plans = [...this.plans.filter(item => item.id !== value.id), value]; }
  listTaskPlanSteps(planId: string) { return this.steps.filter(item => item.planId === planId); }
  saveTaskPlanStep(value: TaskPlanStep) { this.steps = [...this.steps.filter(item => item.id !== value.id), value]; }
  listTaskCheckpoints(taskId: string) { return this.checkpoints.filter(item => item.taskId === taskId); }
  getTaskCheckpoint(id: string) { return this.checkpoints.find(item => item.id === id); }
  saveTaskCheckpoint(value: TaskCheckpoint) { this.checkpoints = [...this.checkpoints.filter(item => item.id !== value.id), value]; }
}

function fakeGit(paths: Array<{ path: string }>, calls: string[] = []) {
  const state = { branch: 'feature/test', commits: [{ hash: 'a'.repeat(40) }], dirty: true };
  return {
    projectState: async () => state,
    state: async (path: string) => { calls.push(path); return state; },
    files: async () => paths,
    diff: async () => [],
  } as unknown as GitConnector;
}

test('F03 指纹按原始字节覆盖二进制、删除文件和真实 Session 工作区', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-checkpoint-bytes-'));
  try {
    const workspace = join(root, 'session'); await mkdir(workspace);
    const bytes = Buffer.from([0, 1, 2, 255]); await writeFile(join(workspace, 'binary.dat'), bytes);
    const project: Project = { id: 'a'.repeat(24), name: '项目', path: root, branch: 'main' };
    const calls: string[] = [];
    const git = fakeGit([{ path: 'binary.dat' }, { path: 'removed.ts' }], calls);
    const before = await projectFingerprint(git, project, workspace);
    assert.equal(before.fileManifest.find(item => item.path === 'binary.dat')?.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(before.fileManifest.find(item => item.path === 'removed.ts')?.status, 'D');
    assert.ok(before.worktreeFingerprint);
    assert.ok(calls.every(path => path === workspace));
    await writeFile(join(workspace, 'binary.dat'), Buffer.from([0, 1, 2, 254]));
    const after = await projectFingerprint(git, project, workspace);
    assert.notEqual(after.worktreeFingerprint, before.worktreeFingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('F03 路径越界、读取不完整和采集期间分支变化不会生成可恢复指纹', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-checkpoint-invalid-'));
  try {
    const project: Project = { id: 'a'.repeat(24), name: '项目', path: root, branch: 'main' };
    const invalid = await projectFingerprint(fakeGit([{ path: '../outside' }]), project);
    assert.equal(invalid.worktreeFingerprint, undefined);
    assert.deepEqual(invalid.fileManifest, []);
    const git = fakeGit([]);
    let calls = 0;
    git.state = async () => ({ branch: ++calls === 1 ? 'first' : 'second', commits: [{ hash: 'a'.repeat(40), shortHash: 'a', author: '作者', date: '', message: '' }], dirty: false, remotes: [] });
    assert.equal((await projectFingerprint(git, project)).worktreeFingerprint, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('F03 IPC 使用真实 Runtime/资料适配结果，运行中拒绝检查点和恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-checkpoint-ipc-'));
  try {
    const project: Project = { id: 'a'.repeat(24), name: '项目', path: root, branch: 'main' };
    const store = new MemoryStore(); const handlers = new Map<string, (...args: any[]) => any>();
    let running = false; let runtimeAvailable = true;
    registerTaskGovernanceIpc({ handle: (channel, fn) => handlers.set(channel, fn), store, git: fakeGit([]), project: id => { assert.equal(id, project.id); return project; }, resolveWorkspace: async () => root, resolveRuntime: async () => ({ available: runtimeAvailable }), resolveContext: async () => ({ contextUnchanged: true, validationStillApplicable: true }), isTaskRunning: () => running });
    const create = handlers.get('task-governance:plan-create')!;
    const created = create({ taskId: 'session-a', projectId: project.id, goal: '阶段执行', acceptanceCriteria: ['可安全恢复'], steps: [{ stepKey: 'a', title: '阶段', order: 0 }] });
    handlers.get('task-governance:plan-confirm')!(created.plan.id);
    handlers.get('task-governance:step-transition')!({ planId: created.plan.id, stepId: created.steps[0].id, next: 'blocked', outputSummary: '外部服务不可用，已停止' });
    const input = { taskId: 'session-a', projectId: project.id, planId: created.plan.id, stepId: created.steps[0].id, checkpointSummary: '安全边界', completedActions: [], pendingActions: ['恢复'], evidenceRefs: [] };
    running = true;
    await assert.rejects(() => handlers.get('task-governance:checkpoint-create')!(input), /任务仍在运行/);
    running = false;
    const checkpoint = await handlers.get('task-governance:checkpoint-create')!(input);
    const assess = handlers.get('task-governance:recovery-assess')!;
    assert.equal((await assess(checkpoint.id)).status, 'safe_to_resume');
    runtimeAvailable = false;
    assert.equal((await assess(checkpoint.id)).status, 'cannot_resume');
    running = true;
    await assert.rejects(() => assess(checkpoint.id), /任务仍在运行/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('F03 真实 Git worktree 检查点对未跟踪二进制、删除和暂存变化敏感', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-checkpoint-real-git-'));
  const exec = promisify(execFile);
  try {
    const repo = join(root, 'repo'); await mkdir(repo);
    const git = (args: string[]) => exec('git', args, { cwd: repo, windowsHide: true });
    await git(['init', '-b', 'main']); await git(['config', 'user.name', '精工测试']); await git(['config', 'user.email', 'test@example.invalid']);
    await writeFile(join(repo, 'removed.txt'), '原始文件\n'); await git(['add', '.']); await git(['commit', '-m', '建立基线']);
    const connector = new GitConnector(join(root, 'workspaces'));
    const project = await connector.register(repo);
    const workspace = await connector.createWorkspace(project, 'checkpoint-session');
    await rm(join(workspace.path, 'removed.txt'));
    await writeFile(join(workspace.path, 'binary.dat'), Buffer.from([0, 9, 255]));
    const first = await projectFingerprint(connector, project, workspace.path);
    assert.equal(first.branch, workspace.branch);
    assert.ok(first.worktreeFingerprint);
    assert.equal(first.fileManifest.find(item => item.path === 'removed.txt')?.status, 'D');
    await exec('git', ['add', '--', 'binary.dat'], { cwd: workspace.path, windowsHide: true });
    const staged = await projectFingerprint(connector, project, workspace.path);
    assert.ok(staged.worktreeFingerprint);
    assert.notEqual(staged.worktreeFingerprint, first.worktreeFingerprint);
    assert.equal((await git(['status', '--porcelain'])).stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

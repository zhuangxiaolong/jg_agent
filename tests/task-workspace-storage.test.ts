import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src';
import { createAgentTask, createTaskContract, verifyTaskLifecycleEventChain } from '../packages/agent-orchestrator/src';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-task-workspace-store-'));
  const database = join(root, 'local.db'); const path = join(root, 'task-workspace');
  const store = await LocalStore.open(database);
  store.saveProject({ id: 'project', name: '项目', path: join(root, 'project'), branch: 'main' });
  store.saveSession({ id: 'session', projectId: 'project', title: '开发会话', workspacePath: join(root, 'parent-workspace'), status: 'idle', createdAt: '2026-11-10T00:00:00.000Z', model: 'test' });
  const task = createAgentTask({ id: 'task', sessionId: 'session', projectId: 'project', name: '开发任务', role: 'developer', description: '隔离开发', workspaceMode: 'worktree' });
  store.saveAgentTaskContract(task, createTaskContract(task, { acceptanceCriteria: ['真实构建和测试通过'] }), 0, 'local-user');
  const mapping = { version: 1, taskId: 'task', sessionId: 'session', projectId: 'project', path, branch: 'agent/task', baseCommit: 'a'.repeat(40), createdAt: '2026-11-10T00:00:00.000Z', retained: true };
  return { root, database, path, store, mapping };
}

test('工作区绑定原子保存路径和映射，重复映射幂等且重启保留', async () => {
  const f = await fixture(); let store = f.store;
  try {
    const task = store.listAgentTasks('session')[0];
    const bound = store.bindTaskWorkspace('session', 'task', task.stateVersion!, f.path, f.mapping);
    assert.equal(bound.workspacePath, f.path); assert.equal(bound.stateVersion, task.stateVersion! + 1);
    assert.deepEqual(store.bindTaskWorkspace('session', 'task', task.stateVersion!, f.path, { ...f.mapping }), bound);
    assert.equal(store.listTaskLifecycleEvents('session', 'task').filter(event => event.eventType === 'workspace.created').length, 1);
    store.close(); store = await LocalStore.open(f.database);
    assert.equal(store.listAgentTasks('session')[0].workspacePath, f.path);
    const events = store.listTaskLifecycleEvents('session', 'task');
    assert.deepEqual(events.at(-1)?.payload.workspace, f.mapping);
    assert.equal(verifyTaskLifecycleEventChain(events), true);
    assert.throws(() => store.saveAgentTasksForSession('session', [{ ...store.listAgentTasks('session')[0], workspacePath: join(f.root, 'other') }]), /workspacePath/);
    assert.throws(() => store.bindTaskWorkspace('session', 'task', bound.stateVersion!, f.path, { ...f.mapping, baseCommit: 'b'.repeat(40) }), /不可变工作区映射/);
  } finally { store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('工作区绑定拒绝过期版本、路径和身份篡改以及运行中任务', async () => {
  const f = await fixture();
  try {
    const task = f.store.listAgentTasks('session')[0];
    assert.throws(() => f.store.bindTaskWorkspace('session', 'task', 0, f.path, f.mapping), /状态版本已变化/);
    for (const field of ['taskId', 'sessionId', 'projectId', 'path']) assert.throws(() => f.store.bindTaskWorkspace('session', 'task', task.stateVersion!, f.path, { ...f.mapping, [field]: 'different' }), /映射必须/);
    assert.throws(() => f.store.bindTaskWorkspace('session', 'task', task.stateVersion!, 'relative-path', { ...f.mapping, path: 'relative-path' }), /绝对路径/);
    f.store.transitionTaskLifecycle({ sessionId: 'session', taskId: 'task', dimension: 'execution', to: 'RUNNING', expectedStateVersion: task.stateVersion!, actor: 'platform' });
    assert.throws(() => f.store.bindTaskWorkspace('session', 'task', task.stateVersion! + 1, f.path, f.mapping), /运行中的任务/);
    assert.equal(f.store.listAgentTasks('session')[0].workspacePath, undefined);
    assert.equal(f.store.listTaskLifecycleEvents('session', 'task').some(event => event.eventType === 'workspace.created'), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('工作区绑定磁盘失败不留下路径、映射或消耗状态版本', async () => {
  const f = await fixture();
  try {
    const before = f.store.listAgentTasks('session')[0];
    await rm(f.database); await mkdir(f.database);
    assert.throws(() => f.store.bindTaskWorkspace('session', 'task', before.stateVersion!, f.path, f.mapping));
    assert.deepEqual(f.store.listAgentTasks('session')[0], before);
    assert.equal(f.store.listTaskLifecycleEvents('session', 'task').filter(event => event.eventType === 'workspace.created').length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

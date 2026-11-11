import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, access, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWorkspaceContext, validateWorkspace, workspacePromptContext, workspaceRuntimeCapability, WorkspaceService, type Workspace, type WorkspaceMetadataStore } from '../packages/workspace/src';

const wsId = '00000000-0000-4000-8000-000000000001';
const repoA = '00000000-0000-4000-8000-000000000002';
const repoB = '00000000-0000-4000-8000-000000000003';

function workspace(): Workspace {
  return {
    id: wsId, name: 'MES', description: '跨仓库开发', primaryRepositoryId: repoA,
    repositories: [
      { id: repoA, alias: 'backend', name: 'API', rootPath: 'D:\\code\\api', role: 'backend', primary: true, access: 'write' },
      { id: repoB, alias: 'frontend', name: 'Web', rootPath: 'D:\\code\\web', role: 'frontend', primary: false, access: 'read' },
    ], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

class MemoryStore implements WorkspaceMetadataStore {
  private readonly data = new Map<string, unknown>();
  listWorkspaces<T>(): T[] { return [...this.data.values()] as T[]; }
  getWorkspace<T>(id: string): T | undefined { return this.data.get(id) as T | undefined; }
  saveWorkspace<T extends { id: string }>(value: T): void { this.data.set(value.id, structuredClone(value)); }
  deleteWorkspace(id: string): void { this.data.delete(id); }
}

test('工作区验证主仓库 ID、仓库 ID、绝对路径和唯一别名', () => {
  const value = validateWorkspace(workspace());
  assert.equal(value.primaryRepositoryId, repoA);
  assert.equal(value.repositories.find(item => item.id === repoA)?.primary, true);
  assert.throws(() => validateWorkspace({ ...workspace(), primaryRepositoryId: repoB }), /不一致/);
  assert.throws(() => validateWorkspace({ ...workspace(), repositories: [...workspace().repositories, { ...workspace().repositories[1], id: '00000000-0000-4000-8000-000000000004' }] }), /别名重复/);
  assert.throws(() => validateWorkspace({ ...workspace(), repositories: [{ ...workspace().repositories[0], rootPath: 'relative/path' }] }), /绝对路径/);
  assert.equal(validateWorkspace({ ...workspace(), instructions: '第一行\r\n第二行' }).instructions, '第一行\n第二行');
});

test('提示上下文明确说明仓库元数据不提供 Runtime 授权', () => {
  const context = buildWorkspaceContext(workspace());
  assert.equal(context.repositories.length, 2);
  const prompt = workspacePromptContext(context);
  assert.match(prompt, /不构成 Runtime 文件访问授权/);
  assert.doesNotMatch(prompt, /授权仓库/);
  assert.equal(workspaceRuntimeCapability(workspace()).multiRepositoryExecution, false);
});

test('工作区 CRUD 和仓库移除只更新元数据', () => {
  const store = new MemoryStore();
  const service = new WorkspaceService(store);
  store.saveWorkspace(workspace());
  const changed = service.removeRepository(wsId, repoB);
  assert.deepEqual(changed.repositories.map(item => item.id), [repoA]);
  assert.equal(service.getById(wsId).repositories.length, 1);
  service.update(wsId, { name: 'MES 工程' });
  assert.equal(service.getById(wsId).name, 'MES 工程');
  service.delete(wsId);
  assert.deepEqual(service.list(), []);
});

test('工作区不依赖 Git，可空创建并移除最后一个仓库', async () => {
  const store = new MemoryStore();
  const service = new WorkspaceService(store);
  const created = await service.create({ name: '日常事务', description: '文本与附件分析' });
  assert.deepEqual(created.repositories, []);
  assert.equal(created.primaryRepositoryId, undefined);
  assert.equal(service.list()[0].name, '日常事务');
  assert.deepEqual(buildWorkspaceContext(created).repositories, []);
  await assert.rejects(service.create({ name: '日常事务' }), /已存在/);
  store.saveWorkspace({ ...workspace(), repositories: [workspace().repositories[0]] });
  const empty = service.removeRepository(wsId, repoA);
  assert.deepEqual(empty.repositories, []);
  assert.equal(empty.primaryRepositoryId, undefined);
  assert.equal(service.getById(wsId).repositories.length, 0);
});

test('拒绝执行中的工作区修改且限制元数据大小', () => {
  const store = new MemoryStore();
  store.saveWorkspace(workspace());
  const service = new WorkspaceService(store, { isWorkspaceBusy: id => id === wsId });
  assert.throws(() => service.removeRepository(wsId, repoB), /任务正在执行/);
  assert.throws(() => validateWorkspace({ ...workspace(), instructions: 'x'.repeat(1024 * 1024) }), /工作区说明/);
});

test('识别子目录下的 Git 根目录并清除 remote URL 凭据', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'workspace-test-'));
  try {
    const repo = path.join(temp, 'backend');
    const nested = path.join(repo, 'src', 'module');
    await mkdir(nested, { recursive: true });
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://alice:secret@example.test/team/api.git?token=hidden']);
    const store = new MemoryStore();
    const service = new WorkspaceService(store);
    const created = await service.create({ name: '安全测试', repositoryPath: nested });
    assert.equal(created.repositories[0].rootPath.toLowerCase(), (await realpath(repo)).toLowerCase());
    assert.equal(created.repositories[0].remoteUrl, 'https://example.test/team/api.git');
    assert.doesNotMatch(JSON.stringify(created), /alice|secret|token=hidden/);
    await access(path.join(repo, '.git'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


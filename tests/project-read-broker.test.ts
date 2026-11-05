import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PROJECT_READ_TOOLS, ProjectReadBroker } from '../packages/agent-runtime/src/project-read-broker';
import { GitConnector } from '../packages/git-connector/src/index';

const execute = promisify(execFile);
async function developFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-write-broker-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  const git = (args: string[]) => execute('git', args, { cwd: source, windowsHide: true });
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', '精工测试']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(source, 'sample.ts'), 'export const quantity = 1;\n');
  await git(['add', '--', 'sample.ts']);
  await git(['commit', '-m', '建立测试基线']);
  const connector = new GitConnector(path.join(root, 'workspaces'));
  const project = await connector.register(source);
  const workspace = await connector.createWorkspace(project, 'write-test');
  return { root, source, workspace: workspace.path };
}

test('只读 broker 真实列目录和读取中文代码，不改原文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-read-broker-'));
  await mkdir(path.join(root, '项目代码'));
  const code = '// 中文代码\nexport const quantity = 1;\n';
  const file = path.join(root, '项目代码', 'sample.ts');
  await writeFile(file, code);
  const broker = await ProjectReadBroker.create(root);
  assert.equal(PROJECT_READ_TOOLS.length, 2);
  const listing = await broker.call('list_project_files', { path: '.', limit: 10 });
  assert.deepEqual(listing.files, ['项目代码/sample.ts']);
  const output = await broker.call('read_project_file', { path: '项目代码/sample.ts' });
  assert.equal(output.content, code);
  assert.equal(output.path, '项目代码/sample.ts');
  assert.equal(await readFile(file, 'utf8'), code);
  await assert.rejects(broker.call('delete_file', { path: '项目代码/sample.ts' }), /未授权/);
  await assert.rejects(broker.call('read_project_file', { path: '项目代码/sample.ts', command: 'write' }), /未知参数/);
});

test('只读 broker 拒绝越界、绝对路径、凭据、Git元数据、二进制及大文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-read-boundary-'));
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, '.git', 'config'), 'git metadata');
  await writeFile(path.join(root, '.env'), 'PRIVATE=do-not-read');
  await writeFile(path.join(root, 'private.key'), 'credential');
  await writeFile(path.join(root, 'appsettings.json'), '{}');
  await writeFile(path.join(root, 'oversized.ts'), 'x'.repeat(128 * 1024 + 1));
  await writeFile(path.join(root, 'binary.ts'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, 'unsafe.ts'), 'const apiKey = "test-credential-only";');
  const broker = await ProjectReadBroker.create(root);
  for (const requested of ['../outside.ts', path.join(root, 'binary.ts'), '.git/config', '.env', 'private.key', 'appsettings.json', 'oversized.ts', 'binary.ts', 'unsafe.ts', 'sample.ts:alternate']) {
    await assert.rejects(broker.call('read_project_file', { path: requested }), Error, requested);
  }
  const listing = await broker.call('list_project_files', { path: '.', limit: 5 });
  assert.ok(!(listing.files as string[]).some((file) => /\.env|private|appsettings|\.git|oversized/.test(file)));
});

test('只读 broker 拒绝目录联接与文件硬链接并限制遍历数量', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-read-links-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'jinggong-outside-'));
  await writeFile(path.join(outside, 'outside.ts'), 'outside');
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ProjectReadBroker.create(path.join(root, 'linked')), /目录无效|链接|联接/);
  await mkdir(path.join(outside, 'nested'));
  await assert.rejects(ProjectReadBroker.create(path.join(root, 'linked', 'nested')), /链接|联接/);
  await link(path.join(outside, 'outside.ts'), path.join(root, 'hardlink.ts'));
  for (let index = 0; index < 4; index++) await writeFile(path.join(root, `safe-${index}.ts`), String(index));
  const broker = await ProjectReadBroker.create(root);
  await assert.rejects(broker.call('read_project_file', { path: 'linked/outside.ts' }), /链接|联接/);
  await assert.rejects(broker.call('read_project_file', { path: 'hardlink.ts' }), /单链接/);
  const listing = await broker.call('list_project_files', { path: '.', limit: 2 });
  assert.equal((listing.files as string[]).length, 2);
  assert.equal(listing.truncated, true);
  assert.ok(!(listing.files as string[]).some((file) => file.includes('linked') || file.includes('hardlink')));
});

test('只读 broker 对转义文本和长文件列表执行结构化总预算裁剪', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-read-budget-'));
  await writeFile(path.join(root, 'escaped.ts'), '\n"\\'.repeat(20000));
  await Promise.all(Array.from({ length: 150 }, (_, index) => writeFile(path.join(root, `${String(index).padStart(3, '0')}-${'a'.repeat(165)}.ts`), 'code')));
  const broker = await ProjectReadBroker.create(root);
  const content = await broker.call('read_project_file', { path: 'escaped.ts' });
  assert.equal(content.truncated, true);
  assert.ok(JSON.stringify(content).length <= 24000);
  assert.equal(typeof JSON.parse(JSON.stringify(content)).content, 'string');
  const listing = await broker.call('list_project_files', { path: '.', limit: 500 });
  assert.equal(listing.truncated, true);
  assert.ok(JSON.stringify(listing).length <= 24000);
  assert.ok((listing.files as string[]).length > 0);
});

test('开发 broker 在真实 Worktree 创建、乐观校验修改及删除，主分支不变', async () => {
  const { source, workspace } = await developFixture();
  const rules: string[] = [];
  const broker = await ProjectReadBroker.create(workspace, { mode: 'develop', beforeWrite: async (file, content) => { rules.push(`${file}:${content === null ? 'delete' : 'write'}`); if (file === 'blocked.ts') throw new Error('强制规则阻止此文件'); } });
  const read = await broker.call('read_project_file', { path: 'sample.ts' });
  assert.match(read.hash as string, /^[a-f0-9]{64}$/);
  await assert.rejects(broker.call('write_project_file', { path: 'sample.ts', content: 'changed' }), /SHA256/);
  const written = await broker.call('write_project_file', { path: 'sample.ts', content: 'export const quantity = 2;\n', expectedHash: read.hash });
  assert.notEqual(written.hash, read.hash);
  assert.equal(await readFile(path.join(workspace, 'sample.ts'), 'utf8'), 'export const quantity = 2;\n');
  await assert.rejects(broker.call('write_project_file', { path: 'sample.ts', content: 'overwrite', expectedHash: read.hash }), /SHA256/);
  const created = await broker.call('write_project_file', { path: 'new/folder/新增.ts', content: '// 新文件\n' });
  assert.match(created.hash as string, /^[a-f0-9]{64}$/);
  await assert.rejects(broker.call('delete_project_file', { path: 'new/folder/新增.ts' }), /SHA256/);
  const removed = await broker.call('delete_project_file', { path: 'new/folder/新增.ts', expectedHash: created.hash });
  assert.equal(removed.deleted, true);
  await assert.rejects(readFile(path.join(workspace, 'new/folder/新增.ts')), { code: 'ENOENT' });
  await assert.rejects(broker.call('write_project_file', { path: './blocked.ts', content: 'no' }), /强制规则/);
  await assert.rejects(readFile(path.join(workspace, 'blocked.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(source, 'sample.ts'), 'utf8'), 'export const quantity = 1;\n');
  assert.ok(rules.includes('sample.ts:write'));
  assert.ok(rules.includes('new/folder/新增.ts:delete'));
  const deletionBroker = await ProjectReadBroker.create(workspace, { mode: 'develop', beforeWrite: async (file, content) => { if (file === 'sample.ts' && content === null) throw new Error('禁止删除必需文件'); } });
  await assert.rejects(deletionBroker.call('delete_project_file', { path: './sample.ts', expectedHash: written.hash }), /禁止删除必需文件/);
});

test('开发 broker 仍拒绝只读模式、无规则、敏感路径、链接与规则检查期间并发改动', async () => {
  const { source, workspace } = await developFixture();
  await assert.rejects(ProjectReadBroker.create(source, { mode: 'develop' }), /Worktree/);
  const readonly = await ProjectReadBroker.create(workspace);
  await assert.rejects(readonly.call('write_project_file', { path: 'new.ts', content: 'no' }), /只读模式/);
  const noRules = await ProjectReadBroker.create(workspace, { mode: 'develop' });
  await assert.rejects(noRules.call('write_project_file', { path: 'new.ts', content: 'no' }), /强制开发规则/);
  const broker = await ProjectReadBroker.create(workspace, { mode: 'develop', beforeWrite: async (file) => { if (file === 'sample.ts') await writeFile(path.join(workspace, file), '人工并发编辑\n'); } });
  const current = await broker.call('read_project_file', { path: 'sample.ts' });
  await assert.rejects(broker.call('write_project_file', { path: 'sample.ts', content: 'Agent内容', expectedHash: current.hash }), /文件已变化/);
  assert.equal(await readFile(path.join(workspace, 'sample.ts'), 'utf8'), '人工并发编辑\n');
  for (const file of ['../outside.ts', '.git/config', '.env', 'key.pem', 'CON.ts']) await assert.rejects(broker.call('write_project_file', { path: file, content: 'no' }));
  await assert.rejects(broker.call('write_project_file', { path: 'secret-content.ts', content: 'const password = "test-only-secret";' }));
  const protectedBroker = await ProjectReadBroker.create(workspace, { mode: 'develop', beforeWrite: async () => undefined, protectedValues: ['sentinel-unit-only-value'] });
  await assert.rejects(protectedBroker.call('write_project_file', { path: 'settings.ts', content: 'const value = "sentinel-unit-only-value";' }), /凭据/);
  await writeFile(path.join(workspace, 'config.ts'), 'const value = "sentinel-unit-only-value";');
  await assert.rejects(protectedBroker.call('read_project_file', { path: 'config.ts' }), /凭据/);
});

test('Windows 8.3 短名归一到实际文件和父目录，规则不能绕过且保留长文件名', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅验证 Windows 8.3 文件名');
  const { workspace } = await developFixture();
  const name = 'LongRequirementFile.txt';
  const target = path.join(workspace, name);
  await writeFile(target, 'safe\n');
  const getShortName = async (full: string): Promise<string> => {
    const directory = (await execute(process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'dir', '/x', path.dirname(full)], { windowsHide: true })).stdout;
    const line = directory.split(/\r?\n/).find((item) => item.trimEnd().endsWith(` ${path.basename(full)}`));
    return line?.trim().split(/\s+/).at(-2) ?? '';
  };
  const shortName = await getShortName(target);
  if (!shortName.includes('~')) return t.skip('测试卷未生成 8.3 短文件名');
  const seen: string[] = [];
  const broker = await ProjectReadBroker.create(workspace, { mode: 'develop', beforeWrite: async (file, content) => {
    seen.push(file);
    if (file === name && content?.includes('forbidden')) throw new Error('长文件名规则拒绝');
    if (file === 'LongProjectFolderName/new.ts') throw new Error('长目录名规则拒绝');
  } });
  const current = await broker.call('read_project_file', { path: shortName });
  assert.equal(current.path, name);
  await assert.rejects(broker.call('write_project_file', { path: shortName, content: 'forbidden\n', expectedHash: current.hash }), /长文件名规则/);
  const written = await broker.call('write_project_file', { path: shortName, content: 'safe updated\n', expectedHash: current.hash });
  assert.equal(written.path, name);
  assert.equal(await readFile(target, 'utf8'), 'safe updated\n');
  const folder = path.join(workspace, 'LongProjectFolderName');
  await mkdir(folder);
  const shortFolder = await getShortName(folder);
  assert.ok(shortFolder.includes('~'));
  await assert.rejects(broker.call('write_project_file', { path: `${shortFolder}/new.ts`, content: 'no' }), /长目录名规则/);
  assert.ok(seen.every((file) => !file.includes('~')));
});

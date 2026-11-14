import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUTHORIZED_DIRECTORY_TOOLS, AuthorizedDirectoryBroker, type AuthorizedDirectoryPolicy } from '../packages/agent-runtime/src/authorized-directory-broker';
import { CodexRuntime } from '../packages/agent-runtime/src/index';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-authorized-read-'));
  await mkdir(path.join(root, '简历'), { recursive: true });
  await writeFile(path.join(root, '简历', '候选人.txt'), 'MES/WMS 实施工程师\n项目交付与库存流程。\n');
  await writeFile(path.join(root, '简历', '说明.md'), '# 仅供解析\n');
  return root;
}

test('授权目录 broker 先列授权再列文件并只读解析文档', async () => {
  const root = await fixture();
  try {
    let policy: AuthorizedDirectoryPolicy = { mode: 'restricted', directories: [{ id: 'resume', path: root }] };
    const broker = new AuthorizedDirectoryBroker(() => policy);
    assert.equal(AUTHORIZED_DIRECTORY_TOOLS.length, 4);
    const directories = await broker.call('list_authorized_directories', {});
    assert.equal(directories.mode, 'restricted');
    assert.deepEqual((directories.directories as Array<{ grantId: string }>).map(item => item.grantId), ['resume']);
    const listing = await broker.call('list_authorized_files', { grantId: 'resume', path: '.' });
    assert.deepEqual(listing.files, ['简历/候选人.txt', '简历/说明.md']);
    const document = await broker.call('read_authorized_document', { grantId: 'resume', path: '简历/候选人.txt' });
    assert.match(String(document.content), /MES\/WMS/);
    assert.equal(document.untrustedContent, true);
    assert.equal(await readFile(path.join(root, '简历', '候选人.txt'), 'utf8'), 'MES/WMS 实施工程师\n项目交付与库存流程。\n');
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'resume', path: '../outside.txt' }), /越界/);
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'resume', path: path.join(root, '简历', '候选人.txt') }), /相对路径/);
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'revoked', path: '简历/候选人.txt' }), /未授权|撤销/);
    policy = { mode: 'restricted', directories: [] };
    await assert.rejects(broker.call('list_authorized_files', { grantId: 'resume' }), /未授权|撤销/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('授权目录 broker 拒绝链接、硬链接、敏感目录和不支持文件', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'jinggong-authorized-outside-'));
  try {
    await writeFile(path.join(outside, 'outside.txt'), 'outside');
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await link(path.join(outside, 'outside.txt'), path.join(root, 'hardlink.txt'));
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'private');
    await writeFile(path.join(root, 'secret.pem'), 'private');
    await writeFile(path.join(root, 'data.bin'), Buffer.from([0, 1, 2]));
    const broker = new AuthorizedDirectoryBroker(() => ({ mode: 'full', directories: [{ id: 'all', path: root }] }));
    const listing = await broker.call('list_authorized_files', { grantId: 'all' });
    assert.deepEqual(listing.files, ['简历/候选人.txt', '简历/说明.md']);
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'all', path: 'linked/outside.txt' }), /链接|联接/);
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'all', path: 'hardlink.txt' }), /单链接/);
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'all', path: '.git/config' }), /不允许|越界/);
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'all', path: 'secret.pem' }), /白名单|不允许/);
    await assert.rejects(broker.call('read_authorized_document', { grantId: 'all', path: 'data.bin' }), /白名单/);
    await mkdir(path.join(root, '.codex', 'docs'), { recursive: true });
    await writeFile(path.join(root, '.codex', 'docs', 'hidden.txt'), '不允许作为授权根目录绕过排除范围');
    const protectedRoot = new AuthorizedDirectoryBroker(() => ({ mode: 'restricted', directories: [{ id: 'protected', path: path.join(root, '.codex', 'docs') }] }));
    await assert.rejects(protectedRoot.call('read_authorized_document', { grantId: 'protected', path: 'hidden.txt' }), /根目录.*禁止读取/);
    const roots = await new AuthorizedDirectoryBroker(() => ({ mode: 'full', directories: [{ id: 'missing', path: path.join(root, 'missing') }, { id: 'valid', path: root }] })).call('list_authorized_directories', {});
    assert.deepEqual((roots.directories as Array<{ grantId: string }>).map(item => item.grantId), ['valid']);
    assert.deepEqual((roots.unavailable as Array<{ grantId: string }>).map(item => item.grantId), ['missing']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('授权目录 broker 返回文档 SHA256 快照标识并读取已更新版本', async () => {
  const root = await fixture();
  try {
    const file = path.join(root, '简历', '候选人.txt');
    const broker = new AuthorizedDirectoryBroker(() => ({ mode: 'restricted', directories: [{ id: 'resume', path: root }] }));
    const original = await broker.call('read_authorized_document', { grantId: 'resume', path: '简历/候选人.txt' });
    assert.match(String(original.digest), /^[a-f0-9]{64}$/);
    await writeFile(file, '文件已被并发修改\n');
    const changed = await broker.call('read_authorized_document', { grantId: 'resume', path: '简历/候选人.txt' });
    assert.match(String(changed.content), /并发修改/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('模型只能请求用户选择目录，不能通过参数自行扩展授权', async () => {
  const root = await fixture();
  let selections = 0;
  let policy: AuthorizedDirectoryPolicy = { mode: 'restricted', directories: [] };
  const broker = new AuthorizedDirectoryBroker(() => policy, async () => {
    selections += 1;
    policy = { mode: 'restricted', directories: [{ id: 'user-selected', path: root }] };
    return { granted: true };
  });
  try {
    await assert.rejects(broker.call('request_authorized_directory', { path: root }), /未授权.*参数/);
    assert.equal(selections, 0);
    assert.deepEqual(await broker.call('request_authorized_directory', {}), { granted: true });
    assert.equal(selections, 1);
    assert.match(String((await broker.call('read_authorized_document', { grantId: 'user-selected', path: '简历/候选人.txt' })).content), /MES/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('资料解析 restricted 策略不降低 Runtime 完全访问权限', async () => {
  let policy: AuthorizedDirectoryPolicy = { mode: 'restricted', directories: [] };
  const runtime = new CodexRuntime({ executable: '', home: '', baseUrl: 'https://model.example.invalid/v1', model: 'test', authorizedDirectories: () => policy });
  const state = runtime as any;
  const replies: any[] = [];
  const cwd = process.cwd();
  state.write = (message: any) => replies.push(message);
  state.sessions.add('policy-thread');
  state.sessionRoots.set('policy-thread', cwd);
  state.setActive('policy-thread', 'policy-turn');
  try {
    const approval = (id: number) => state.receive({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'policy-thread', turnId: 'policy-turn', itemId: `item-${id}`, command: 'Get-Content file.txt', environmentId: 'local', cwd: path.resolve(`${cwd}-outside`) } });
    approval(1);
    assert.deepEqual(replies.pop(), { id: 1, result: { decision: 'accept' } });
    policy = { mode: 'full', directories: [] };
    approval(2);
    assert.deepEqual(replies.pop(), { id: 2, result: { decision: 'accept' } });
  } finally { await runtime.close(); }
});

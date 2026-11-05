import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitConnector } from '../packages/git-connector/src/index';

const exec = promisify(execFile);
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, windowsHide: true });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '精工 Git '));
  const repo = join(root, '中文 代码仓库');
  const workspaces = join(root, '任务 工作区');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', '精工 测试']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', '代码.txt'), '原始内容\n');
  await writeFile(join(repo, '删除.txt'), '保留原仓库\n');
  await writeFile(join(repo, '.gitattributes'), '*.txt filter=poc\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', '建立测试基线']);
  return { root, repo, connector: new GitConnector(workspaces), workspaces };
}

test('真实 Git Worktree 隔离主分支，读取 staged、修改、删除、未跟踪和二进制 Diff', async () => {
  const { root, repo, connector } = await fixture();
  try {
    assert.match(await connector.version(), /git version/);
    const project = await connector.register(repo);
    assert.equal(project.branch, 'main');
    await assert.rejects(connector.register(join(repo, 'src')), /根目录/);
    await assert.rejects(connector.createWorkspace(project, '../escape'), /标识/);
    const workspace = await connector.createWorkspace(project, 'session-中文'.replace('中文', 'test'));
    assert.equal(workspace.branch, 'agent/session-test');
    assert.deepEqual(await connector.diff(workspace.path), []);
    await writeFile(join(workspace.path, 'src', '代码.txt'), '修改内容\n');
    await rm(join(workspace.path, '删除.txt'));
    await writeFile(join(workspace.path, '暂存 新文件.txt'), '第一版\n');
    await git(workspace.path, ['add', '--', '暂存 新文件.txt']);
    await writeFile(join(workspace.path, '暂存 新文件.txt'), '第二版\n');
    await writeFile(join(workspace.path, '未跟踪 中文.txt'), '尚未暂存\n');
    await writeFile(join(workspace.path, '二进制.bin'), Buffer.from([0, 255, 1, 0]));
    const diffs = await connector.diff(workspace.path);
    assert.equal(diffs.length, 5);
    assert.match(diffs.find(file => file.path === 'src/代码.txt')!.diff, /-原始内容\n\+修改内容/);
    assert.equal(diffs.find(file => file.path === '删除.txt')!.status, 'D');
    assert.match(diffs.find(file => file.path === '暂存 新文件.txt')!.diff, /\+第二版/);
    assert.equal(diffs.find(file => file.path === '暂存 新文件.txt')!.status, 'A');
    assert.match(diffs.find(file => file.path === '未跟踪 中文.txt')!.diff, /\+尚未暂存/);
    assert.equal(diffs.find(file => file.path === '二进制.bin')!.binary, true);
    assert.equal(await readFile(join(repo, 'src', '代码.txt'), 'utf8'), '原始内容\n');
    assert.equal(await readFile(join(repo, '删除.txt'), 'utf8'), '保留原仓库\n');
    assert.equal((await git(repo, ['status', '--porcelain'])).stdout, '');
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'main');
    await assert.rejects(connector.diff(repo), /仅允许/);
    await git(workspace.path, ['checkout', '--detach']);
    await assert.rejects(connector.diff(workspace.path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('空仓库拒绝使用，Worktree 创建禁用 checkout hook 和 smudge filter', async () => {
  const { root, repo, connector } = await fixture();
  try {
    const empty = join(root, '空仓库');
    await mkdir(empty);
    await git(empty, ['init']);
    await assert.rejects(connector.register(empty));
    await writeFile(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nprintf HOOK_RAN > hook-was-run.txt\n');
    await git(repo, ['config', 'filter.poc.smudge', 'sh -c "printf FILTER_RAN > filter-was-run.txt; cat"']);
    await git(repo, ['config', 'filter.poc.clean', 'sh -c "printf CLEAN_RAN > clean-was-run.txt; cat"']);
    await git(repo, ['config', 'filter.poc.required', 'true']);
    const project = await connector.register(repo);
    const workspace = await connector.createWorkspace(project, 'hooks-test');
    assert.deepEqual(await connector.diff(workspace.path), []);
    assert.equal(await readFile(join(workspace.path, 'src', '代码.txt'), 'utf8'), '原始内容\n');
    await assert.rejects(readFile(join(workspace.path, 'hook-was-run.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(workspace.path, 'filter-was-run.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(workspace.path, 'clean-was-run.txt')), { code: 'ENOENT' });
    assert.equal((await git(repo, ['-c', 'filter.poc.required=false', '-c', 'filter.poc.clean=', 'status', '--porcelain'])).stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('超大未跟踪文件显式截断，特殊 pathspec 文件名按字面处理', async () => {
  const { root, repo, connector } = await fixture();
  try {
    const project = await connector.register(repo);
    const workspace = await connector.createWorkspace(project, 'limit-test');
    await writeFile(join(workspace.path, 'big.txt'), 'a'.repeat(600 * 1024));
    await writeFile(join(workspace.path, '[literal].txt'), '只显示真实内容\n');
    const diffs = await connector.diff(workspace.path);
    assert.equal(diffs.find(file => file.path === 'big.txt')!.truncated, true);
    assert.match(diffs.find(file => file.path === '[literal].txt')!.diff, /真实内容/);
    assert.equal(diffs.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实 Git 历史、中文提交摘要与显式文件提交不修改主分支，禁用 Hook 和 Filter', async () => {
  const { root, repo, connector } = await fixture();
  try {
    const project = await connector.register(repo);
    const workspace = await connector.createWorkspace(project, 'commit-test');
    const initial = await connector.state(workspace.path);
    assert.equal(initial.branch, 'agent/commit-test');
    assert.equal(initial.dirty, false);
    assert.equal(initial.commits[0].message, '建立测试基线');
    assert.match(initial.commits[0].hash, /^[a-f0-9]{40}$/);
    await assert.rejects(connector.generateCommitMessage(workspace.path), /没有可提交/);
    await writeFile(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nprintf HOOK_RAN > hook-was-run.txt\nexit 1\n');
    await writeFile(join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nprintf POST_HOOK_RAN > post-hook-was-run.txt\n');
    await git(repo, ['config', 'filter.poc.clean', 'sh -c "printf FILTER_RAN > clean-was-run.txt; cat"']);
    await git(repo, ['config', 'filter.poc.required', 'true']);
    await writeFile(join(workspace.path, 'src', '代码.txt'), 'Agent 修改\n');
    await writeFile(join(workspace.path, '[新增].txt'), '真实新文件\n');
    await writeFile(join(workspace.path, '稍后处理.txt'), '本次不提交\n');
    // 未来时间戳稳定触发 racy index 重检，write-tree 也必须禁用仓库 clean filter。
    const futureTime = new Date(Date.now() + 60000);
    for (const file of ['src/代码.txt', '[新增].txt']) await utimes(join(workspace.path, file), futureTime, futureTime);
    assert.match(await connector.generateCommitMessage(workspace.path), /新增2、修改1、删除0/);
    const hash = await connector.commit(workspace.path, { message: '完成真实文件变更', authorName: '精工 Agent', authorEmail: 'agent@example.invalid', files: ['src/代码.txt', '[新增].txt'] });
    assert.match(hash, /^[a-f0-9]{40}$/);
    const current = await connector.state(workspace.path);
    assert.equal(current.commits[0].hash, hash);
    assert.equal(current.commits[0].message, '完成真实文件变更');
    assert.equal(current.commits[0].author, '精工 Agent');
    assert.equal(current.dirty, true);
    assert.equal((await git(workspace.path, ['-c', 'filter.poc.clean=', '-c', 'filter.poc.required=false', 'show', 'HEAD:src/代码.txt'])).stdout, 'Agent 修改\n');
    assert.deepEqual((await connector.diff(workspace.path)).map((item) => item.path), ['稍后处理.txt']);
    for (const file of ['hook-was-run.txt', 'post-hook-was-run.txt', 'clean-was-run.txt']) await assert.rejects(readFile(join(workspace.path, file)), { code: 'ENOENT' });
    assert.equal(await readFile(join(repo, 'src', '代码.txt'), 'utf8'), '原始内容\n');
    assert.equal((await git(repo, ['rev-parse', 'main'])).stdout.trim(), initial.commits[0].hash);
    await assert.rejects(connector.commit(repo, { message: '禁止修改主仓库' }), /仅允许/);
    await git(workspace.path, ['checkout', '-b', 'unmanaged-branch']);
    await assert.rejects(connector.commit(workspace.path, { message: '禁止任意分支' }), /身份/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git 提交拒绝敏感路径、链接、越界及本次清单以外暂存', async () => {
  const { root, repo, connector } = await fixture();
  try {
    const project = await connector.register(repo);
    const workspace = await connector.createWorkspace(project, 'commit-guards');
    await writeFile(join(workspace.path, '.env'), 'TEST_ONLY=not-a-real-key');
    await assert.rejects(connector.commit(workspace.path, { message: '不可提交凭据', files: ['.env'] }), /敏感/);
    await writeFile(join(workspace.path, 'normal.txt'), '安全代码\n');
    await assert.rejects(connector.commit(workspace.path, { message: '禁止越界', files: ['../outside.txt'] }), /清单/);
    await git(workspace.path, ['add', '--', 'normal.txt']);
    await writeFile(join(workspace.path, 'other.txt'), '本次指定代码\n');
    await assert.rejects(connector.commit(workspace.path, { message: '不可夹带暂存', files: ['other.txt'] }), /暂存区/);
    await git(workspace.path, ['reset', 'HEAD', '--', 'normal.txt']);
    await link(join(workspace.path, 'normal.txt'), join(workspace.path, 'linked.txt'));
    await assert.rejects(connector.commit(workspace.path, { message: '禁止硬链接', files: ['linked.txt'] }), /硬链接/);
    await mkdir(join(workspace.path, 'outside'));
    await symlink(join(workspace.path, 'outside'), join(workspace.path, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
    await writeFile(join(workspace.path, 'outside', 'sample.txt'), '外部代码\n');
    await assert.rejects(connector.commit(workspace.path, { message: '禁止目录联接', files: ['junction/sample.txt'] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实本地 Bare 推送同名 agent 分支，拒绝主分支、脏工作区和不安全协议', async () => {
  const { root, repo, connector } = await fixture();
  try {
    const remote = join(root, '远程 Bare 仓库.git');
    await git(root, ['init', '--bare', remote]);
    await git(repo, ['remote', 'add', 'origin', remote]);
    const workspace = await connector.createWorkspace(await connector.register(repo), 'push-test');
    assert.deepEqual((await connector.state(workspace.path)).remotes, ['origin']);
    await writeFile(join(workspace.path, 'push.txt'), '待提交\n');
    await assert.rejects(connector.push(workspace.path, 'origin'), /先提交/);
    const hash = await connector.commit(workspace.path, { message: '验证同名分支推送' });
    await connector.push(workspace.path, 'origin');
    assert.equal((await git(remote, ['rev-parse', 'refs/heads/agent/push-test'])).stdout.trim(), hash);
    await assert.rejects(git(remote, ['rev-parse', '--verify', 'refs/heads/main']));
    await assert.rejects(connector.push(repo, 'origin'), /仅允许/);
    await assert.rejects(connector.push(workspace.path, '--all'), /名称/);
    await git(repo, ['remote', 'set-url', 'origin', 'ext::sh -c echo unsafe']);
    await assert.rejects(connector.push(workspace.path, 'origin'), /支持|凭据|地址/);
    await git(repo, ['remote', 'set-url', 'origin', 'https://user:test-only-password@example.invalid/repo.git']);
    await assert.rejects(connector.push(workspace.path, 'origin'), /凭据/);
    await git(repo, ['remote', 'set-url', 'origin', remote]);
    await git(repo, ['config', 'url.ext::unsafe.insteadOf', remote]);
    await assert.rejects(connector.push(workspace.path, 'origin'), /重写/);
    await git(repo, ['config', '--unset-all', 'url.ext::unsafe.insteadOf']);
    assert.equal((await git(repo, ['branch', '--show-current'])).stdout.trim(), 'main');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('提交门禁验证 Git 规范化后的真实 blob，失败保留修改并防暂存区并发夹带', async () => {
  const { root, repo, connector } = await fixture();
  try {
    const workspace = await connector.createWorkspace(await connector.register(repo), 'staged-rule-test');
    const initial = (await connector.state(workspace.path)).commits[0].hash;
    await writeFile(join(workspace.path, '.gitattributes'), '*.txt text eol=lf\n');
    const content = 'line1\r\nforbidden\r\n';
    await writeFile(join(workspace.path, 'normalized.txt'), content);
    await assert.rejects(connector.commit(workspace.path, {
      message: '禁止规范化后违规内容', beforeCommit: async (files) => {
        assert.equal(files.get('normalized.txt'), 'line1\nforbidden\n');
        if (files.get('normalized.txt')!.includes('line1\nforbidden')) throw new Error('真实 blob 违反禁止文本规则');
      },
    }), /真实 blob 违反/);
    assert.equal((await connector.state(workspace.path)).commits[0].hash, initial);
    assert.equal(await readFile(join(workspace.path, 'normalized.txt'), 'utf8'), content);
    await assert.rejects(connector.commit(workspace.path, {
      message: '禁止暂存区并发夹带', beforeCommit: async () => {
        await writeFile(join(workspace.path, 'concurrent.txt'), '并发变更\n');
        await git(workspace.path, ['add', '--', 'concurrent.txt']);
      },
    }), /暂存区发生并发变化/);
    assert.equal((await connector.state(workspace.path)).commits[0].hash, initial);
    await writeFile(join(workspace.path, 'binary.bin'), Buffer.from([0, 255, 1]));
    await assert.rejects(connector.commit(workspace.path, { message: '二进制需人工审核' }), /UTF-8|二进制/);
    assert.equal((await connector.state(workspace.path)).commits[0].hash, initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function pullFixture(sessionId: string) {
  const setup = await fixture();
  const remote = join(setup.root, '拉取 远程.git');
  const source = join(setup.root, '第一个 clone');
  const peer = join(setup.root, '第二个 clone');
  await git(setup.root, ['clone', '--bare', setup.repo, remote]);
  await git(setup.root, ['-c', 'core.autocrlf=false', 'clone', remote, source]);
  await git(setup.root, ['-c', 'core.autocrlf=false', 'clone', remote, peer]);
  for (const directory of [source, peer]) {
    await git(directory, ['config', 'user.name', '精工 拉取测试']);
    await git(directory, ['config', 'user.email', 'pull@example.invalid']);
    await git(directory, ['config', 'core.autocrlf', 'false']);
  }
  const workspace = await setup.connector.createWorkspace(await setup.connector.register(source), sessionId);
  await setup.connector.push(workspace.path, 'origin');
  await git(peer, ['fetch', 'origin']);
  await git(peer, ['checkout', '-b', workspace.branch, `origin/${workspace.branch}`]);
  const mainHash = (await git(source, ['rev-parse', 'main'])).stdout.trim();
  return { ...setup, source, peer, remote, workspace, mainHash };
}

test('真实 Bare 与两个 clone 拉取同名 agent 分支，仅快进更新 HEAD/索引/文件且禁用 Hook/Filter', async () => {
  const { root, source, peer, remote, workspace, mainHash, connector } = await pullFixture('pull-test');
  try {
    await writeFile(join(peer, 'src', '代码.txt'), '来自第二个 clone 的更新\n');
    await writeFile(join(peer, '远程 新增.txt'), '完整拉取的真实文件\n');
    await rm(join(peer, '删除.txt'));
    await git(peer, ['add', '--all']);
    await git(peer, ['commit', '-m', '远程推进同名 agent 分支']);
    await git(peer, ['push', 'origin', workspace.branch]);
    const remoteHead = (await git(remote, ['rev-parse', `refs/heads/${workspace.branch}`])).stdout.trim();
    await writeFile(join(source, '.git', 'hooks', 'post-merge'), '#!/bin/sh\nprintf HOOK_RAN > pull-hook-ran.txt\n');
    await git(source, ['config', 'filter.poc.smudge', 'sh -c "printf FILTER_RAN > pull-smudge-ran.txt; cat"']);
    await git(source, ['config', 'filter.poc.clean', 'sh -c "printf FILTER_RAN > pull-clean-ran.txt; cat"']);
    await git(source, ['config', 'filter.poc.required', 'true']);
    await git(source, ['config', 'merge.ff', 'false']);
    await git(source, ['config', 'merge.autostash', 'true']);
    await git(source, ['config', '--add', 'remote.origin.fetch', `+refs/heads/${workspace.branch}:refs/heads/main`]);
    const pushOnly = join(root, '仅推送目标.git');
    await git(root, ['init', '--bare', pushOnly]);
    await git(source, ['remote', 'set-url', '--push', 'origin', pushOnly]);
    await connector.pull(workspace.path, 'origin');
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), remoteHead);
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD^'])).stdout.trim(), mainHash);
    assert.equal((await git(workspace.path, ['rev-list', '--parents', '-1', 'HEAD'])).stdout.trim().split(' ').length, 2);
    assert.equal(await readFile(join(workspace.path, 'src', '代码.txt'), 'utf8'), '来自第二个 clone 的更新\n');
    assert.equal(await readFile(join(workspace.path, '远程 新增.txt'), 'utf8'), '完整拉取的真实文件\n');
    await assert.rejects(readFile(join(workspace.path, '删除.txt')), { code: 'ENOENT' });
    assert.equal((await connector.state(workspace.path)).dirty, false);
    assert.equal((await git(workspace.path, ['diff', '--cached', '--name-only'])).stdout, '');
    for (const name of ['pull-hook-ran.txt', 'pull-smudge-ran.txt', 'pull-clean-ran.txt']) await assert.rejects(readFile(join(workspace.path, name)), { code: 'ENOENT' });
    assert.equal((await git(source, ['rev-parse', 'main'])).stdout.trim(), mainHash);
    assert.equal((await git(source, ['branch', '--show-current'])).stdout.trim(), 'main');
    assert.equal(await readFile(join(source, 'src', '代码.txt'), 'utf8'), '原始内容\n');
    assert.equal(await readFile(join(source, '删除.txt'), 'utf8'), '保留原仓库\n');
    assert.equal((await git(workspace.path, ['for-each-ref', '--format=%(refname)', 'refs/jinggong-pull'])).stdout, '');
    await connector.pull(workspace.path, 'origin');
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), remoteHead);
    await assert.rejects(connector.pull(source, 'origin'), /仅允许/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拉取拒绝脏工作区、无同名远程分支与分叉，保留本地文件/提交和源 main', async () => {
  const { root, source, peer, workspace, mainHash, connector } = await pullFixture('pull-guards');
  try {
    const initial = (await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(workspace.path, '未跟踪.txt'), '不可覆盖\n');
    await assert.rejects(connector.pull(workspace.path, 'origin'), /未提交变更/);
    await rm(join(workspace.path, '未跟踪.txt'));
    await writeFile(join(workspace.path, 'src', '代码.txt'), '本地未暂存\n');
    await assert.rejects(connector.pull(workspace.path, 'origin'), /未提交变更/);
    await git(workspace.path, ['add', '--', 'src/代码.txt']);
    await assert.rejects(connector.pull(workspace.path, 'origin'), /未提交变更/);
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), initial);
    const localHead = await connector.commit(workspace.path, { message: '保留本地提交' });
    // 远程落后属于已是最新状态，不回退本地提交。
    await connector.pull(workspace.path, 'origin');
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), localHead);
    await writeFile(join(peer, 'src', '代码.txt'), '独立远程分叉\n');
    await git(peer, ['add', '--all']);
    await git(peer, ['commit', '-m', '远程独立提交']);
    await git(peer, ['push', 'origin', workspace.branch]);
    await assert.rejects(connector.pull(workspace.path, 'origin'), /分叉.*仅快进/);
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), localHead);
    assert.equal(await readFile(join(workspace.path, 'src', '代码.txt'), 'utf8'), '本地未暂存\n');
    assert.equal((await connector.state(workspace.path)).dirty, false);
    assert.equal((await git(workspace.path, ['for-each-ref', '--format=%(refname)', 'refs/jinggong-pull'])).stdout, '');
    const absent = await connector.createWorkspace(await connector.register(source), 'missing-remote-branch');
    await assert.rejects(connector.pull(absent.path, 'origin'), /不存在.*同名/);
    assert.equal((await git(absent.path, ['rev-parse', 'HEAD'])).stdout.trim(), mainHash);
    assert.equal((await git(source, ['rev-parse', 'main'])).stdout.trim(), mainHash);
    assert.equal((await git(source, ['status', '--porcelain'])).stdout, '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拉取复用远程传输安全边界，拒绝危险地址/重写/链接且不泄漏凭据', async () => {
  const { root, source, peer, remote, workspace, mainHash, connector } = await pullFixture('pull-transport');
  try {
    await assert.rejects(connector.pull(workspace.path, '--all'), /名称/);
    await assert.rejects(connector.pull(workspace.path, 'missing'), /不存在/);
    for (const url of ['ext::sh -c echo unsafe', 'file:///C:/unsafe.git', 'http://example.invalid/repo.git', 'https://user:synthetic-password@example.invalid/repo.git', 'ssh://user:synthetic-password@example.invalid/repo.git', 'https://example.invalid/repo.git?token=synthetic-value']) {
      await git(source, ['remote', 'set-url', 'origin', url]);
      await assert.rejects(connector.pull(workspace.path, 'origin'), (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /协议|支持|凭据/);
        assert(!error.message.includes('synthetic-password'));
        assert(!error.message.includes('synthetic-value'));
        return true;
      });
    }
    await git(source, ['remote', 'set-url', 'origin', remote]);
    await git(source, ['config', 'url.ext::unsafe.insteadOf', remote]);
    await assert.rejects(connector.pull(workspace.path, 'origin'), /重写/);
    await git(source, ['config', '--unset-all', 'url.ext::unsafe.insteadOf']);
    await git(source, ['remote', 'set-url', '--add', 'origin', remote]);
    await assert.rejects(connector.pull(workspace.path, 'origin'), /单一/);
    await git(source, ['config', '--unset-all', 'remote.origin.url']);
    await git(source, ['config', 'remote.origin.url', remote]);
    const external = join(root, '外部原件.txt');
    await writeFile(join(peer, 'src', '代码.txt'), '远程更新不得改外部文件\n');
    await git(peer, ['add', '--all']);
    await git(peer, ['commit', '-m', '远程更新']);
    await git(peer, ['push', 'origin', workspace.branch]);
    await writeFile(external, '原始内容\n');
    await rm(join(workspace.path, 'src', '代码.txt'));
    await link(external, join(workspace.path, 'src', '代码.txt'));
    assert.equal((await connector.state(workspace.path)).dirty, false);
    await assert.rejects(connector.pull(workspace.path, 'origin'), /硬链接/);
    assert.equal(await readFile(external, 'utf8'), '原始内容\n');
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), mainHash);
    await git(workspace.path, ['checkout', '-b', 'unmanaged-pull']);
    await assert.rejects(connector.pull(workspace.path, 'origin'), /身份/);
    assert.equal((await git(source, ['rev-parse', 'main'])).stdout.trim(), mainHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('快进拉取不得覆盖本地被忽略文件，HEAD/索引和来源 main 保持原状', async () => {
  const { root, source, peer, workspace, mainHash, connector } = await pullFixture('pull-ignored');
  try {
    await writeFile(join(source, '.git', 'info', 'exclude'), '只在本地.txt\n');
    await writeFile(join(workspace.path, '只在本地.txt'), '用户本地内容\n');
    assert.equal((await connector.state(workspace.path)).dirty, false);
    await writeFile(join(peer, '只在本地.txt'), '远程同路径内容\n');
    await git(peer, ['add', '--', '只在本地.txt']);
    await git(peer, ['commit', '-m', '远程新增同名文件']);
    await git(peer, ['push', 'origin', workspace.branch]);
    await assert.rejects(connector.pull(workspace.path, 'origin'), /被忽略文件/);
    assert.equal(await readFile(join(workspace.path, '只在本地.txt'), 'utf8'), '用户本地内容\n');
    assert.equal((await git(workspace.path, ['rev-parse', 'HEAD'])).stdout.trim(), mainHash);
    assert.equal((await git(workspace.path, ['diff', '--cached', '--name-only'])).stdout, '');
    assert.equal((await git(source, ['rev-parse', 'main'])).stdout.trim(), mainHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});

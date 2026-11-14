import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitConnector } from '../packages/git-connector/src';
import { SessionGitService } from '../apps/desktop/src/main/session-git';
import type { Session } from '../packages/domain/src';

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd, windowsHide: true, encoding: 'utf8' })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-git-'));
  const repo = path.join(root, '项目 A');
  await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', '会话隔离测试']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  const lines = Array.from({ length: 100 }, (_, i) => `原始第 ${i + 1} 行`);
  await writeFile(path.join(repo, '共同文件.txt'), lines.join('\n') + '\n');
  await writeFile(path.join(repo, '删除.txt'), '待删除\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-m', '创建基线']);
  const connector = new GitConnector(path.join(root, 'workspaces'));
  await mkdir(path.join(root, 'workspaces'));
  const project = await connector.register(repo);
  const service = new SessionGitService(connector, path.join(root, 'ledger'));
  const session = (id: string): Session => ({ id, projectId: project.id, title: id, workspacePath: project.path, branch: 'main', status: 'idle', model: '', createdAt: new Date().toISOString() });
  return { root, repo, lines, connector, service, session };
}

test('没有归属记录的历史会话不会显示项目原有修改；同项目任务不能交叉采集', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, '原有.txt'), '原有修改');
    assert.deepEqual((await f.service.prepare(f.session('a'))).diffs, []);
    await f.service.begin(f.session('a'));
    await assert.rejects(f.service.begin(f.session('b')), /同一项目/);
    await f.service.finish(f.session('a'));
    await f.service.begin(f.session('b')); await f.service.finish(f.session('b'));
    assert.deepEqual((await f.service.prepare(f.session('a'))).diffs, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('分会话采集新增、删除和修改；切换与重开后不混入其他会话或任务外修改', async () => {
  const f = await fixture();
  try {
    const a = f.session('a'), b = f.session('b');
    await writeFile(path.join(f.repo, '原有.txt'), '原有未跟踪');
    await f.service.begin(a);
    await writeFile(path.join(f.repo, 'A.txt'), 'A 会话新增');
    await rm(path.join(f.repo, '删除.txt'));
    await f.service.finish(a);
    await f.service.begin(b); await writeFile(path.join(f.repo, 'B.txt'), 'B 会话新增'); await f.service.finish(b);
    await writeFile(path.join(f.repo, '任务之外.txt'), '不属于任何任务');
    const reopened = new SessionGitService(f.connector, path.join(f.root, 'ledger'));
    assert.deepEqual((await reopened.prepare(a)).diffs.map(file => file.path).sort(), ['A.txt', '删除.txt'].sort());
    assert.deepEqual((await reopened.prepare(b)).diffs.map(file => file.path), ['B.txt']);
    assert.deepEqual((await reopened.prepare(f.session('unknown'))).diffs, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('任务执行中的原生文件修改可实时读取，保留原有暂存且不混入其他会话', async () => {
  const f = await fixture();
  try {
    const a = f.session('a'), b = f.session('b');
    await f.service.begin(b);
    await writeFile(path.join(f.repo, 'B.txt'), '其他会话代码');
    await f.service.finish(b);
    await writeFile(path.join(f.repo, '原有暂存.txt'), '任务外代码');
    await git(f.repo, ['add', '原有暂存.txt']);
    const before = await git(f.repo, ['diff', '--cached']);
    await f.service.begin(a);
    assert.deepEqual((await f.service.prepare(a)).diffs, []);
    await writeFile(path.join(f.repo, 'A.txt'), '执行中的第一版');
    assert.deepEqual((await f.service.prepare(a)).diffs.map(file => file.path), ['A.txt']);
    await writeFile(path.join(f.repo, 'A.txt'), '执行中的第二版');
    assert.match((await f.service.prepare(a)).diffs[0].diff, /执行中的第二版/);
    assert.deepEqual((await f.service.prepare(b)).diffs.map(file => file.path), ['B.txt']);
    assert.equal(await git(f.repo, ['diff', '--cached']), before);
    await f.service.finish(a);
    assert.match((await f.service.prepare(a)).diffs[0].diff, /执行中的第二版/);
    assert.equal(await git(f.repo, ['diff', '--cached']), before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('同会话多轮修改合并净差异，重复结束通知不重复记账或释放其他会话任务', async () => {
  const f = await fixture();
  try {
    const a = f.session('a'), b = f.session('b');
    await f.service.begin(a); await writeFile(path.join(f.repo, 'A.txt'), '第一轮\n');
    await Promise.all([f.service.finish(a), f.service.finish(a)]);
    await f.service.begin(a); await writeFile(path.join(f.repo, 'A.txt'), '第二轮\n'); await f.service.finish(a);
    const prepared = await f.service.prepare(a);
    assert.equal(prepared.diffs.length, 1); assert.match(prepared.diffs[0].diff, /第二轮/); assert.doesNotMatch(prepared.diffs[0].diff, /第一轮/);
    await f.service.begin(b); await f.service.finish(a);
    await assert.rejects(f.service.begin(a), /同一项目/);
    await f.service.finish(b);
    const hash = await f.service.commit(a, await f.service.prepare(a), { message: '合并本会话多轮净修改' });
    assert.equal(await git(f.repo, ['show', `${hash}:A.txt`]), '第二轮');
    await f.service.remove(a, [f.repo]);
    assert.equal(await git(f.repo, ['for-each-ref', '--format=%(refname)', 'refs/jinggong/sessions/a/']), '');
    assert.equal(await readFile(path.join(f.repo, 'A.txt'), 'utf8'), '第二轮\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('仅提交本会话文件，保留项目无关已暂存内容、未跟踪文件和其他会话修改', async () => {
  const f = await fixture();
  try {
    const a = f.session('a'), b = f.session('b');
    await writeFile(path.join(f.repo, '原有暂存.txt'), '保留暂存');
    await git(f.repo, ['add', '原有暂存.txt']);
    const stagedBefore = await git(f.repo, ['diff', '--cached', '--binary']);
    await f.service.begin(a); await writeFile(path.join(f.repo, 'A.txt'), 'A 代码'); await f.service.finish(a);
    await f.service.begin(b); await writeFile(path.join(f.repo, 'B.txt'), 'B 代码'); await f.service.finish(b);
    const hash = await f.service.commit(a, await f.service.prepare(a), { message: '提交会话 A 代码' });
    assert.equal(await git(f.repo, ['show', `${hash}:A.txt`]), 'A 代码');
    assert.equal(await git(f.repo, ['diff', '--cached', '--binary']), stagedBefore);
    assert.equal(await git(f.repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', hash]), 'A.txt');
    assert.equal(await readFile(path.join(f.repo, 'B.txt'), 'utf8'), 'B 代码');
    assert.deepEqual((await f.service.prepare(a)).diffs, []);
    assert.deepEqual((await f.service.prepare(b)).diffs.map(file => file.path), ['B.txt']);
    assert.deepEqual((await f.service.state(a)).commits.map(commit => commit.hash), [hash]);
    assert.equal((await f.service.state(a)).dirty, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('同一文件已有修改时按补丁提交本会话独立行，原有修改保留且不进入提交', async () => {
  const f = await fixture();
  try {
    const a = f.session('a');
    const before = [...f.lines]; before[4] = '任务前已有的修改';
    await writeFile(path.join(f.repo, '共同文件.txt'), before.join('\n') + '\n');
    await f.service.begin(a);
    const after = [...before]; after[89] = '仅本会话修改';
    await writeFile(path.join(f.repo, '共同文件.txt'), after.join('\n') + '\n');
    await f.service.finish(a);
    const prepared = await f.service.prepare(a);
    assert.match(prepared.diffs[0].diff, /仅本会话修改/);
    assert.doesNotMatch(prepared.diffs[0].diff, /任务前已有的修改/);
    await assert.rejects(f.service.assertFile(a, '共同文件.txt'), /会话以外/);
    const hash = await f.service.commit(a, prepared, { message: '仅提交本会话独立行' });
    const content = await git(f.repo, ['show', `${hash}:共同文件.txt`]);
    assert.match(content, /仅本会话修改/); assert.doesNotMatch(content, /任务前已有的修改/);
    assert.equal(await readFile(path.join(f.repo, '共同文件.txt'), 'utf8'), after.join('\n') + '\n');
    assert.match(await git(f.repo, ['diff']), /任务前已有的修改/);
    assert.equal(await git(f.repo, ['diff', '--cached']), '');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('已撤回修改不允许以旧快照提交，失败时 HEAD 和真实暂存区不变', async () => {
  const f = await fixture();
  try {
    const a = f.session('a');
    await f.service.begin(a); await writeFile(path.join(f.repo, 'A.txt'), 'A 代码'); await f.service.finish(a);
    const prepared = await f.service.prepare(a), head = await git(f.repo, ['rev-parse', 'HEAD']);
    await rm(path.join(f.repo, 'A.txt'));
    await assert.rejects(f.service.commit(a, prepared, { message: '不应提交旧代码' }), /覆盖或撤回/);
    assert.equal(await git(f.repo, ['rev-parse', 'HEAD']), head);
    assert.equal(await git(f.repo, ['diff', '--cached']), '');
    await f.service.forgetFile(a, 'A.txt');
    assert.deepEqual((await f.service.prepare(a)).diffs, []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('已有暂存内容与本会话同文件重叠时停止提交，不污染索引或分支', async () => {
  const f = await fixture();
  try {
    const a = f.session('a'), before = [...f.lines]; before[4] = '原有已暂存';
    await writeFile(path.join(f.repo, '共同文件.txt'), before.join('\n') + '\n');
    await git(f.repo, ['add', '共同文件.txt']);
    const cached = await git(f.repo, ['diff', '--cached']), head = await git(f.repo, ['rev-parse', 'HEAD']);
    await f.service.begin(a);
    before[89] = '本会话'; await writeFile(path.join(f.repo, '共同文件.txt'), before.join('\n') + '\n'); await f.service.finish(a);
    await assert.rejects(f.service.commit(a, await f.service.prepare(a), { message: '隔离提交' }), /已有暂存内容重叠/);
    assert.equal(await git(f.repo, ['rev-parse', 'HEAD']), head);
    assert.equal(await git(f.repo, ['diff', '--cached']), cached);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('本会话提交可以单独推送到本地远程，项目无关脏文件无需提交', async () => {
  const f = await fixture();
  try {
    const remote = path.join(f.root, 'remote.git'); await git(f.root, ['init', '--bare', remote]);
    await git(f.repo, ['remote', 'add', 'origin', remote]); await git(f.repo, ['push', '-u', 'origin', 'main']);
    const a = f.session('a');
    await writeFile(path.join(f.repo, '原有.txt'), '不可推送');
    await f.service.begin(a); await writeFile(path.join(f.repo, 'A.txt'), 'A 代码'); await f.service.finish(a);
    const hash = await f.service.commit(a, await f.service.prepare(a), { message: '会话独立提交' });
    await f.service.push(a, 'origin');
    assert.equal(await git(remote, ['rev-parse', 'main']), hash);
    assert.equal(await git(remote, ['ls-tree', '--name-only', 'main', '--', '原有.txt']), '');
    assert.equal(await readFile(path.join(f.repo, '原有.txt'), 'utf8'), '不可推送');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('待推送范围含另一会话提交时拒绝推送，远程保持原样', async () => {
  const f = await fixture();
  try {
    const remote = path.join(f.root, 'remote.git'); await git(f.root, ['init', '--bare', remote]);
    await git(f.repo, ['remote', 'add', 'origin', remote]); await git(f.repo, ['push', '-u', 'origin', 'main']);
    const remoteHead = await git(remote, ['rev-parse', 'main']);
    for (const id of ['b', 'a']) {
      const session = f.session(id); await f.service.begin(session); await writeFile(path.join(f.repo, `${id}.txt`), id); await f.service.finish(session);
      await f.service.commit(session, await f.service.prepare(session), { message: `提交会话 ${id}` });
    }
    await assert.rejects(f.service.push(f.session('a'), 'origin'), /其他会话或外部提交/);
    assert.equal(await git(remote, ['rev-parse', 'main']), remoteHead);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('依赖任务前未跟踪文件时可准备整文件提交，保留无关暂存及其他会话文件', async () => {
  const f = await fixture();
  try {
    const a = f.session('a');
    await writeFile(path.join(f.repo, '依赖.txt'), '任务前已有内容\n');
    await writeFile(path.join(f.repo, '无关.txt'), '不能进入提交\n');
    await git(f.repo, ['add', '无关.txt']);
    const cached = await git(f.repo, ['diff', '--cached']);
    await f.service.begin(a);
    await writeFile(path.join(f.repo, '依赖.txt'), '任务前已有内容\n本会话增加内容\n');
    await f.service.finish(a);
    await assert.rejects(f.service.prepare(a), /依赖任务前已有代码/);
    const prepared = await f.service.prepareCommit(a);
    assert.deepEqual(prepared.dependencyFiles, ['依赖.txt']);
    assert.deepEqual(await f.service.diff(a), prepared.diffs);
    const hash = await f.service.commit(a, prepared, { message: '连同依赖提交会话文件' });
    assert.equal(await git(f.repo, ['show', `${hash}:依赖.txt`]), '任务前已有内容\n本会话增加内容');
    assert.equal(await git(f.repo, ['-c', 'core.quotepath=false', 'show', '--format=', '--name-only', hash]), '依赖.txt');
    assert.equal(await git(f.repo, ['diff', '--cached']), cached);
    assert.equal((await f.service.state(a)).dirty, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('原有同文件修改重叠且已暂存时可连同已采集的依赖版本提交', async () => {
  const f = await fixture();
  try {
    const a = f.session('a');
    await writeFile(path.join(f.repo, '共同文件.txt'), '任务前已修改并暂存\n');
    await git(f.repo, ['add', '共同文件.txt']);
    await f.service.begin(a);
    await writeFile(path.join(f.repo, '共同文件.txt'), '本会话继续修改原有代码\n');
    await f.service.finish(a);
    const prepared = await f.service.prepareCommit(a);
    assert.deepEqual(prepared.dependencyFiles, ['共同文件.txt']);
    const hash = await f.service.commit(a, prepared, { message: '提交依赖原有代码的修复' });
    assert.equal(await git(f.repo, ['show', `${hash}:共同文件.txt`]), '本会话继续修改原有代码');
    assert.equal(await git(f.repo, ['diff', '--cached']), '');
    assert.equal(await git(f.repo, ['status', '--porcelain']), '');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('整文件依赖提交拒绝未知暂存版本及撤回后的旧快照，不丢失已有暂存和文件内容', async () => {
  const f = await fixture();
  try {
    const a = f.session('a');
    await writeFile(path.join(f.repo, '依赖.txt'), '原有依赖\n');
    await f.service.begin(a); await writeFile(path.join(f.repo, '依赖.txt'), '会话修复版本\n'); await f.service.finish(a);
    const prepared = await f.service.prepareCommit(a), head = await git(f.repo, ['rev-parse', 'HEAD']);
    await writeFile(path.join(f.repo, '依赖.txt'), '任务后独立暂存版本\n'); await git(f.repo, ['add', '依赖.txt']);
    await writeFile(path.join(f.repo, '依赖.txt'), '会话修复版本\n');
    const cached = await git(f.repo, ['diff', '--cached']);
    await assert.rejects(f.service.commit(a, prepared, { message: '不得覆盖未知暂存' }), /快照之外的暂存修改/);
    assert.equal(await git(f.repo, ['rev-parse', 'HEAD']), head);
    assert.equal(await git(f.repo, ['diff', '--cached']), cached);
    await writeFile(path.join(f.repo, '依赖.txt'), '修复已撤回\n');
    await assert.rejects(f.service.commit(a, prepared, { message: '不得提交旧快照' }), /覆盖或撤回/);
    assert.equal(await git(f.repo, ['rev-parse', 'HEAD']), head);
    assert.equal(await git(f.repo, ['diff', '--cached']), cached);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

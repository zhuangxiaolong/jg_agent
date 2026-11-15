import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { GitConnector } from '../packages/git-connector/src';
import { LocalStore } from '../packages/storage/src';
import { impactReportMarkdown, registerImpactAnalysisIpc } from '../apps/desktop/src/main/impact-analysis-ipc';
import type { ImpactReviewDetail, ImpactReviewRecord } from '../packages/impact-analysis/src/contracts';

const exec = promisify(execFile);
const runGit = (cwd: string, args: string[]) => exec('git', args, { cwd, windowsHide: true });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), '精工影响分析-'));
  const repo = join(root, '代码仓库');
  await mkdir(repo);
  await runGit(repo, ['init', '-b', 'main']);
  await runGit(repo, ['config', 'user.name', '精工测试']);
  await runGit(repo, ['config', 'user.email', 'test@example.invalid']);
  await runGit(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(repo, 'StockRepository.ts'), 'export const stock = 1;\n');
  await runGit(repo, ['add', '.']);
  await runGit(repo, ['commit', '-m', '建立影响分析测试基线']);
  await mkdir(join(root, 'workspaces'));
  const git = new GitConnector(join(root, 'workspaces'));
  const project = await git.register(repo);
  const store = await LocalStore.open(join(root, 'agent.db'));
  store.saveProject(project);
  const handlers = new Map<string, (...args: any[]) => any>();
  let exportPath: string | undefined = join(root, '影响报告.md');
  registerImpactAnalysisIpc({
    handle: (name, handler) => { handlers.set(name, handler); }, store, git,
    project: id => { const value = store.listProjects().find(item => item.id === id); if (!value) throw new Error('项目未授权'); return value; },
    session: id => { const value = store.getSession(String(id)); if (!value) throw new Error('会话不存在'); return value; },
    selectExportPath: async () => exportPath,
  });
  const invoke = <T>(name: string, ...args: unknown[]): Promise<T> => Promise.resolve().then(() => { const handler = handlers.get(name); assert.ok(handler); return handler(...args); });
  return { root, repo, git, project, store, invoke, cancelExport: () => { exportPath = undefined; }, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('真实 Git 变更生成可追溯报告，SQLite 持久化且审查保持只读', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'StockRepository.ts'), 'export const stock = 2;\n');
    await writeFile(join(f.repo, '新增.ts'), 'export const added = true;\n');
    const beforeStatus = (await runGit(f.repo, ['status', '--porcelain'])).stdout;
    const beforeIndex = (await runGit(f.repo, ['diff', '--cached'])).stdout;
    const target = { projectId: f.project.id };
    const result = await f.invoke<ImpactReviewDetail>('impact-review:analyze', target);
    assert.equal(result.report.analysis.files.length, 2);
    assert.equal(result.report.analysis.files.find(item => item.path === 'StockRepository.ts')?.additions, 1);
    assert.match(result.report.diffFingerprint!, /^[a-f0-9]{64}$/);
    assert.equal(result.findings.find(item => item.filePath === 'StockRepository.ts')?.confidence, 'likely');
    assert.equal(result.report.status, 'completed');
    assert.ok(result.report.limitations.some(item => item.includes('未调用 AI')));
    assert.equal(f.store.listImpactReports().length, 1);
    assert.equal(f.store.listReviewFindings(result.report.reviewRunId).length, 2);
    const persisted = await LocalStore.open(join(f.root, 'agent.db'));
    try { assert.equal(persisted.listImpactReports()[0].diffFingerprint, result.report.diffFingerprint); }
    finally { persisted.close(); }
    assert.equal((await runGit(f.repo, ['status', '--porcelain'])).stdout, beforeStatus);
    assert.equal((await runGit(f.repo, ['diff', '--cached'])).stdout, beforeIndex);
    const second = await f.invoke<ImpactReviewDetail>('impact-review:analyze', target);
    assert.ok(second.findings.every(item => item.correlation === 'persisting'));
    assert.ok(second.findings.every(item => item.status === 'open'));
  } finally { await f.close(); }
});

test('忽略或误报必须有理由，代码变化使旧报告过期且不能继续处置', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'StockRepository.ts'), 'export const stock = 2;\n');
    const initial = await f.invoke<ImpactReviewDetail>('impact-review:analyze', { projectId: f.project.id });
    const input = { projectId: f.project.id, reportId: initial.report.id, findingId: initial.findings[0].id };
    await assert.rejects(f.invoke('impact-review:finding-update', { ...input, status: 'ignored' }), /理由/);
    await assert.rejects(f.invoke('impact-review:finding-update', { ...input, status: 'false_positive', reason: ' ' }), /理由/);
    const ignored = await f.invoke<ImpactReviewDetail>('impact-review:finding-update', { ...input, status: 'ignored', reason: '已核对当前接口不受影响' });
    assert.equal(ignored.findings[0].status, 'ignored');
    assert.equal(ignored.findings[0].dispositionReason, '已核对当前接口不受影响');
    assert.equal(f.store.listReviewRuns()[0].findings[0].status, 'ignored');
    await writeFile(join(f.repo, 'StockRepository.ts'), 'export const stock = 3;\n');
    const list = await f.invoke<ImpactReviewRecord[]>('impact-review:list', { projectId: f.project.id });
    assert.equal(list[0].status, 'stale');
    assert.equal(f.store.listReviewRuns()[0].status, 'stale');
    await assert.rejects(f.invoke('impact-review:finding-update', { ...input, status: 'confirmed' }), /重新分析/);
    const next = await f.invoke<ImpactReviewDetail>('impact-review:analyze', { projectId: f.project.id });
    assert.equal(next.findings[0].correlation, 'persisting');
    assert.equal(next.findings[0].status, 'open');
    assert.equal(next.findings[0].dispositionReason, undefined);
  } finally { await f.close(); }
});

test('报告导出使用主进程选择路径并保留过期标记，取消不会写文件', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'StockRepository.ts'), 'export const stock = 2;\n');
    const initial = await f.invoke<ImpactReviewDetail>('impact-review:analyze', { projectId: f.project.id });
    await writeFile(join(f.repo, 'StockRepository.ts'), 'export const stock = 3;\n');
    const result = await f.invoke<{ cancelled: boolean; path: string }>('impact-review:export', { projectId: f.project.id, reportId: initial.report.id });
    assert.equal(result.cancelled, false);
    const markdown = await readFile(result.path, 'utf8');
    assert.match(markdown, /状态：stale/);
    assert.match(markdown, /建议回归（尚未执行）/);
    assert.match(markdown, /不代表构建、测试、人工审查或业务验收已通过/);
    f.cancelExport();
    assert.deepEqual(await f.invoke('impact-review:export', { projectId: f.project.id, reportId: initial.report.id }), { cancelled: true });
    assert.match(impactReportMarkdown(initial), /StockRepository.ts/);
  } finally { await f.close(); }
});

test('IPC 拒绝任意路径和跨项目报告、会话，不泄露其他项目结果', async () => {
  const f = await fixture();
  try {
    const otherId = 'f'.repeat(24);
    f.store.saveProject({ ...f.project, id: otherId, path: join(f.root, '其他项目'), name: '其他项目' });
    await writeFile(join(f.repo, 'StockRepository.ts'), 'export const stock = 2;\n');
    const initial = await f.invoke<ImpactReviewDetail>('impact-review:analyze', { projectId: f.project.id });
    assert.deepEqual(await f.invoke('impact-review:list', { projectId: otherId }), []);
    await assert.rejects(f.invoke('impact-review:detail', { projectId: otherId, reportId: initial.report.id }), /没有此审查报告/);
    await assert.rejects(f.invoke('impact-review:analyze', { projectId: f.project.id, workspacePath: 'C:\\' }), /Unrecognized key/);
    const sessionId = randomUUID();
    f.store.saveSession({ id: sessionId, projectId: otherId, title: '其他项目会话', workspacePath: f.repo, status: 'idle', model: 'test', createdAt: new Date().toISOString() });
    await assert.rejects(f.invoke('impact-review:analyze', { projectId: f.project.id, sessionId }), /不属于当前项目/);
  } finally { await f.close(); }
});

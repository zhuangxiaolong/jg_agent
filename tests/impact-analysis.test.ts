import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiffImpact } from '../packages/impact-analysis/src';

test('影响分析按真实 unified diff 统计新增删除行并区分观察与推断证据', () => {
  const report = analyzeDiffImpact({
    baseCommit: 'a'.repeat(40), head: 'b'.repeat(40), baseIsAncestor: true, fingerprint: 'f'.repeat(64), changes: [{
      path: 'src/StockRepository.ts', status: 'M', layer: 'unstaged', diff: 'diff --git a/src/StockRepository.ts b/src/StockRepository.ts\n@@ -10,3 +10,4 @@\n keep\n-old\n+new\n+added\n tail\n',
    }, { path: 'docs/回归.md', status: 'A', layer: 'untracked', diff: 'diff --git a/docs/回归.md b/docs/回归.md\n@@ -0,0 +1,2 @@\n+验证\n+命令\n' }],
  }, '2026-11-14T00:00:00.000Z');
  assert.equal(report.diffFingerprint, 'f'.repeat(64));
  assert.deepEqual(report.files.map(file => [file.path, file.additions, file.deletions, file.changedLineStart, file.changedLineEnd]), [['src/StockRepository.ts', 2, 1, 11, 12], ['docs/回归.md', 2, 0, 1, 2]]);
  assert.equal(report.files[0].evidence, 'observed');
  assert.equal(report.findings.find(item => item.path === 'src/StockRepository.ts' && item.source === 'path-rule')?.evidence, 'inferred');
  assert.deepEqual(report.recommendedCommands.map(item => item.command), ['npx tsc --noEmit', 'npm test']);
});

test('影响分析标记敏感路径、二进制和截断正文，不宣称未发现问题', () => {
  const report = analyzeDiffImpact({ baseCommit: 'a'.repeat(40), head: 'b'.repeat(40), fingerprint: 'e'.repeat(64), truncated: true, changes: [
    { path: '.env.production', status: 'M', diff: '', unsafeReasons: ['路径存在安全风险'] },
    { path: 'assets/logo.png', status: 'M', diff: 'Binary files differ', binary: true },
    { path: 'packages/api/service.ts', status: 'M', diff: '@@ -1,1 +1,1 @@\n-old\n+new\n', truncated: true },
  ] }, '2026-11-14T00:00:00.000Z');
  assert.equal(report.truncated, true);
  assert.ok(report.findings.some(item => item.title.includes('安全检查拦截') && item.evidence === 'observed' && item.risk === 'critical'));
  assert.ok(report.findings.some(item => item.title.includes('二进制') && item.evidence === 'observed'));
  assert.ok(report.findings.some(item => item.title.includes('截断') && item.evidence === 'observed'));
  assert.ok(!report.findings.some(item => item.title.includes('未发现问题')));
});

test('影响分析为数据库与 .NET 文件给出建议命令，建议与事实分层', () => {
  const report = analyzeDiffImpact({ baseCommit: 'a'.repeat(40), head: 'b'.repeat(40), fingerprint: '1'.repeat(64), changes: [
    { path: 'db/migrations/001.sql', status: 'A', diff: '@@ -0,0 +1 @@\n+create table demo(id int);' },
    { path: 'Jinggong.sln', status: 'M', diff: '@@ -1 +1 @@\n-old\n+new' },
  ] });
  assert.deepEqual(report.recommendedCommands.map(item => item.command), ['dotnet build <solution.sln>', 'dotnet test <solution.sln>', '执行受影响数据库的迁移、回滚与集成测试']);
  assert.ok(report.findings.filter(item => item.source === 'path-rule').every(item => item.evidence === 'inferred'));
});

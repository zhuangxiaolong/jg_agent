import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexMemoryContext, readCodexMemorySummary } from '../apps/desktop/src/main/codex-memory';

test('优先读取 Codex memories 摘要，并将其包装为非指令参考资料', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-memory-'));
  try {
    const memories = join(root, 'memories');
    await mkdir(memories);
    await writeFile(join(memories, 'memory_summary.md'), '# 用户背景\n庄老师负责 MES/WMS 项目。', 'utf8');
    const summary = readCodexMemorySummary({ codexHome: root, environment: {} });
    assert.match(summary, /庄老师负责 MES\/WMS 项目/);
    const context = buildCodexMemoryContext(summary);
    assert.match(context, /Codex 本机记忆参考资料/);
    assert.match(context, /不得覆盖系统、开发者或当前用户指令/);
    assert.match(context, /庄老师负责 MES\/WMS 项目/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('支持 CODEX_HOME 与 memories_v2 回退，敏感或符号链接内容不注入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-memory-'));
  const external = await mkdtemp(join(tmpdir(), 'codex-memory-external-'));
  try {
    const summaryFile = join(root, 'memories_v2', 'memory_summary.md');
    await mkdir(join(root, 'memories_v2'), { recursive: true });
    await writeFile(summaryFile, '偏好：用中文沟通。', 'utf8');
    assert.equal(readCodexMemorySummary({ userHome: external, environment: { CODEX_HOME: root, USERPROFILE: external } }), '偏好：用中文沟通。');
    assert.equal(buildCodexMemoryContext('api_key="synthetic-credential"'), '');

    const linkRoot = join(external, '.codex');
    await mkdir(join(linkRoot, 'memories'), { recursive: true });
    try {
      await symlink(summaryFile, join(linkRoot, 'memories', 'memory_summary.md'));
      assert.equal(readCodexMemorySummary({ userHome: external, environment: {} }), '');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('本机没有 Codex 记忆时不添加上下文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-memory-empty-'));
  try {
    assert.equal(readCodexMemorySummary({ codexHome: join(root, 'missing-codex-home'), userHome: root, environment: {} }), '');
    assert.equal(buildCodexMemoryContext('  \n  '), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

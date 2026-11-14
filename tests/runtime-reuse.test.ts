import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeOptions } from '../packages/agent-runtime/src';
import { codexRuntimeReuseKey } from '../apps/desktop/src/main/runtime-reuse';

test('Codex 复用摘要核对所有静态配置和权限，只允许同能力的新轮回调替换', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-codex-reuse-'));
  try {
    const executable = path.join(root, 'runtime.exe'); await writeFile(executable, '合成组件');
    const options: RuntimeOptions = { executable, home: path.join(root, 'home'), baseUrl: 'https://relay.invalid/v1', model: 'synthetic-model', apiKey: 'synthetic-key', beforeWrite: async () => undefined };
    const cwd = path.join(root, 'workspace'), readAccess = { mode: 'full', directories: [] };
    const key = await codexRuntimeReuseKey(options, cwd, readAccess);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(await codexRuntimeReuseKey({ ...options, beforeWrite: async () => undefined }, cwd, readAccess), key);
    const changes: Partial<RuntimeOptions>[] = [
      { apiKey: 'new-synthetic-key' }, { model: 'other-model' }, { baseUrl: 'https://other.invalid/v1' },
      { reasoningEffort: 'high' }, { developerInstructions: '新的开发要求' }, { shellToolEnabled: false },
      { home: path.join(root, 'other-home') }, { pluginsEnabled: true }, { beforeWrite: undefined },
      { authorizedDirectories: () => ({ mode: 'full', directories: [] }) }, { browser: async () => ({ text: '合成结果' }) },
      { dictionaries: [{ id: 'dict', name: '字典', content: '新字典', digest: 'changed', kind: 'dictionary', system: '通用', enabled: true, createdAt: '2026-11-13T00:00:00Z' }] },
    ];
    for (const change of changes) assert.notEqual(await codexRuntimeReuseKey({ ...options, ...change }, cwd, readAccess), key);
    assert.notEqual(await codexRuntimeReuseKey(options, path.join(root, 'other-workspace'), readAccess), key);
    assert.notEqual(await codexRuntimeReuseKey(options, cwd, { mode: 'restricted', directories: [] }), key);
    await writeFile(executable, '组件内容更新');
    assert.notEqual(await codexRuntimeReuseKey(options, cwd, readAccess), key);
  } finally { await rm(root, { recursive: true, force: true }); }
});

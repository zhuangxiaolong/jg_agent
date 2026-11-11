import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrateLegacyDataRoot } from '../apps/desktop/src/main/data-migration';

test('旧版数据目录迁移只补齐缺失文件并保留目标配置', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-data-migration-'));
  const legacy = join(root, 'legacy');
  const target = join(root, 'target');
  try {
    await mkdir(join(legacy, 'database'), { recursive: true });
    await mkdir(join(legacy, 'config'), { recursive: true });
    await writeFile(join(legacy, 'database', 'jinggong-agent.db'), 'legacy-db');
    await writeFile(join(legacy, 'config', 'model.json'), 'legacy-model');
    await mkdir(join(target, 'config'), { recursive: true });
    await writeFile(join(target, 'config', 'model.json'), 'current-model');
    const first = await migrateLegacyDataRoot({ targetRoot: target, legacyRoots: [legacy] });
    assert.equal(first.source, legacy);
    assert.ok(first.copied.includes(join('database', 'jinggong-agent.db')));
    assert.equal(await readFile(join(target, 'config', 'model.json'), 'utf8'), 'current-model');
    const second = await migrateLegacyDataRoot({ targetRoot: target, legacyRoots: [legacy] });
    assert.deepEqual(second.copied, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

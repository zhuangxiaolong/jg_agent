import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureBundledOperationManuals } from '../apps/desktop/src/main/bundled-operation-manuals';
import { OperationManualLibrary } from '../apps/desktop/src/main/operation-manual-library';
import { LocalStore } from '../packages/storage/src';

test('内置手册清单验证摘要，首次复制索引，重启保留用户停用状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-bundled-manuals-'));
  let store: LocalStore | undefined;
  let library: OperationManualLibrary | undefined;
  try {
    const resources = join(root, 'resources');
    const manualsRoot = join(resources, 'manuals');
    await mkdir(manualsRoot, { recursive: true });
    const entries = [
      { id: 'builtin-operation-manual-imes59', name: 'iMES 5.9 操作手册', productType: 'MES5', path: 'imes.docx' },
      { id: 'builtin-operation-manual-srm', name: 'SRM 操作手册', productType: 'SRM', path: 'srm.docx' },
      { id: 'builtin-operation-manual-jmom', name: 'JMOM 操作手册', productType: 'JMOM', path: 'jmom.docx' },
      { id: 'builtin-operation-manual-pda', name: 'PDA 操作手册', productType: 'PDA', path: 'pda.docx' },
    ] as const;
    const manifestEntries = [];
    for (const entry of entries) {
      const content = Buffer.from(`合成 ${entry.productType} 手册`);
      await writeFile(join(manualsRoot, entry.path), content);
      manifestEntries.push({ ...entry, sha256: createHash('sha256').update(content).digest('hex') });
    }
    await writeFile(join(manualsRoot, 'manifest.json'), JSON.stringify({ version: 'test-v1', manuals: manifestEntries }));
    const workerPath = join(root, 'worker.cjs');
    await writeFile(workerPath, `
      const { parentPort, workerData } = require('node:worker_threads');
      const product = require('node:fs').readFileSync(workerData.filename, 'utf8');
      parentPort.postMessage({ ok: true, document: {
        parserVersion: 'test-parser',
        blocks: [{ type: 'paragraph', text: product, sectionPath: [], locator: { kind: 'text', lineStart: 1, lineEnd: 1 }, order: 0 }],
        extractedChars: product.length,
        warnings: []
      } });
    `);
    store = await LocalStore.open(join(root, 'agent.db'));
    library = new OperationManualLibrary(store, join(root, 'user-data'), workerPath);

    const first = await ensureBundledOperationManuals(library, resources);
    assert.deepEqual(first, { installed: 4, skipped: 0, version: 'test-v1' });
    for (let attempt = 0; attempt < 100 && store.listOperationManualJobs().some(job => job.status !== 'completed'); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(library.list().map(item => item.productType).sort(), ['JMOM', 'MES5', 'PDA', 'SRM']);
    assert.equal(library.list().every(item => item.bundled), true);
    const srm = library.list().find(item => item.productType === 'SRM')!;
    library.setEnabled(srm.id, false);

    const second = await ensureBundledOperationManuals(library, resources);

    assert.deepEqual(second, { installed: 0, skipped: 4, version: 'test-v1' });
    assert.equal(store.getOperationManual(srm.id)?.status, 'disabled');
    assert.equal(library.list().some(item => item.productType === 'MES6'), false);
  } finally {
    await library?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('内置手册文件摘要不匹配时不安装任何文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-bundled-manuals-hash-'));
  let store: LocalStore | undefined;
  let library: OperationManualLibrary | undefined;
  try {
    const resources = join(root, 'resources');
    const manualsRoot = join(resources, 'manuals');
    await mkdir(manualsRoot, { recursive: true });
    const productTypes = ['MES5', 'SRM', 'JMOM', 'PDA'];
    const manifestEntries = [];
    for (let index = 0; index < productTypes.length; index += 1) {
      const content = Buffer.from(`file-${index}`);
      const filename = `manual-${index}.docx`;
      await writeFile(join(manualsRoot, filename), content);
      manifestEntries.push({ id: `builtin-operation-manual-${index}`, name: filename, productType: productTypes[index], path: filename, sha256: createHash('sha256').update(content).digest('hex') });
    }
    manifestEntries[2].sha256 = '0'.repeat(64);
    await writeFile(join(manualsRoot, 'manifest.json'), JSON.stringify({ version: 'test-v1', manuals: manifestEntries }));
    store = await LocalStore.open(join(root, 'agent.db'));
    library = new OperationManualLibrary(store, join(root, 'user-data'), join(root, 'missing-worker.cjs'));

    await assert.rejects(() => ensureBundledOperationManuals(library!, resources), /校验失败/);
    assert.equal(store.listOperationManuals().length, 0);
  } finally {
    await library?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

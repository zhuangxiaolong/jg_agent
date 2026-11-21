import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { OperationManualLibrary } from '../apps/desktop/src/main/operation-manual-library';
import { stageManualIndex } from '../apps/desktop/src/main/manual-index-stage';
import { buildManualChunks, type ManualImportJob, type OperationManual } from '../packages/operation-manuals/src';
import { LocalStore } from '../packages/storage/src';

function createManual(): OperationManual {
  return {
    id: 'manual-recovery', name: 'MES6 工单手册', productType: 'MES6', originalName: '工单手册.md',
    originalStorageKey: 'knowledge/manuals/originals/manual-recovery/工单手册.md', fileExtension: '.md', fileSize: 24,
    sha256: 'a'.repeat(64), status: 'ready', extractedChars: 24, chunkCount: 1,
    createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z',
  };
}

test('新版片段分批写入时查询只读旧版，写入中断并重启后清理未发布索引', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-manual-generations-'));
  const filename = join(root, 'agent.db');
  const staged = join(root, 'new.db');
  let store = await LocalStore.open(filename, undefined, { wal: true });
  let library: OperationManualLibrary | undefined;
  try {
    const manual = createManual();
    const block = { type: 'paragraph' as const, text: '旧版工单报工', sectionPath: [], locator: { kind: 'text' as const, lineStart: 1, lineEnd: 1 }, order: 0 };
    const original = buildManualChunks({ manual, blocks: [block] });
    store.completeOperationManualIndex(manual, original);
    const job: ManualImportJob = { id: 'new-version', manualId: manual.id, status: 'running', stage: 'chunk', progress: 65, updatedAt: manual.createdAt };
    store.saveOperationManualJob(job);
    stageManualIndex(staged, manual, {
      blocks: Array.from({ length: 130 }, (_, i) => ({ ...block, text: '新版仓储' + i, order: i })),
      parserVersion: 'test', extractedChars: 1000, warnings: [],
    });
    let batches = 0;
    const copied = await store.copyManualIndex(manual, staged, job.id, () => {
      assert.deepEqual(store.listOperationManualChunks(manual.id), original);
      assert.deepEqual(store.searchOperationManualChunks(['MES6'], ['仓储']), []);
      return ++batches <= 2;
    });
    assert.equal(copied, false);
    assert.equal(batches, 3);
    store.close();
    store = await LocalStore.open(filename, undefined, { wal: true });
    library = new OperationManualLibrary(store, root, join(root, 'unused.cjs'));
    assert.equal(store.getOperationManualJob(job.id)?.status, 'failed');
    assert.deepEqual(store.listOperationManualChunks(manual.id), original);
    await library.close();
    await store.cleanInactiveManualIndexes(() => false);
    const reader = new DatabaseSync(filename, { readOnly: true });
    try { assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM operation_manual_chunks').get()?.n, 1); }
    finally { reader.close(); }
  } finally { await library?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('应用重启时中断解析任务标记失败，同时保留上一版可检索手册', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-manual-recovery-'));
  let store: LocalStore | undefined;
  try {
    store = await LocalStore.open(join(root, 'agent.db'));
    const manual = createManual();
    const chunks = buildManualChunks({
      manual,
      blocks: [{ type: 'paragraph', text: '工单报工后提交生产记录。', sectionPath: ['生产管理', '工单报工'], locator: { kind: 'text', lineStart: 4, lineEnd: 4 }, order: 0 }],
    });
    store.completeOperationManualIndex(manual, chunks);
    const job: ManualImportJob = {
      id: 'interrupted-job', manualId: manual.id, status: 'running', stage: 'parse', progress: 20,
      startedAt: '2026-11-21T00:01:00.000Z', updatedAt: '2026-11-21T00:01:00.000Z',
    };
    store.saveOperationManualJob(job);

    const library = new OperationManualLibrary(store, root, join(root, 'worker-not-needed.cjs'));

    assert.equal(store.getOperationManualJob(job.id)?.status, 'failed');
    assert.equal(library.list()[0]?.status, 'ready');
    assert.equal(library.search(['MES6'], '工单报工')[0]?.chunk.content, '工单报工后提交生产记录。');
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('导入不支持的文件时返回逐文件错误且不创建手册记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-manual-invalid-'));
  let store: LocalStore | undefined;
  try {
    store = await LocalStore.open(join(root, 'agent.db'));
    const filename = join(root, 'readme.exe');
    await writeFile(filename, 'not a manual');
    const library = new OperationManualLibrary(store, root, join(root, 'worker-not-needed.cjs'));

    const result = await library.importFiles([filename], { productType: 'MES6' });

    assert.equal(result.imported.length, 0);
    assert.equal(result.duplicates.length, 0);
    assert.match(result.errors[0]?.message ?? '', /仅支持/);
    assert.equal(store.listOperationManuals().length, 0);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('批量导入接受每份手册独立的产品分类和版本信息', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-manual-metadata-'));
  let store: LocalStore | undefined;
  let library: OperationManualLibrary | undefined;
  try {
    store = await LocalStore.open(join(root, 'agent.db'));
    const mes5File = join(root, 'mes5.md');
    const wmsFile = join(root, 'wms.md');
    const workerPath = join(root, 'worker.cjs');
    await writeFile(mes5File, '# MES5');
    await writeFile(wmsFile, '# WMS');
    await writeFile(workerPath, `
      const { parentPort } = require('node:worker_threads');
      setTimeout(() => parentPort.postMessage({ ok: true, document: {
        parserVersion: 'test-parser',
        blocks: [{ type: 'paragraph', text: '说明内容。', sectionPath: [], locator: { kind: 'text', lineStart: 1, lineEnd: 1 }, order: 0 }],
        extractedChars: 5,
        warnings: []
      } }), 10);
    `);
    library = new OperationManualLibrary(store, root, workerPath);

    const result = await library.importFiles([
      { filename: mes5File, metadata: { productType: 'MES5', manualVersion: 'V1.2' } },
      { filename: wmsFile, metadata: { productType: 'WMS', manualVersion: 'V3.0' } },
    ]);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const jobs = store.listOperationManualJobs();
      if (jobs.length === 2 && jobs.every(job => job.status === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(store.listOperationManualJobs().every(job => job.status === 'completed'));
    assert.deepEqual(result.imported.map(item => [item.productType, item.manualVersion]), [['MES5', 'V1.2'], ['WMS', 'V3.0']]);
    assert.deepEqual(result.imported.map(item => store!.listOperationManualChunks(item.id)[0]?.productType), ['MES5', 'WMS']);
  } finally {
    await library?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('解析期间修改产品元数据并停用手册，完成后保留用户最新设置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-manual-update-'));
  let store: LocalStore | undefined;
  try {
    store = await LocalStore.open(join(root, 'agent.db'));
    const filename = join(root, 'operation.md');
    const workerPath = join(root, 'worker.cjs');
    await writeFile(filename, '# 工单报工\n提交生产记录。\n');
    await writeFile(workerPath, `
      const { parentPort } = require('node:worker_threads');
      setTimeout(() => parentPort.postMessage({ ok: true, document: {
        parserVersion: 'test-parser',
        blocks: [{ type: 'paragraph', text: '提交生产记录。', sectionPath: ['工单报工'], locator: { kind: 'text', lineStart: 2, lineEnd: 2 }, order: 0 }],
        extractedChars: 7,
        warnings: []
      } }), 100);
    `);
    const library = new OperationManualLibrary(store, root, workerPath);

    const result = await library.importFiles([filename], { productType: 'MES6' });
    const id = result.imported[0]?.id;
    assert.ok(id);
    await library.update(id, { productType: 'WMS', manualVersion: 'V2' });
    library.setEnabled(id, false);

    let job = store.listOperationManualJobs(id)[0];
    for (let attempt = 0; attempt < 100 && job?.status === 'running'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      job = store.listOperationManualJobs(id)[0];
    }

    assert.equal(job?.status, 'completed');
    assert.equal(store.getOperationManual(id)?.status, 'disabled');
    assert.equal(store.getOperationManual(id)?.productType, 'WMS');
    assert.equal(store.getOperationManual(id)?.manualVersion, 'V2');
    assert.equal(store.listOperationManualChunks(id)[0]?.productType, 'WMS');
    assert.equal(library.setEnabled(id, true).status, 'ready');
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('替换手册先解析新文件，成功后原子切换索引，失败时保留原文件和索引', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-manual-replace-'));
  let store: LocalStore | undefined;
  let library: OperationManualLibrary | undefined;
  try {
    store = await LocalStore.open(join(root, 'agent.db'));
    const originalFile = join(root, 'original.md');
    const replacementFile = join(root, 'replacement.md');
    const failedReplacementFile = join(root, 'failed.md');
    const workerPath = join(root, 'worker.cjs');
    await writeFile(originalFile, '第一版工单操作说明');
    await writeFile(workerPath, `
      const { readFileSync } = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      const content = readFileSync(workerData.filename, 'utf8');
      setTimeout(() => {
        if (content.includes('PARSE_FAIL')) parentPort.postMessage({ ok: false, error: '合成解析失败' });
        else parentPort.postMessage({ ok: true, document: {
          parserVersion: 'test-parser',
          blocks: [{ type: 'paragraph', text: content, sectionPath: ['工单操作'], locator: { kind: 'text', lineStart: 1, lineEnd: 1 }, order: 0 }],
          extractedChars: content.length,
          warnings: []
        } });
      }, 50);
    `);
    library = new OperationManualLibrary(store, root, workerPath);
    const imported = await library.importFiles([originalFile], { productType: 'MES6' });
    const manualId = imported.imported[0].id;
    for (let attempt = 0; attempt < 100 && store.listOperationManualJobs(manualId)[0]?.status !== 'completed'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
    const original = store.getOperationManual(manualId)!;
    const originalChunk = store.listOperationManualChunks(manualId)[0];
    assert.ok(originalChunk);

    await writeFile(replacementFile, '第二版工单操作说明');
    const replacementJob = await library.replaceFile(manualId, replacementFile);
    assert.equal(store.getOperationManual(manualId)?.originalStorageKey, original.originalStorageKey);
    assert.equal(store.getOperationManual(manualId)?.pendingReplacement !== undefined, true);
    assert.equal(library.search(['MES6'], '第一版')[0]?.chunk.content, originalChunk.content);
    for (let attempt = 0; attempt < 100 && store.getOperationManualJob(replacementJob.id)?.status !== 'completed'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));

    const replaced = store.getOperationManual(manualId)!;
    assert.equal(store.getOperationManualJob(replacementJob.id)?.status, 'completed');
    assert.notEqual(replaced.sha256, original.sha256);
    assert.equal(replaced.pendingReplacement, undefined);
    assert.match(store.listOperationManualChunks(manualId)[0].content, /第二版/);
    const originalPath = join(root, ...original.originalStorageKey.split('/'));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await access(originalPath); await new Promise(resolve => setTimeout(resolve, 10)); }
      catch { break; }
    }
    await assert.rejects(() => access(originalPath));

    const replacedChunk = store.listOperationManualChunks(manualId)[0];
    await writeFile(failedReplacementFile, 'PARSE_FAIL 第三版');
    const failedJob = await library.replaceFile(manualId, failedReplacementFile);
    for (let attempt = 0; attempt < 100 && store.getOperationManualJob(failedJob.id)?.status !== 'failed'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));

    const afterFailure = store.getOperationManual(manualId)!;
    assert.equal(store.getOperationManualJob(failedJob.id)?.status, 'failed');
    assert.equal(afterFailure.sha256, replaced.sha256);
    assert.equal(afterFailure.originalStorageKey, replaced.originalStorageKey);
    assert.equal(afterFailure.pendingReplacement, undefined);
    assert.deepEqual(store.listOperationManualChunks(manualId), [replacedChunk]);
  } finally {
    await library?.close();
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

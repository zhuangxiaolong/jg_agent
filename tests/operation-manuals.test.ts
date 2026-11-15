import test from 'node:test';
import assert from 'node:assert/strict';
import { createManualRevision, exportManualMarkdown, searchManuals } from '../packages/operation-manuals/src';

test('操作手册按系统隔离检索并保留来源锚点', () => {
  const revision = createManualRevision({
    id: 'rev-1', manualId: 'manual-1', version: 1, title: 'MES5 入库操作', system: 'MES5', status: 'published', createdAt: '2026-11-14T00:00:00.000Z', createdBy: 'import',
    blocks: [{ id: 'block-1', heading: '扫码入库', text: '扫描物料条码后确认入库', order: 1, source: { fileName: '入库手册.docx', digest: 'abc', locator: '第 3 页 / 表 2', text: '扫描物料条码后确认入库' }, needsConfirmation: true }],
  });
  const manual = { id: 'manual-1', system: 'MES5' as const, title: revision.title, status: 'published' as const, activeRevisionId: revision.id, revisions: [revision], createdAt: revision.createdAt, updatedAt: revision.createdAt };
  const hits = searchManuals([manual], 'MES5', '扫码 入库');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].locator, '第 3 页 / 表 2');
  assert.equal(hits[0].needsConfirmation, true);
  assert.equal(searchManuals([manual], 'MES6', '扫码').length, 0);
  const markdown = exportManualMarkdown(revision);
  assert.match(markdown, /待确认/);
  assert.match(markdown, /入库手册\.docx/);
});

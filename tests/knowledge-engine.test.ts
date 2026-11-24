import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { chunkKnowledgeText, isSafeIndexPath, scanCodeRepository, tokenizeKnowledge } from '../packages/knowledge/src';
import { LocalStore } from '../packages/storage/src';

test('代码索引排除构建目录和敏感文件，保留 C# 与 SQL 符号', async () => {
  const root = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), 'jinggong-knowledge-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'bin'), { recursive: true });
    await writeFile(path.join(root, 'src', 'OrderService.cs'), 'public class OrderService { public Task SaveOrder(string id) { return Task.CompletedTask; } }', 'utf8');
    await writeFile(path.join(root, 'src', 'schema.sql'), 'CREATE TABLE IMS_REEL (ID NUMBER);\nCREATE VIEW V_REEL AS SELECT * FROM IMS_REEL;', 'utf8');
    await writeFile(path.join(root, 'src', 'appsettings-secret.json'), '{"password":"do-not-index"}', 'utf8');
    await writeFile(path.join(root, 'bin', 'ignored.cs'), 'public class Ignored {}', 'utf8');
    assert.equal(isSafeIndexPath('src/OrderService.cs'), true);
    assert.equal(isSafeIndexPath('bin/ignored.cs'), false);
    assert.equal(isSafeIndexPath('src/appsettings-secret.json'), false);
    const result = await scanCodeRepository(root, 'project-1', 'code:project-1', 'abc123');
    assert.deepEqual(result.files.map(item => item.relativePath).sort(), ['src/OrderService.cs', 'src/schema.sql']);
    assert.ok(result.symbols.some(item => item.kind === 'class' && item.name === 'OrderService'));
    assert.ok(result.symbols.some(item => item.kind === 'sql-table' && item.name === 'IMS_REEL'));
    assert.ok(result.symbols.every(item => item.commitHash === 'abc123'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('知识片段保留顺序、定位和词项，超长段落按边界切分', () => {
  const chunks = chunkKnowledgeText('doc-1', 'manual.md#L1', 'MES5 过站流程\n\n' + '接口字段与工单状态说明。'.repeat(120), 240);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].ordinal, 0);
  assert.equal(chunks[0].locator, 'manual.md#L1#chunk-1');
  assert.ok(chunks.every(item => item.text.length <= 240));
  assert.ok(tokenizeKnowledge('MES5 工单状态 IMS_REEL').includes('ims_reel'));
});

test('知识来源、文档、项目确认知识和索引任务可持久化并清理旧文档', async () => {
  const root = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), 'jinggong-knowledge-store-'));
  const filename = path.join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  try {
    const now = new Date().toISOString();
    const source = { id: 'code:project-1', kind: 'code_index' as const, name: '项目代码', projectId: 'project-1', status: 'active' as const, trust: 'untrusted_project_data' as const, createdAt: now, updatedAt: now };
    store.saveKnowledgeSource(source);
    const documents = [{ id: 'code:project-1:src/main.cs', sourceId: source.id, kind: 'code' as const, title: 'src/main.cs', locator: 'src/main.cs', contentHash: 'hash-1', projectId: 'project-1', updatedAt: now }];
    store.replaceKnowledgeDocuments(source.id, documents);
    store.replaceKnowledgeChunks(documents[0].id, source.id, 'project-1', chunkKnowledgeText(documents[0].id, documents[0].locator, 'MES5 工单状态'));
    store.saveProjectKnowledge({ id: 'knowledge-1', projectId: 'project-1', title: '接口约定', content: '必须保留来源定位。', source: 'user_confirmed', confirmed: true, createdAt: now, updatedAt: now });
    store.saveKnowledgeIndexJob({ id: 'job-1', sourceId: source.id, status: 'completed', scannedFiles: 1, indexedFiles: 1, updatedAt: now });
    store.replaceKnowledgeDocuments(source.id, []);
    assert.deepEqual(store.listKnowledgeDocuments(source.id), []);
    assert.deepEqual(store.listKnowledgeChunks({ sourceId: source.id }), []);
    store.replaceKnowledgeDocuments(source.id, documents);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.listKnowledgeSources(), [source]);
    assert.equal(store.listProjectKnowledge('project-1')[0].confirmed, true);
    assert.equal(store.listKnowledgeIndexJobs(source.id)[0].status, 'completed');
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

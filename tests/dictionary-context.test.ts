import test from 'node:test';
import assert from 'node:assert/strict';
import { DictionaryBroker } from '../packages/dictionary-context/src';
import { applicableDocuments, buildDeveloperContext } from '../packages/policy/src';
import type { ManagedDocument } from '../packages/domain/src';

function dictionary(id: string, system: ManagedDocument['system'], content: string): ManagedDocument {
  return { id, kind: 'dictionary', system, name: `${system}.xlsx`, content, digest: id, enabled: true, createdAt: '2026-11-04T00:00:00Z' };
}
test('百万字符完整字典可检索尾部内容，按系统隔离且上下文有界', async () => {
  const source = dictionary('mes5', 'MES5', '[工作表：主表]\n' + '已有字段\n'.repeat(210000) + 'LAST_FIELD 尾部真实字段');
  const other = dictionary('mes6', 'MES6', 'OTHER_MES6_FIELD');
  const documents = applicableDocuments([source, other], { system: 'MES5' });
  const broker = new DictionaryBroker(documents);
  const results = await broker.call('search_dictionary', { query: 'LAST_FIELD' }) as any;
  assert.equal(results.totalMatches, 1);
  const content = await broker.call('read_dictionary', { documentId: results.matches[0].documentId, offset: results.matches[0].offset });
  assert.ok(String(content.text).includes('尾部真实字段'));
  assert.equal(content.totalCharacters, source.content.length);
  await assert.rejects(broker.call('read_dictionary', { documentId: 'mes6', offset: 0 }), /当前系统/);
  assert.equal((await broker.call('search_dictionary', { query: 'OTHER_MES6_FIELD' })).totalMatches, 0);
  const context = buildDeveloperContext(documents, []);
  assert.ok(context.length < 10000 && context.includes('search_dictionary') && context.includes(source.name));
  assert.ok(!context.includes(source.content));
});
test('字典片段连续分页可重组全文，转义内容不破坏工具JSON预算', async () => {
  const source = dictionary('common', '通用', '\\"\t'.repeat(12000) + '\n最后一行');
  const broker = new DictionaryBroker([source]);
  let offset: number | null = 0; let combined = '';
  while (offset !== null) {
    const result = await broker.call('read_dictionary', { documentId: 'common', offset, length: 12000 });
    assert.ok(JSON.stringify(result).length <= 24000);
    combined += result.text; offset = result.nextOffset as number | null;
  }
  assert.equal(combined, source.content);
  await assert.rejects(broker.call('search_dictionary', { query: '字段', limit: 99 }), /超出范围/);
  await assert.rejects(broker.call('read_dictionary', { documentId: 'common', offset: -1 }), /超出范围/);
});

test('超长行尾部命中返回可直接读取的实际字符偏移', async () => {
  const source = dictionary('long-row', 'MES5', 'A'.repeat(20000) + 'TAIL_FIELD');
  const broker = new DictionaryBroker([source]);
  const found = await broker.call('search_dictionary', { query: 'TAIL_FIELD' }) as any;
  assert.ok(found.matches[0].offset > 19000);
  const result = await broker.call('read_dictionary', { documentId: source.id, offset: found.matches[0].offset });
  assert.ok(String(result.text).includes('TAIL_FIELD'));
});

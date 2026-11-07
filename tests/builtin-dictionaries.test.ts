import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStore } from '../packages/storage/src';
import { ensureBuiltinDictionaries } from '../apps/desktop/src/main/bundled-dictionaries';

test('启动时幂等加载 MES5、MES6、WMS 内置数据字典', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-builtin-dict-'));
  const store = await LocalStore.open(path.join(root, 'data.db'));
  try {
    const resources = path.resolve('apps/desktop/resources');
    const first = await ensureBuiltinDictionaries(store, resources);
    assert.equal(first.installed, 3);
    assert.deepEqual(store.listDocuments().filter(item => item.kind === 'dictionary').map(item => item.system).sort(), ['MES5', 'MES6', 'WMS']);
    store.setDocumentEnabled('builtin-dictionary-mes5', false);
    const second = await ensureBuiltinDictionaries(store, resources);
    assert.equal(second.installed, 0);
    assert.equal(store.listDocuments().find(item => item.id === 'builtin-dictionary-mes5')?.enabled, false);
    assert.ok(store.listDocuments().find(item => item.id === 'builtin-dictionary-wms')?.content.includes('WMS_STOCK'));
  } finally { store.close(); }
});

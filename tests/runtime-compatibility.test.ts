import test from 'node:test';
import assert from 'node:assert/strict';
import { isGrokModel } from '../packages/domain/src/runtime-compatibility';

test('中转站标识或名称含 Grok 标识时判定为 Grok 模型', () => {
  assert.equal(isGrokModel({ id: 'modelflare_grok', name: '共享中转站' }, 'custom-model'), true);
  assert.equal(isGrokModel({ id: 'provider-1', name: 'Grok Relay', modelCatalog: [] }, 'custom-model'), true);
});

test('模型 ID 或模型目录名称含 Grok 标识时判定为 Grok 模型', () => {
  assert.equal(isGrokModel({ id: 'provider-1', name: '共享中转站' }, 'grok-4.7'), true);
  assert.equal(isGrokModel({ id: 'provider-1', name: '共享中转站', modelCatalog: [{ id: 'model-1', name: 'Grok 4.7' }] }, 'model-1'), true);
});

test('没有 Grok 标识的普通模型保持可用，且不误判普通单词子串', () => {
  assert.equal(isGrokModel({ id: 'provider-1', name: '共享中转站', modelCatalog: [{ id: 'model-1', name: 'Claude 3.5' }] }, 'model-1'), false);
  assert.equal(isGrokModel({ id: 'provider-1', name: 'Grokking Labs' }, 'model-1'), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIpcError, serializePluginIpcFailure } from '../packages/domain/src/ipc';
import { PluginManagerError } from '../packages/plugin-manager/src';

test('插件 IPC 序列化保留统一错误字段并递归脱敏详情', () => {
  const source = new PluginManagerError('PLUGIN_MANIFEST_INVALID', '清单无效 token=secret-value', { file: 'plugin.json', nested: { reason: 'api_key=other-secret' } }, true, '修复配置后重试');
  const failure = serializePluginIpcFailure(source, text => text.replace(/(?:token|api_key)=\S+/gi, '[已脱敏]'));
  assert.deepEqual(failure, {
    ok: false,
    error: '清单无效 [已脱敏]',
    code: 'PLUGIN_MANIFEST_INVALID',
    details: { file: 'plugin.json', nested: { reason: '[已脱敏]' } },
    retryable: true,
    suggestedAction: '修复配置后重试',
  });
});

test('预加载侧恢复结构化 IPC Error，普通旧错误仍兼容 message', () => {
  const structured = createIpcError({ error: '插件未找到', code: 'PLUGIN_NOT_FOUND', details: { pluginId: 'missing' }, retryable: false, suggestedAction: '检查插件 ID' });
  assert.ok(structured instanceof Error);
  assert.equal(structured.message, '插件未找到');
  assert.equal(structured.code, 'PLUGIN_NOT_FOUND');
  assert.deepEqual(structured.details, { pluginId: 'missing' });
  assert.equal(structured.retryable, false);
  assert.equal(structured.suggestedAction, '检查插件 ID');
  assert.equal(createIpcError({ error: '旧 IPC 错误' }).message, '旧 IPC 错误');
});

test('非结构化异常不伪装为插件错误', () => {
  assert.equal(serializePluginIpcFailure(new Error('普通失败'), text => text), undefined);
});

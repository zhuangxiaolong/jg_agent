import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent, SettingsSnapshot } from '../packages/domain/src';
import { grokCompatibilityLabel, pendingRuntimeApprovals, sessionProviderChoices } from '../apps/desktop/src/renderer/grok-ui-state';

const settings = {
  providers: [{ id: 'common', name: '通用站点', baseUrl: 'https://common.invalid/v1', models: ['grok-4.5', 'incompatible', 'new-model'], modelCatalog: [{ id: 'grok-4.5', name: 'Grok 4.5' }], hasKey: true }],
  grok: { runtime: { enabled: true, executablePath: 'C:\\runtime\\grok.exe' }, providers: [{ id: 'common', name: '通用站点', baseUrl: 'https://common.invalid/v1', enabled: true, hasKey: true, models: [{ id: 'grok-4.5', name: 'Grok 4.5', apiBackend: 'chat_completions', enabled: true }, { id: 'incompatible', name: '不兼容', apiBackend: 'responses', enabled: true, compatibility: { status: 'failed', level: 'text', checkedAt: '2026-11-12T00:00:00Z', detail: '协议错误' } }] }] },
} as SettingsSnapshot;

test('Grok 直接列共享中转站及模型，保留协议且验证失败不禁止重新选择', () => {
  const choices = sessionProviderChoices(settings, 'grok_build_acp');
  assert.deepEqual(choices.map(item => item.id), ['common']);
  assert.equal(choices[0].hasKey, true);
  assert.equal(choices[0].baseUrl, settings.providers[0].baseUrl);
  assert.deepEqual(choices[0].models.map(model => [model.id, model.enabled, model.backend]), [['grok-4.5', true, 'chat_completions'], ['incompatible', true, 'responses'], ['new-model', true, 'chat_completions']]);
  assert.equal(choices[0].models[0].name, 'Grok 4.5');
});

test('四种 Runtime 共用模型中转站，没有全局 Grok 设置也可在会话选择模型', () => {
  for (const kind of ['codex', 'jinggong', 'claude_agent_sdk'] as const) assert.deepEqual(sessionProviderChoices(settings, kind).map(item => item.id), ['common']);
  assert.deepEqual(sessionProviderChoices(undefined, 'grok_build_acp'), []);
  const sharedOnly = sessionProviderChoices({ ...settings, grok: undefined }, 'grok_build_acp');
  assert.deepEqual(sharedOnly.map(item => [item.id, item.hasKey]), [['common', true]]);
  assert.ok(sharedOnly[0].models.every(model => model.backend === 'chat_completions'));
  assert.deepEqual(sessionProviderChoices({ ...settings, providers: [] }, 'grok_build_acp'), []);
});

test('Claude Runtime 禁用 Grok 模型，但保留同中转站的兼容模型', () => {
  const choices = sessionProviderChoices(settings, 'claude_agent_sdk');
  assert.deepEqual(choices[0].models.map(model => [model.id, model.enabled, model.unavailableReason]), [
    ['grok-4.5', false, 'claude-grok'],
    ['incompatible', true, undefined],
    ['new-model', true, undefined],
  ]);
  const grokProvider = sessionProviderChoices({ ...settings, providers: [{ ...settings.providers[0], id: 'modelflare_grok', modelCatalog: undefined }] }, 'claude_agent_sdk');
  assert.ok(grokProvider[0].models.every(model => !model.enabled && model.unavailableReason === 'claude-grok'));
});

test('旧版 Grok 全局启用状态和模型列表不限制共享中转站的会话选择', () => {
  const choices = sessionProviderChoices({ ...settings, grok: { ...settings.grok!, runtime: { enabled: false, executablePath: '' }, providers: [] } }, 'grok_build_acp');
  assert.deepEqual(choices.map(item => [item.id, item.hasKey]), [['common', true]]);
  assert.deepEqual(choices[0].models.map(model => model.id), settings.providers[0].models);
  assert.ok(choices[0].models.every(model => model.enabled && model.backend === 'chat_completions'));
});

function event(id: string, sessionId: string, requestId: string, state: 'pending' | 'allowed' | 'rejected' | 'expired'): AgentEvent {
  return { id, sessionId, type: 'approval', text: '审批', createdAt: '2026-11-12T00:00:00Z', approval: { requestId, title: '读取测试文件', toolName: 'read_file', input: '{}', state } };
}

test('只允许当前进程活动会话的待决审批，历史重启状态和其他会话不提供动作', () => {
  const events = [event('1', 'current', 'request1', 'pending'), event('2', 'other', 'request2', 'pending')];
  assert.deepEqual(pendingRuntimeApprovals(events, 'current', true).map(item => item.id), ['1']);
  assert.deepEqual(pendingRuntimeApprovals(events, 'current', false), []);
  assert.deepEqual(pendingRuntimeApprovals(events, '', true), []);
});

test('审批决策和超时会覆盖原请求，迟到的pending通知不会重新开放已决动作', () => {
  for (const state of ['allowed', 'rejected', 'expired'] as const) {
    const events = [event('1', 'current', 'request1', 'pending'), event('2', 'current', 'request1', state), event('3', 'current', 'request1', 'pending')];
    assert.deepEqual(pendingRuntimeApprovals(events, 'current', true), []);
  }
  assert.equal(pendingRuntimeApprovals([event('1', 'current', 'request1', 'pending'), event('2', 'current', 'request2', 'pending')], 'current', true).length, 2);
});

test('仅文本通过和未验证不能显示为Agent兼容，失败优先于级别', () => {
  assert.equal(grokCompatibilityLabel(), '未验证');
  assert.equal(grokCompatibilityLabel({ status: 'passed', level: 'untested' }), '未验证');
  assert.equal(grokCompatibilityLabel({ status: 'passed', level: 'text' }), '仅文本连通已验证');
  assert.equal(grokCompatibilityLabel({ status: 'passed', level: 'agent' }), 'Agent 兼容已验证');
  assert.equal(grokCompatibilityLabel({ status: 'failed', level: 'agent' }), '验证未通过');
});

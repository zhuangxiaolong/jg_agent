import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Session } from '../packages/domain/src';
import { GROK_BUILD_RUNTIME_VERSION, GROK_EXECUTION_RULES_VERSION } from '../packages/agent-runtime/src/grok-config';
import { resolveGrokSessionBinding } from '../apps/desktop/src/main/grok-session-binding';

const provider = { id: 'legacy-default', baseUrl: 'https://relay.invalid/v1' };
const model = { id: 'grok-test', apiBackend: 'chat_completions' as const };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const session: Session = { id: 'session', title: '切换样本', runtimeKind: 'grok_build_acp', providerId: provider.id, model: model.id, status: 'idle', workspacePath: 'C:/fixture', createdAt: '2026-11-13T00:00:00Z' };

test('Grok 新绑定逐代隔离，连续轮次复用同一目录，A→B→A 不复用旧绑定', async () => {
  const a = await resolveGrokSessionBinding('C:/data', session, provider, model, 8);
  assert.match(a.session.grokBinding!, /^[a-f0-9]{64}$/);
  const bound = { ...a.session, runtimeThreadId: 'native-a', runtimeCapabilitiesVersion: 8 };
  const next = await resolveGrokSessionBinding('C:/data', bound, provider, model, 8);
  assert.equal(next.session, bound); assert.equal(next.home, a.home);
  const b = await resolveGrokSessionBinding('C:/data', { ...bound, grokBinding: undefined, runtimeThreadId: undefined }, provider, { ...model, id: 'other-model' }, 8);
  const back = await resolveGrokSessionBinding('C:/data', { ...b.session, grokBinding: undefined }, provider, model, 8);
  assert.notEqual(a.home, b.home); assert.notEqual(a.home, back.home);
  assert.equal(back.session.id, session.id); assert.equal(back.session.workspacePath, session.workspacePath);
});

test('Grok 同 id 地址/协议或能力版本变化时清除旧原生元数据并隔离目录', async () => {
  const a = await resolveGrokSessionBinding('C:/data', session, provider, model, 8);
  const bound = { ...a.session, runtimeThreadId: 'native-a', runtimeNativeSessionId: 'native-a', runtimeVersion: '1.0.67', runtimeCapabilitiesVersion: 8 };
  for (const [p, m, version] of [
    [{ ...provider, baseUrl: 'https://other.invalid/v1' }, model, 8],
    [provider, { ...model, apiBackend: 'responses' as const }, 8],
    [provider, model, 9],
  ] as const) {
    const next = await resolveGrokSessionBinding('C:/data', bound, p, m, version);
    assert.notEqual(next.home, a.home);
    assert.equal(next.session.runtimeThreadId, undefined); assert.equal(next.session.runtimeNativeSessionId, undefined);
    assert.equal(next.session.runtimeCapabilitiesVersion, undefined); assert.equal(next.session.runtimeVersion, undefined);
  }
});

test('Grok 旧绑定只在原指纹与能力版本匹配时继续恢复，地址变更后保留旧目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-grok-binding-'));
  try {
    const legacy = { ...session, grokBinding: digest(provider.id + '\0' + model.id), runtimeThreadId: 'old-native', runtimeCapabilitiesVersion: 8 };
    const home = path.join(root, 'runtime/homes/grok_build_acp', digest(provider.id + '\0' + model.id + '\0' + model.apiBackend).slice(0, 32), session.id);
    await mkdir(home, { recursive: true });
    const marker = JSON.stringify({ owner: 'jinggong-grok', executionRulesVersion: GROK_EXECUTION_RULES_VERSION, fingerprint: digest(JSON.stringify([provider.baseUrl, model.id, model.apiBackend, GROK_BUILD_RUNTIME_VERSION])) });
    await writeFile(path.join(home, 'jinggong-profile.json'), marker);
    const resolved = await resolveGrokSessionBinding(root, legacy, provider, model, 8);
    assert.equal(resolved.home, home); assert.equal(resolved.session, legacy);
    const changed = await resolveGrokSessionBinding(root, legacy, { ...provider, baseUrl: 'https://new.invalid/v1' }, model, 8);
    assert.notEqual(changed.home, home); assert.equal(changed.session.runtimeThreadId, undefined);
    const upgraded = await resolveGrokSessionBinding(root, legacy, provider, model, 9);
    assert.notEqual(upgraded.home, home); assert.equal(upgraded.session.runtimeThreadId, undefined);
    const oldRules = JSON.parse(marker); delete oldRules.executionRulesVersion;
    await writeFile(path.join(home, 'jinggong-profile.json'), JSON.stringify(oldRules));
    const rulesMigrated = await resolveGrokSessionBinding(root, legacy, provider, model, 8);
    assert.notEqual(rulesMigrated.home, home); assert.equal(rulesMigrated.session.runtimeThreadId, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Grok 切项目/分支清线程或启动中断后已有原生绑定目录必须生成新代际', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-grok-rebind-'));
  try {
    const original = await resolveGrokSessionBinding(root, session, provider, model, 8);
    await mkdir(original.home, { recursive: true });
    await writeFile(path.join(original.home, 'jinggong-session.json'), JSON.stringify({ sessionId: 'native-old' }));
    const changedWorkspace = { ...original.session, workspacePath: 'C:/other-workspace', runtimeThreadId: undefined };
    const next = await resolveGrokSessionBinding(root, changedWorkspace, provider, model, 8);
    assert.notEqual(next.home, original.home); assert.notEqual(next.session.grokBinding, original.session.grokBinding);
    assert.equal(next.session.workspacePath, changedWorkspace.workspacePath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

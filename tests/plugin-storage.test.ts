import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalStore } from '../packages/storage/src';
import type { PluginAuditRecord, PluginMcpServerRecord, PluginRecord, PluginSkillRecord, PluginVersionRecord, RuntimePluginBindingRecord, Session, SessionPluginSnapshot } from '../packages/domain/src';

const hash = 'a'.repeat(64);

function plugin(): PluginRecord {
  return {
    id: 'example.plugin', name: '示例插件', version: '1.0.0', description: '用于存储回归测试',
    sourceType: 'folder', manifestPath: 'plugin.json', installPath: 'plugins/example.plugin/1.0.0',
    manifestFormat: 'portable', contentHash: hash, status: 'imported', trustStatus: 'untrusted', enabled: false,
    createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z'
  };
}

test('插件存储增量迁移并持久化脱敏记录，重开后完整恢复关联数据', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-storage-'));
  const filename = join(root, 'agent.db');
  let store = await LocalStore.open(filename);
  try {
    const savedPlugin = plugin();
    const version: PluginVersionRecord = { id: 'example.plugin:1.0.0', pluginId: savedPlugin.id, version: savedPlugin.version, installPath: savedPlugin.installPath, contentHash: hash, installedAt: savedPlugin.createdAt, isActive: true };
    const nextVersion: PluginVersionRecord = { ...version, id: 'example.plugin:1.1.0', version: '1.1.0', installedAt: '2026-11-10T01:00:00.000Z', isActive: true };
    const skill: PluginSkillRecord = { id: 'example.plugin:skill-a', pluginId: savedPlugin.id, name: 'skill-a', description: '只读技能', skillDir: 'skills/skill-a', skillFile: 'skills/skill-a/SKILL.md', contentHash: hash, metadata: { tags: ['safe'] }, enabled: true };
    const mcp: PluginMcpServerRecord = { id: 'example.plugin:mcp-a', pluginId: savedPlugin.id, serverName: 'demo', transport: 'stdio', configRedacted: { transport: 'stdio', command: 'node', args: ['server.js'], envVarNames: ['MCP_ENDPOINT'] }, credentialRefs: ['vault:mcp/demo'], enabled: false, healthStatus: 'unknown' };
    const binding: RuntimePluginBindingRecord = { id: 'example.plugin:codex:default', pluginId: savedPlugin.id, runtimeKind: 'codex', profileId: 'default', installState: 'not-installed' };
    const session: Session = { id: 'plugin-session', projectId: 'plugin-project', title: '插件测试会话', workspacePath: root, branch: 'main', status: 'completed', createdAt: savedPlugin.createdAt, model: 'test-model' };
    const snapshot: SessionPluginSnapshot = { sessionId: session.id, profileId: 'default', profileRevision: 1, runtimeKind: 'codex', effectiveScope: 'session', pluginIds: [savedPlugin.id], skillIds: [skill.id], plugins: [{ pluginId: savedPlugin.id, name: savedPlugin.name, version: savedPlugin.version, contentHash: hash, skillIds: [skill.id], skillNames: [skill.name], mcpServerIds: [mcp.id] }], snapshotHash: hash, createdAt: savedPlugin.createdAt };
    const audit: PluginAuditRecord = { id: 'audit-plugin-1', action: 'import', pluginId: savedPlugin.id, actor: 'user', result: 'success', detailRedacted: { sourceType: 'folder' }, createdAt: savedPlugin.createdAt };

    store.saveProject({ id: session.projectId!, name: '插件项目', path: root, branch: 'main' });
    store.saveSession(session);
    store.savePlugin(savedPlugin); store.savePluginVersion(version); store.savePluginVersion(nextVersion); store.savePluginSkill(skill); store.savePluginMcpServer(mcp); store.saveRuntimePluginBinding(binding); store.saveSessionPluginSnapshot(snapshot); store.appendPluginAudit(audit);
    assert.throws(() => store.saveSessionPluginSnapshot({ ...snapshot, profileRevision: 2, createdAt: '2026-11-10T02:00:00.000Z' }));
    assert.deepEqual(store.getSessionPluginSnapshot(session.id), snapshot);
    assert.equal(store.listPlugins().length, 1);
    assert.deepEqual(store.listPluginSkills(savedPlugin.id), [skill]);
    assert.deepEqual(store.listPluginMcpServers(savedPlugin.id), [mcp]);
    assert.deepEqual(store.getSessionPluginSnapshot(session.id), snapshot);
    assert.deepEqual(store.listPluginAudits(), [audit]);
    store.close(); store = await LocalStore.open(filename);
    assert.deepEqual(store.listPluginVersions(savedPlugin.id).map(item => [item.version, item.isActive]), [['1.1.0', true], ['1.0.0', false]]);
    assert.deepEqual(store.getRuntimePluginBinding(binding.id), binding);
    assert.deepEqual(store.getPluginMcpServer(mcp.id), mcp);
    const bytes = await readFile(filename);
    assert.equal(bytes.includes(Buffer.from('MCP_SECRET_SHOULD_NOT_PERSIST')), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('插件存储拒绝明文凭据和未信任启用，并支持级联删除', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-storage-security-'));
  const filename = join(root, 'agent.db');
  const store = await LocalStore.open(filename);
  try {
    assert.throws(() => store.savePlugin({ ...plugin(), id: 'unsafe.plugin', description: 'apiKey=PLAINTEXT_SECRET' }), /未脱敏凭据/);
    assert.throws(() => store.savePlugin({ ...plugin(), id: 'unsafe-enabled', enabled: true }), /trusted/);
    store.savePlugin(plugin());
    assert.throws(() => store.savePluginMcpServer({ id: 'example.plugin:mcp-secret', pluginId: 'example.plugin', serverName: 'bad', transport: 'streamable-http', configRedacted: { transport: 'streamable-http', url: 'https://example.invalid/mcp?token=PLAINTEXT_SECRET' }, credentialRefs: [], enabled: false, healthStatus: 'unknown' }), /凭据/);
    assert.throws(() => store.savePluginMcpServer({ id: 'example.plugin:mcp-secret-arg', pluginId: 'example.plugin', serverName: 'bad', transport: 'stdio', configRedacted: { transport: 'stdio', command: 'node', args: ['--token=MCP_SECRET_SHOULD_NOT_PERSIST'] }, credentialRefs: [], enabled: false, healthStatus: 'unknown' }), /未脱敏凭据/);
    assert.equal((await readFile(filename)).includes(Buffer.from('MCP_SECRET_SHOULD_NOT_PERSIST')), false);
    store.deletePlugin('example.plugin');
    assert.deepEqual(store.listPlugins(), []);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

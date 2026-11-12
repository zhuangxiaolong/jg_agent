import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginManagerService } from '../apps/desktop/src/main/plugin-manager';
import { LocalStore } from '../packages/storage/src';
import type { RuntimePluginBindingRecord, Session } from '../packages/domain/src';

async function makePlugin(root: string, withMcp = false, pluginName?: string): Promise<string> {
  const plugin = join(root, withMcp ? 'mcp-plugin' : pluginName ?? 'safe-plugin');
  await mkdir(join(plugin, 'skills', 'review', 'references'), { recursive: true });
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ name: withMcp ? 'mcp-helper' : pluginName ?? 'safe-helper', version: '1.0.0', description: 'service test plugin' }));
  await writeFile(join(plugin, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: review files\nmetadata:\n  tags: [safe]\n---\nRead-only review instructions.');
  await writeFile(join(plugin, 'skills', 'review', 'references', 'checklist.md'), 'checklist');
  if (withMcp) await writeFile(join(plugin, 'mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'], env: { API_TOKEN: '${MCP_TOKEN}' } } } }));
  return plugin;
}

test('PluginManagerService 将目录导入受控 Store 并记录 Skill 预览', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-service-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  try {
    const service = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }) });
    const source = await makePlugin(root);
    const imported = await service.importPlugin({ path: source, sourceType: 'folder' });
    assert.equal(imported.plugin.trustStatus, 'untrusted');
    assert.match(imported.plugin.installPath, /plugins[\\/]store[\\/]/);
    assert.equal((await service.listSkills(imported.plugin.id)).length, 1);
    const skill = (await service.listSkills(imported.plugin.id))[0];
    const preview = await service.previewSkill(skill.id);
    assert.equal(preview.truncated, false);
    assert.match(preview.content, /Read-only review instructions/);
    await assert.rejects(() => service.enablePlugin(imported.plugin.id, true), /尚未获得安装信任/);
    await service.trustPlugin(imported.plugin.id, 'install');
    await service.enablePlugin(imported.plugin.id, true);
    assert.equal((await service.getPluginDetail(imported.plugin.id)).plugin.enabled, true);
    assert.equal((await service.validatePlugin(imported.plugin.id)).valid, true);
    assert.equal(await readFile(join(imported.plugin.installPath, 'plugin.json'), 'utf8').then(value => value.includes('service test plugin')), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('PluginManagerService 默认扫描并导入 Codex 缓存插件', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-service-codex-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  try {
    const codexHome = join(root, 'codex-home');
    const source = join(codexHome, 'plugins', 'cache', 'local', 'cached-helper', '1.0.0');
    await mkdir(join(source, '.codex-plugin'), { recursive: true });
    await writeFile(join(source, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'cached-helper', version: '1.0.0', description: 'cached Codex plugin' }));
    await mkdir(join(source, 'skills', 'review'), { recursive: true });
    await writeFile(join(source, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: review\n---\nReview.');
    const service = new PluginManagerService({ store, dataRoot: join(root, 'data'), codexHomes: [codexHome], executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }) });
    const result = await service.importCodexPlugins();
    assert.equal(result.scanned, 1);
    assert.equal(result.imported.length, 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.imported[0].plugin.sourceType, 'local_marketplace');
    assert.equal(result.imported[0].plugin.trustStatus, 'untrusted');
    const second = await service.importCodexPlugins();
    assert.equal(second.scanned, 1);
    assert.equal((await service.listPlugins()).length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('PluginManagerService 对 MCP 凭据引用和主动测试 fail closed', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-service-mcp-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  try {
    const service = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }) });
    const imported = await service.importPlugin({ path: await makePlugin(root, true), sourceType: 'folder' });
    const servers = await service.listMcpServers(imported.plugin.id);
    assert.equal(servers.length, 1);
    assert.deepEqual(servers[0].credentialRefs, ['env:MCP_TOKEN']);
    const health = await service.testMcpServer(servers[0].id);
    assert.equal(health.status, 'unavailable');
    assert.match(health.error ?? '', /HTTP 端到端|主动 MCP/);
    await service.trustPlugin(imported.plugin.id, 'install');
    await service.trustPlugin(imported.plugin.id, 'execute_mcp');
    await assert.rejects(() => service.enablePlugin(imported.plugin.id, true), /凭据引用|脱敏凭据/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('MCP 凭据仅经主进程 Vault 管理，启停状态单独审计且不写入数据库', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-service-mcp-vault-'));
  const database = join(root, 'agent.db');
  const store = await LocalStore.open(database);
  const credentials = new Map<string, string>();
  const vault = {
    has: (reference: string, scope: string) => credentials.has(`${scope}\0${reference}`),
    save: (reference: string, secret: string, scope: string) => { credentials.set(`${scope}\0${reference}`, secret); },
    delete: (reference: string, scope: string) => { credentials.delete(`${scope}\0${reference}`); },
  };
  try {
    const service = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }), credentialVault: vault });
    const imported = await service.importPlugin({ path: await makePlugin(root, true), sourceType: 'folder' });
    await service.trustPlugin(imported.plugin.id, 'install');
    await service.trustPlugin(imported.plugin.id, 'execute_mcp');
    const [server] = await service.listMcpServers(imported.plugin.id);
    await assert.rejects(() => service.setMcpServerEnabled(server.id, true), /凭据尚未配置/);
    await service.saveMcpCredential(server.id, 'env:MCP_TOKEN', 'MCP_SECRET_SHOULD_NEVER_PERSIST');
    await assert.rejects(() => service.saveMcpCredential(server.id, 'env:NOT_DECLARED', 'another-secret'), /不属于该 MCP Server/);
    const saved = (await service.listMcpServers(imported.plugin.id))[0];
    assert.deepEqual(saved.configuredCredentialRefs, ['env:MCP_TOKEN']);
    const bytes = await readFile(database);
    assert.equal(bytes.includes(Buffer.from('MCP_SECRET_SHOULD_NEVER_PERSIST')), false);
    await service.setMcpServerEnabled(server.id, true);
    const enabled = (await service.listMcpServers(imported.plugin.id))[0];
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.healthStatus, 'unknown', '状态切换不能伪报为健康');
    await service.clearMcpCredential(server.id, 'env:MCP_TOKEN');
    const cleared = (await service.listMcpServers(imported.plugin.id))[0];
    assert.equal(cleared.enabled, false, '清除凭据时自动停用 server 管理状态');
    assert.deepEqual(cleared.configuredCredentialRefs, []);
    const audits = store.listPluginAudits({ pluginId: imported.plugin.id, limit: 100 });
    assert.ok(audits.some(item => item.action === 'mcp-enable' && item.result === 'success'));
    assert.ok(audits.some(item => item.action === 'mcp-disable' && item.result === 'success'));
    assert.equal(JSON.stringify(audits).includes('MCP_SECRET_SHOULD_NEVER_PERSIST'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function codexRunner(state: Map<string, Array<Record<string, unknown>>>, options: {
  failRemove?: (home: string) => boolean;
  failPluginAdd?: (home: string, pluginId: string) => boolean;
  failMarketplaceAdd?: (home: string) => boolean;
  failMarketplaceRemove?: (home: string) => boolean;
  malformedList?: (home: string, attempt: number) => boolean;
  sourcePath?: (home: string, pluginId: string) => string;
} = {}) {
  const calls: Array<{ home: string; args: string[] }> = [];
  const listAttempts = new Map<string, number>();
  const runner = async (_executable: string, args: string[], home: string) => {
    calls.push({ home, args });
    if (args[0] === 'plugin' && args[1] === 'list') {
      const attempt = (listAttempts.get(home) ?? 0) + 1; listAttempts.set(home, attempt);
      if (options.malformedList?.(home, attempt)) return { code: 0, stdout: '{bad json', stderr: '' };
      return { code: 0, stdout: JSON.stringify({ installed: state.get(home) ?? [], available: [] }), stderr: '' };
    }
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add' && options.failMarketplaceAdd?.(home)) return { code: 1, stdout: '', stderr: 'simulated marketplace update failure' };
    if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove' && options.failMarketplaceRemove?.(home)) return { code: 1, stdout: '', stderr: '' };
    if (args[0] === 'plugin' && args[1] === 'remove' && options.failRemove?.(home)) return { code: 1, stdout: '', stderr: 'simulated remove failure' };
    let failAfterAdd = false;
    if (args[0] === 'plugin' && args[1] === 'add') {
      const pluginId = args[2];
      const items = state.get(home) ?? [];
      if (!items.some(item => item.pluginId === pluginId)) items.push({ pluginId, name: pluginId.split('@')[0], marketplaceName: 'jinggong-local', version: 'local', installed: true, enabled: true, source: { source: 'local', path: options.sourcePath?.(home, pluginId) ?? join(home, 'marketplace', 'codex-local', 'plugins', pluginId.split('@')[0]) } });
      state.set(home, items);
      failAfterAdd = options.failPluginAdd?.(home, pluginId) ?? false;
    }
    if (args[0] === 'plugin' && args[1] === 'remove') state.set(home, (state.get(home) ?? []).filter(item => item.pluginId !== args[2]));
    if (failAfterAdd) return { code: 1, stdout: '', stderr: 'simulated plugin update failure after partial install' };
    return { code: 0, stdout: '{}', stderr: '' };
  };
  return { runner, calls };
}

async function makeEnabledService(root: string, store: LocalStore, runner: ReturnType<typeof codexRunner>['runner']) {
  const service = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }), commandRunner: runner });
  const imported = await service.importPlugin({ path: await makePlugin(root), sourceType: 'folder' });
  await service.trustPlugin(imported.plugin.id, 'install');
  await service.enablePlugin(imported.plugin.id, true);
  return { service, plugin: imported.plugin };
}

test('首次空 Codex Profile 只读取状态并保留独立空 Home，不卸载未存在的 Marketplace', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-empty-profile-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  const mock = codexRunner(state, { failMarketplaceRemove: () => true });
  try {
    const { service } = await makeEnabledService(root, store, mock.runner);
    const homes: string[] = [];
    for (const id of ['empty-first', 'empty-second']) {
      const session: Session = { id, title: id, workspacePath: root, branch: 'main', status: 'idle', createdAt: new Date().toISOString(), model: 'test' };
      store.saveSession(session);
      const profileId = `session-${session.id}`;
      await service.updateSessionPluginSelection({ sessionId: session.id, profileId, pluginIds: [], skillIds: [] });
      const home = service.homeForProfile(profileId);
      homes.push(home);
      for (let attempt = 0; attempt < 2; attempt++) {
        const sync = await service.syncCodexProfile(profileId);
        assert.equal(sync.profileId, profileId);
        assert.equal(sync.installed, 0);
        assert.deepEqual(sync.errors, []);
      }
      assert.equal((await lstat(home)).isDirectory(), true);
      await assert.rejects(() => lstat(join(home, 'marketplace', 'codex-local')), { code: 'ENOENT' });
      assert.deepEqual(store.listRuntimePluginBindings().filter(binding => binding.profileId === profileId), []);
    }
    assert.notEqual(homes[0], homes[1]);
    assert.equal(mock.calls.length, 4);
    assert.ok(mock.calls.every(call => homes.includes(call.home) && call.args[0] === 'plugin' && call.args[1] === 'list'));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('已有空 Marketplace 的 Codex Profile 仍执行卸载', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-empty-marketplace-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const mock = codexRunner(new Map());
  try {
    const service = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }), commandRunner: mock.runner });
    const home = service.homeForProfile('plugin-manager');
    const marketplace = join(home, 'marketplace', 'codex-local');
    await mkdir(marketplace, { recursive: true });
    const sync = await service.syncCodexProfile('plugin-manager');
    assert.equal(sync.installed, 0);
    assert.ok(mock.calls.some(call => call.home === home && call.args[0] === 'plugin' && call.args[1] === 'marketplace' && call.args[2] === 'remove'));
    await assert.rejects(() => lstat(marketplace), { code: 'ENOENT' });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('已有 Codex Profile 卸载 Marketplace 返回空错误时仍失败并恢复目录与绑定', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-empty-remove-error-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  try {
    const { service, plugin } = await makeEnabledService(root, store, codexRunner(state).runner);
    await service.installForCodex(plugin.id, 'plugin-manager');
    const home = service.homeForProfile('plugin-manager');
    const manifest = join(home, 'marketplace', 'codex-local', '.agents', 'plugins', 'marketplace.json');
    const previousManifest = await readFile(manifest, 'utf8');
    const binding = store.listRuntimePluginBindings(plugin.id).find(item => item.profileId === 'plugin-manager')!;
    const failing = codexRunner(state, { failMarketplaceRemove: profile => profile === home });
    const failingService = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: profile => ({ ...process.env, CODEX_HOME: profile }), commandRunner: failing.runner });

    await assert.rejects(() => failingService.enablePlugin(plugin.id, false), /Codex Marketplace 卸载失败/);
    assert.equal(await readFile(manifest, 'utf8'), previousManifest);
    assert.equal((await failingService.getPluginDetail(plugin.id)).plugin.enabled, true);
    assert.equal(store.getRuntimePluginBinding(binding.id)?.installState, 'installed');
    assert.deepEqual((state.get(home) ?? []).map(item => item.pluginId), [binding.nativePluginId]);
    assert.ok(failing.calls.some(call => call.args[0] === 'plugin' && call.args[1] === 'marketplace' && call.args[2] === 'add'));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex Marketplace 更新失败时恢复旧目录和已安装插件', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-rollback-cli-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  try {
    const base = codexRunner(state);
    const { service, plugin: existing } = await makeEnabledService(root, store, base.runner);
    await service.installForCodex(existing.id, 'plugin-manager');
    const extra = await service.importPlugin({ path: await makePlugin(root, false, 'extra-helper'), sourceType: 'folder' });
    await service.trustPlugin(extra.plugin.id, 'install');
    await service.enablePlugin(extra.plugin.id, true);
    const home = service.homeForProfile('plugin-manager');
    const marketplaceParent = join(home, 'marketplace');
    const marketplaceRoot = join(marketplaceParent, 'codex-local');
    const oldManifest = await readFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8');
    const failing = codexRunner(state, { failPluginAdd: (profile, pluginId) => profile === home && pluginId.startsWith('extra-helper-') });
    const failingService = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: profile => ({ ...process.env, CODEX_HOME: profile }), commandRunner: failing.runner });

    await assert.rejects(() => failingService.syncCodexProfile('plugin-manager'), /simulated plugin update failure/);
    assert.equal(await readFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'), oldManifest);
    assert.equal(await readFile(join(marketplaceRoot, 'plugins', 'safe-helper-' + existing.contentHash.slice(0, 8), 'plugin.json'), 'utf8').then(value => value.includes('safe-helper')), true);
    assert.deepEqual((state.get(home) ?? []).map(item => item.pluginId), [`safe-helper-${existing.contentHash.slice(0, 8)}@jinggong-local`]);
    assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(marketplaceParent)), ['codex-local']);
    assert.equal(store.listRuntimePluginBindings(extra.plugin.id).some(binding => binding.installState === 'installed'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex 插件回读失败时回滚 Marketplace 与部分安装结果', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-rollback-readback-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  try {
    const base = codexRunner(state);
    const { service, plugin: existing } = await makeEnabledService(root, store, base.runner);
    await service.installForCodex(existing.id, 'plugin-manager');
    const extra = await service.importPlugin({ path: await makePlugin(root, false, 'extra-helper'), sourceType: 'folder' });
    await service.trustPlugin(extra.plugin.id, 'install');
    await service.enablePlugin(extra.plugin.id, true);
    const home = service.homeForProfile('plugin-manager');
    const marketplaceRoot = join(home, 'marketplace', 'codex-local');
    const oldManifest = await readFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8');
    const failing = codexRunner(state, { malformedList: (profile, attempt) => profile === home && attempt === 2 });
    const failingService = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: profile => ({ ...process.env, CODEX_HOME: profile }), commandRunner: failing.runner });

    await assert.rejects(() => failingService.syncCodexProfile('plugin-manager'), /无法解析/);
    assert.equal(await readFile(join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8'), oldManifest);
    assert.deepEqual((state.get(home) ?? []).map(item => item.pluginId), [`safe-helper-${existing.contentHash.slice(0, 8)}@jinggong-local`]);
    assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(join(home, 'marketplace'))), ['codex-local']);
    assert.equal(store.listRuntimePluginBindings(extra.plugin.id).some(binding => binding.installState === 'installed'), false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('同一 Codex Profile 的并发同步按 Marketplace 锁串行执行', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-profile-lock-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  let enterMarketplace!: () => void;
  let releaseMarketplace!: () => void;
  const marketplaceEntered = new Promise<void>(resolve => { enterMarketplace = resolve; });
  const marketplaceGate = new Promise<void>(resolve => { releaseMarketplace = resolve; });
  let marketplaceAdds = 0;
  try {
    const setup = await makeEnabledService(root, store, codexRunner(state).runner);
    const session: Session = { id: 'profile-lock', title: 'profile lock', workspacePath: root, branch: 'main', status: 'idle', createdAt: new Date().toISOString(), model: 'test' };
    store.saveSession(session);
    await setup.service.updateSessionPluginSelection({ sessionId: session.id, profileId: `session-${session.id}`, pluginIds: [setup.plugin.id], skillIds: [] });
    const base = codexRunner(state);
    const gatedRunner = async (executable: string, args: string[], home: string) => {
      if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
        marketplaceAdds++;
        if (marketplaceAdds === 1) { enterMarketplace(); await marketplaceGate; }
      }
      return base.runner(executable, args, home);
    };
    const service = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }), commandRunner: gatedRunner });
    const profileId = `session-${session.id}`;
    const first = service.syncCodexProfile(profileId);
    await marketplaceEntered;
    const second = service.syncCodexProfile(profileId);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(marketplaceAdds, 1, '第二次 Marketplace 更新应等待同一 Profile 的锁');
    releaseMarketplace();
    await Promise.all([first, second]);
    assert.equal(marketplaceAdds, 2);
  } finally {
    releaseMarketplace();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex 回读只校准受控 Profile 的已登记绑定，列表异常时保留原状态', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-readback-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  const mock = codexRunner(state);
  try {
    const { service, plugin } = await makeEnabledService(root, store, mock.runner);
    const session: Session = { id: 'readback', title: 'readback', workspacePath: root, branch: 'main', status: 'idle', createdAt: new Date().toISOString(), model: 'test' };
    store.saveSession(session);
    await service.updateSessionPluginSelection({ sessionId: session.id, profileId: `session-${session.id}`, pluginIds: [], skillIds: [] });
    const prior: RuntimePluginBindingRecord = { id: `${plugin.id}:codex:session-${session.id}`, pluginId: plugin.id, runtimeKind: 'codex', profileId: `session-${session.id}`, nativePluginId: 'old-plugin@jinggong-local', installState: 'installed' };
    store.saveRuntimePluginBinding(prior);
    const home = service.homeForProfile(`session-${session.id}`);
    state.set(home, []);
    const sync = await service.syncCodexProfile(`session-${session.id}`);
    assert.equal(sync.installed, 0);
    assert.equal(store.getRuntimePluginBinding(prior.id)?.installState, 'not-installed');
    await service.syncCodexProfile(`session-${session.id}`);
    assert.equal(mock.calls.filter(call => call.args[0] === 'plugin' && call.args[1] === 'marketplace' && call.args[2] === 'remove').length, 2, '有历史绑定的 Profile 不能使用首次空 Profile 的快捷路径');
    assert.ok(mock.calls.every(call => call.home.startsWith(join(root, 'data', 'plugins', 'profiles'))));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('全局禁用只移除 plugin-manager Profile，失败时保留启用状态和会话 Profile', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-disable-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  const mock = codexRunner(state);
  try {
    const { service, plugin } = await makeEnabledService(root, store, mock.runner);
    await service.installForCodex(plugin.id, 'plugin-manager');
    const session: Session = { id: 'freeze-test', title: 'freeze', workspacePath: root, branch: 'main', status: 'idle', createdAt: new Date().toISOString(), model: 'test' };
    store.saveSession(session);
    await service.updateSessionPluginSelection({ sessionId: session.id, profileId: `session-${session.id}`, pluginIds: [plugin.id], skillIds: [] });
    await assert.rejects(() => service.updateSessionPluginSelection({ sessionId: session.id, profileId: `session-${session.id}`, pluginIds: [], skillIds: [] }), /快照已冻结/);
    await service.syncCodexProfile(`session-${session.id}`);
    const sessionBinding = store.listRuntimePluginBindings(plugin.id).find(binding => binding.profileId === `session-${session.id}`)!;
    await service.enablePlugin(plugin.id, false);
    assert.equal((await service.getPluginDetail(plugin.id)).plugin.enabled, false);
    assert.equal(store.getRuntimePluginBinding(sessionBinding.id)?.installState, 'installed');
    assert.equal(state.get(service.homeForProfile(`session-${session.id}`))?.length, 1);
    await service.syncCodexProfile(`session-${session.id}`);
    assert.equal(state.get(service.homeForProfile(`session-${session.id}`))?.length, 1);
    const removalHomes = mock.calls.filter(call => call.args[0] === 'plugin' && call.args[1] === 'remove').map(call => call.home);
    assert.ok(removalHomes.every(home => home === service.homeForProfile('plugin-manager')));

    await service.enablePlugin(plugin.id, true);
    await service.syncCodexProfile('plugin-manager');
    const failingMock = codexRunner(state, { failRemove: home => home === service.homeForProfile('plugin-manager') });
    const failingService = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }), commandRunner: failingMock.runner });
    await assert.rejects(() => failingService.enablePlugin(plugin.id, false), /禁用失败/);
    assert.equal((await failingService.getPluginDetail(plugin.id)).plugin.enabled, true);
    assert.equal(store.getRuntimePluginBinding(sessionBinding.id)?.installState, 'installed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex 列表 JSON 异常不覆盖既有 Runtime binding', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-list-invalid-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  const normal = codexRunner(state);
  try {
    const { service, plugin } = await makeEnabledService(root, store, normal.runner);
    const session: Session = { id: 'bad-json', title: 'bad-json', workspacePath: root, branch: 'main', status: 'idle', createdAt: new Date().toISOString(), model: 'test' };
    store.saveSession(session);
    await service.updateSessionPluginSelection({ sessionId: session.id, profileId: `session-${session.id}`, pluginIds: [], skillIds: [] });
    const binding: RuntimePluginBindingRecord = { id: `${plugin.id}:codex:session-${session.id}`, pluginId: plugin.id, runtimeKind: 'codex', profileId: `session-${session.id}`, nativePluginId: 'existing@jinggong-local', installState: 'installed' };
    store.saveRuntimePluginBinding(binding);
    const broken = codexRunner(state, { malformedList: home => home === service.homeForProfile(`session-${session.id}`) });
    const brokenService = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }), commandRunner: broken.runner });
    await assert.rejects(() => brokenService.syncCodexProfile(`session-${session.id}`), /无法解析/);
    assert.equal(store.getRuntimePluginBinding(binding.id)?.installState, 'installed');
    assert.ok(broken.calls.every(call => call.home === service.homeForProfile(`session-${session.id}`)));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex 列表来源路径不属于受控 Store 时拒绝校准绑定', async () => {
  const root = await mkdtemp(join(process.env.TEMP ?? process.env.TMP ?? '.', 'jinggong-plugin-list-source-'));
  const store = await LocalStore.open(join(root, 'agent.db'));
  const state = new Map<string, Array<Record<string, unknown>>>();
  try {
    const { service, plugin } = await makeEnabledService(root, store, codexRunner(state).runner);
    const session: Session = { id: 'source-check', title: 'source-check', workspacePath: root, branch: 'main', status: 'idle', createdAt: new Date().toISOString(), model: 'test' };
    store.saveSession(session);
    await service.updateSessionPluginSelection({ sessionId: session.id, profileId: `session-${session.id}`, pluginIds: [plugin.id], skillIds: [] });
    const nativePluginId = `safe-helper-${plugin.contentHash.slice(0, 8)}@jinggong-local`;
    const binding: RuntimePluginBindingRecord = { id: `${plugin.id}:codex:session-${session.id}`, pluginId: plugin.id, runtimeKind: 'codex', profileId: `session-${session.id}`, nativePluginId, nativePath: join(root, 'data', 'plugins', 'profiles', `session-${session.id}`, 'marketplace', 'codex-local', 'plugins', nativePluginId.split('@')[0]), installState: 'not-installed' };
    store.saveRuntimePluginBinding(binding);
    const mismatch = codexRunner(state, { sourcePath: () => join(root, 'outside', 'plugin') });
    const guardedService = new PluginManagerService({ store, dataRoot: join(root, 'data'), executable: process.execPath, environment: home => ({ ...process.env, CODEX_HOME: home }), commandRunner: mismatch.runner });
    await assert.rejects(() => guardedService.syncCodexProfile(`session-${session.id}`), /来源与受控绑定不匹配/);
    assert.equal(store.getRuntimePluginBinding(binding.id)?.installState, 'not-installed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});


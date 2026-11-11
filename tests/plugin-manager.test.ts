import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import {
  PluginManagerError,
  createMarketplaceManifest,
  buildCodexPluginCommand,
  inspectPluginArchive,
  parseMcpConfig,
  validateZipArchive,
} from '../packages/plugin-manager/src/index';

const manifest = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'mes-helper', version: '1.0.0', description: 'MES helper', ...extra });

test('解析 Portable Manifest、Skill frontmatter、资源和 Hooks 清单', () => {
  const archive = zipSync({
    'plugin.json': strToU8(manifest()),
    'skills/release/SKILL.md': strToU8('---\nname: release\ndescription: 发布检查\nmetadata: {"owner":"mes"}\n---\n正文'),
    'skills/release/references/checklist.md': strToU8('check'),
    'skills/release/scripts/check.ps1': strToU8('Write-Output check'),
    'hooks/on-install.json': strToU8('{}'),
  });
  const result = inspectPluginArchive(archive);
  assert.equal(result.manifest.sourceManifest, 'portable');
  assert.equal(result.skills[0].name, 'release');
  assert.equal(result.skills[0].resources.length, 2);
  assert.deepEqual(result.hooks, ['hooks/on-install.json']);
  assert.equal(result.executableResources.includes('skills/release/scripts/check.ps1'), true);
});

test('双 Manifest 冲突保留诊断并采用 Portable', () => {
  const archive = zipSync({
    'plugin.json': strToU8(manifest({ description: 'portable' })),
    '.codex-plugin/plugin.json': strToU8(manifest({ description: 'compat' })),
  });
  const result = inspectPluginArchive(archive);
  assert.equal(result.manifest.description, 'portable');
  assert.equal(result.diagnostics.some(item => item.code === 'PLUGIN_MANIFEST_CONFLICT'), true);
});

test('检查结果不保留 Manifest/MCP 明文密钥', () => {
  const archive = zipSync({
    'plugin.json': strToU8(manifest({ apiKey: 'manifest-secret' })),
    'mcp.json': strToU8(JSON.stringify({ mcpServers: { local: { command: 'node', env: { API_TOKEN: 'mcp-secret' } } } })),
  });
  const result = inspectPluginArchive(archive);
  const persistedJson = result.files.filter(file => ['plugin.json', 'mcp.json'].includes(file.path)).map(file => new TextDecoder().decode(file.bytes)).join('\n');
  assert.equal(persistedJson.includes('manifest-secret'), false);
  assert.equal(persistedJson.includes('mcp-secret'), false);
  assert.equal(JSON.stringify(result.manifest).includes('manifest-secret'), false);
  assert.throws(() => inspectPluginArchive(zipSync({ 'plugin.json': strToU8(manifest()), 'mcp.json': strToU8(JSON.stringify({ server: { type: 'streamable-http', url: 'https://mcp.example.invalid/?api_key=secret' } })) })), (error: unknown) => error instanceof PluginManagerError && error.code === 'MCP_CONFIG_INVALID' && !error.message.includes('secret'));
});

test('MCP 仅保留环境变量引用并拒绝远端 HTTP', () => {
  const servers = parseMcpConfig({
    mcpServers: {
      local: { command: 'node', args: ['server.js', '--token', 'secret-cli-value'], env: { API_TOKEN: '${API_TOKEN}', PASSWORD: 'secret-value' } },
      remote: { type: 'streamable-http', url: 'https://mcp.example.invalid', headers: { Authorization: '${MCP_AUTH}' } },
    },
  }, 'mes-helper@1.0.0');
  assert.equal(servers[0].envRefs?.API_TOKEN, 'env:API_TOKEN');
  assert.equal(servers[0].redactedConfig.env && (servers[0].redactedConfig.env as Record<string, unknown>).API_TOKEN, '${API_TOKEN}');
  assert.equal((servers[0].redactedConfig.env as Record<string, unknown>).PASSWORD, '<redacted>');
  assert.deepEqual(servers[0].redactedConfig.args, ['server.js', '--token', '<redacted>']);
  assert.equal(servers[1].httpHeaderRefs?.Authorization, 'env:MCP_AUTH');
  assert.throws(() => parseMcpConfig({ bad: { type: 'streamable-http', url: 'http://remote.invalid' } }, 'p'), (error: unknown) => error instanceof PluginManagerError && error.code === 'MCP_CONFIG_INVALID');
});

test('ZIP 路径穿越和压缩比限制在解压前失败', () => {
  const traversal = zipSync({ '../outside.txt': strToU8('x') });
  assert.throws(() => validateZipArchive(traversal), (error: unknown) => error instanceof PluginManagerError && error.code === 'PLUGIN_PATH_TRAVERSAL_BLOCKED');
  const bomb = zipSync({ 'large.txt': strToU8('a'.repeat(2_000)) });
  assert.throws(() => validateZipArchive(bomb, { maxCompressionRatio: 2 }), (error: unknown) => error instanceof PluginManagerError && error.code === 'PLUGIN_ARCHIVE_LIMIT_EXCEEDED');
});

test('Marketplace JSON 使用受控相对路径并阻止重复插件', () => {
  const marketplace = createMarketplaceManifest([{ name: 'mes-helper' }]);
  assert.equal(marketplace.name, 'jinggong-local');
  assert.deepEqual(marketplace.plugins[0].source, { source: 'local', path: './plugins/mes-helper' });
  assert.throws(() => createMarketplaceManifest([{ name: 'mes-helper' }, { name: 'mes-helper' }]), (error: unknown) => error instanceof PluginManagerError && error.code === 'PLUGIN_DUPLICATE_NAME');
  assert.throws(() => createMarketplaceManifest([{ name: 'bad', relativePath: '../outside' }]), (error: unknown) => error instanceof PluginManagerError && error.code === 'PLUGIN_MANIFEST_INVALID');
});

test('Codex Bridge 命令使用数组参数并拒绝缺失目标', () => {
  assert.deepEqual(buildCodexPluginCommand('plugin-add', 'mes-helper@jinggong-local').args, ['plugin', 'add', 'mes-helper@jinggong-local', '--json']);
  assert.throws(() => buildCodexPluginCommand('marketplace-remove'), (error: unknown) => error instanceof PluginManagerError && error.code === 'PLUGIN_MANIFEST_INVALID');
  assert.throws(() => validateZipArchive(new Uint8Array([1, 2, 3])), (error: unknown) => error instanceof PluginManagerError && error.code === 'PLUGIN_ARCHIVE_INVALID');
});

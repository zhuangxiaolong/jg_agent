import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { verifyRuntimeManifest } from '../apps/desktop/src/main/runtime-integrity';
import { windowsX64Fixture } from './windows-executable-fixture';

const required = [
  'bin/jinggong-runtime.exe', 'bin/codex-code-mode-host.exe', 'codex-path/rg.exe',
  'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe',
  'codex-package.json', 'LICENSE', 'NOTICE', 'BUILD-METADATA.json', 'BUILD-LOG.txt',
];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-manifest-'));
  const files = [];
  for (const relative of required) {
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    const content = Buffer.from(`fixture:${relative}`);
    await writeFile(target, content);
    files.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex') });
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ runtimeId: 'jinggong', runtimeVersion: '0.1.0', files }));
  return root;
}

test('完整清单校验身份、所有必需资源和每个文件哈希', async () => {
  const root = await fixture();
  try {
    assert.equal(verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe').runtimeVersion, '0.1.0');
    await writeFile(path.join(root, 'bin/jinggong-runtime.exe'), 'tampered');
    assert.throws(() => verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'), /完整性校验失败/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('完整性清单保留 Runtime 子目录内自带的 manifest.json', async () => {
  const root = await fixture();
  try {
    const relative = 'codex-resources/voice/manifest.json';
    const target = path.join(root, ...relative.split('/'));
    const content = Buffer.from('{"fixture":true}');
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: Array<{ path: string; sha256: string }> };
    manifest.files.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex') });
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.equal(verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe').runtimeVersion, '0.1.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('拒绝空清单、路径穿越、未列出的文件和缺少运行时辅助程序', async () => {
  const root = await fixture();
  try {
    const manifestPath = path.join(root, 'manifest.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8')) as { runtimeId: string; runtimeVersion: string; files: Array<{ path: string; sha256: string }> };
    await writeFile(manifestPath, JSON.stringify({ ...original, files: [] }));
    assert.throws(() => verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'), /文件列表为空/);
    await writeFile(manifestPath, JSON.stringify({ ...original, files: [...original.files.slice(1), { path: '../outside', sha256: 'a'.repeat(64) }] }));
    assert.throws(() => verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'), /无效路径/);
    await writeFile(manifestPath, JSON.stringify(original));
    await writeFile(path.join(root, 'unlisted.txt'), 'not in manifest');
    assert.throws(() => verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'), /资源不一致/);
    await rm(path.join(root, 'codex-resources/codex-command-runner.exe'));
    await writeFile(manifestPath, JSON.stringify({ ...original, files: original.files.filter(file => file.path !== 'codex-resources/codex-command-runner.exe') }));
    assert.throws(() => verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'), /缺少必需资源/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude Runtime 必须校验原生二进制哈希和资源清单', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-claude-manifest-'));
  try {
    const relative = 'bin/claude.exe';
    const executable = path.join(root, ...relative.split('/'));
    const content = windowsX64Fixture();
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, content);
    const manifest = {
      runtimeId: 'claude_agent_sdk',
      runtimeVersion: '2.1.319',
      sdkVersion: '0.3.319',
      files: [{ path: relative, sha256: createHash('sha256').update(content).digest('hex') }],
    };
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));

    assert.equal(verifyRuntimeManifest(root, 'claude_agent_sdk', relative).runtimeVersion, '2.1.319');
    await writeFile(executable, 'tampered');
    assert.throws(() => verifyRuntimeManifest(root, 'claude_agent_sdk', relative), /完整性校验失败/);
    await writeFile(executable, content);
    await writeFile(path.join(root, 'extra.dll'), 'unlisted');
    assert.throws(() => verifyRuntimeManifest(root, 'claude_agent_sdk', relative), /资源不一致/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Claude Runtime 即使清单哈希匹配也拒绝被截断的可执行文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-claude-truncated-'));
  try {
    const content = windowsX64Fixture().subarray(0, 600);
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin/claude.exe'), content);
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      runtimeId: 'claude_agent_sdk', runtimeVersion: '2.1.319',
      files: [{ path: 'bin/claude.exe', sha256: createHash('sha256').update(content).digest('hex') }],
    }));
    assert.throws(() => verifyRuntimeManifest(root, 'claude_agent_sdk', 'bin/claude.exe'), /文件可能被截断/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

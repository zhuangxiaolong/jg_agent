import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { verifyRuntimeManifest, verifyRuntimeManifestAsync } from '../apps/desktop/src/main/runtime-integrity';
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

test('异步完整性验证与同步结果一致，保留全部资源及清单元数据', async () => {
  const root = await fixture();
  try {
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.upstreamCommit = 'fixture-commit'; manifest.buildNumber = 'fixture-build';
    manifest.capabilitiesVersion = 7; manifest.sandbox = 'unverified';
    const relative = 'codex-resources/voice/manifest.json';
    const content = Buffer.from('{"fixture":true}');
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
    manifest.files.push({ path: relative, sha256: createHash('sha256').update(content).digest('hex') });
    await writeFile(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(await verifyRuntimeManifestAsync(root, 'jinggong', 'bin/jinggong-runtime.exe'), verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('异步完整性验证拒绝错误身份、空清单、非法路径、重复项和遗漏资源', async () => {
  const root = await fixture();
  try {
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const cases = [
      { value: { ...manifest, runtimeId: 'codex' }, error: /身份或版本无效/ },
      { value: { ...manifest, files: [] }, error: /文件列表为空/ },
      { value: { ...manifest, files: [...manifest.files, { path: '../outside', sha256: 'a'.repeat(64) }] }, error: /无效路径/ },
      { value: { ...manifest, files: [...manifest.files, manifest.files[0]] }, error: /重复文件/ },
      { value: { ...manifest, files: manifest.files.slice(1) }, error: /缺少必需资源/ },
    ];
    for (const item of cases) {
      await writeFile(manifestPath, JSON.stringify(item.value));
      assert.throws(() => verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'), item.error);
      await assert.rejects(verifyRuntimeManifestAsync(root, 'jinggong', 'bin/jinggong-runtime.exe'), item.error);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyRuntimeManifestAsync(root, 'jinggong', 'missing.exe'), /入口未列入/);
    await writeFile(path.join(root, 'unlisted.txt'), 'not in manifest');
    await assert.rejects(verifyRuntimeManifestAsync(root, 'jinggong', 'bin/jinggong-runtime.exe'), /资源不一致/);
    await rm(path.join(root, 'unlisted.txt'));
    await writeFile(path.join(root, 'bin/jinggong-runtime.exe'), 'tampered');
    await assert.rejects(verifyRuntimeManifestAsync(root, 'jinggong', 'bin/jinggong-runtime.exe'), /完整性校验失败/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('异步验证拒绝目录联接或符号链接，不跟随安装目录外资源', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'jinggong-runtime-linked-'));
  try {
    await writeFile(path.join(outside, 'outside.txt'), 'outside');
    const linked = path.join(root, 'linked');
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyRuntimeManifest(root, 'jinggong', 'bin/jinggong-runtime.exe'), /符号链接/);
    await assert.rejects(verifyRuntimeManifestAsync(root, 'jinggong', 'bin/jinggong-runtime.exe'), /符号链接/);
    await assert.rejects(verifyRuntimeManifestAsync(linked, 'jinggong', 'bin/jinggong-runtime.exe'), /符号链接/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('异步Claude PE校验与同步规则一致，匹配哈希也不能接受损坏或截断的二进制', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jinggong-claude-async-manifest-'));
  try {
    await mkdir(path.join(root, 'bin'));
    const relative = 'bin/claude.exe';
    const valid = windowsX64Fixture();
    const noMz = Buffer.from(valid); noMz.writeUInt16LE(0, 0);
    const wrongMachine = Buffer.from(valid); wrongMachine.writeUInt16LE(0x14c, wrongMachine.readUInt32LE(0x3c) + 4);
    const cases = [
      { content: valid, error: undefined },
      { content: noMz, error: /缺少 MZ 头/ },
      { content: wrongMachine, error: /不是 Windows x64/ },
      { content: valid.subarray(0, 600), error: /文件可能被截断/ },
    ];
    for (const item of cases) {
      await writeFile(path.join(root, relative), item.content);
      await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ runtimeId: 'claude_agent_sdk', runtimeVersion: '2.1.319', files: [{ path: relative, sha256: createHash('sha256').update(item.content).digest('hex') }] }));
      if (item.error) {
        assert.throws(() => verifyRuntimeManifest(root, 'claude_agent_sdk', relative), item.error);
        await assert.rejects(verifyRuntimeManifestAsync(root, 'claude_agent_sdk', relative), item.error);
      } else assert.deepEqual(await verifyRuntimeManifestAsync(root, 'claude_agent_sdk', relative), verifyRuntimeManifest(root, 'claude_agent_sdk', relative));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

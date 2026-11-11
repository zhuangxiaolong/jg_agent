import path from 'node:path';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateWindowsX64Executable } from './windows-executable.mjs';

const codexSource = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc');
const runtimeRoot = path.resolve('apps/desktop/resources/runtime');
const codexTarget = path.resolve('apps/desktop/resources/runtime/codex');
const jinggongTarget = path.resolve('apps/desktop/resources/runtime/jinggong');
const claudeSource = path.resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe');
const claudeTarget = path.resolve(runtimeRoot, 'claude_agent_sdk');
const pkg = JSON.parse(await readFile('node_modules/@openai/codex/package.json', 'utf8'));
if (pkg.version !== '0.156.1' || pkg.license !== 'Apache-2.0') throw new Error('运行时版本或许可证与锁定值不符');
if (!existsSync(path.join(jinggongTarget, 'bin/jinggong-runtime.exe')) || !existsSync(path.join(jinggongTarget, 'manifest.json'))) throw new Error('未找到独立 Jinggong Runtime，请先执行 npm run runtime:build:jinggong');

const claudeSdkPackage = JSON.parse(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));
const lockfile = JSON.parse(await readFile('package-lock.json', 'utf8'));
const lockedClaudeBinary = lockfile.packages?.['node_modules/@anthropic-ai/claude-agent-sdk-win32-x64'];
if (claudeSdkPackage.version !== '0.3.319'
  || claudeSdkPackage.optionalDependencies?.['@anthropic-ai/claude-agent-sdk-win32-x64'] !== claudeSdkPackage.version
  || lockedClaudeBinary?.version !== claudeSdkPackage.version
  || !existsSync(claudeSource)) {
  throw new Error('Claude SDK 与 Windows x64 native binary 缺失或版本不匹配');
}
const claudeSdkManifest = JSON.parse(await readFile('node_modules/@anthropic-ai/claude-agent-sdk/manifest.json', 'utf8'));
if (claudeSdkManifest.version !== claudeSdkPackage.claudeCodeVersion) throw new Error('Claude SDK manifest 与锁定的 Claude Code Binary 版本不匹配');
const claudeBinary = await readFile(claudeSource);
validateWindowsX64Executable(claudeBinary);
if (process.platform === 'win32') {
  const probe = spawnSync(claudeSource, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== `${claudeSdkPackage.claudeCodeVersion} (Claude Code)`) {
    throw new Error(`Claude Binary 启动校验失败，请重新安装锁定的 native 包：${probe.error?.message ?? probe.stderr?.trim() ?? '版本不匹配'}`);
  }
}

const jinggongPackageMetadata = JSON.parse(await readFile(path.join(jinggongTarget, 'codex-package.json'), 'utf8'));
for (const [key, expected] of Object.entries({ layoutVersion: 1, version: '0.1.0', target: 'x86_64-pc-windows-msvc', variant: 'codex', entrypoint: 'bin/jinggong-runtime.exe', resourcesDir: 'codex-resources', pathDir: 'codex-path' })) {
  if (jinggongPackageMetadata[key] !== expected) throw new Error(`Jinggong Runtime 的 package metadata 不完整：${key}`);
}
const jinggongManifest = JSON.parse(await readFile(path.join(jinggongTarget, 'manifest.json'), 'utf8'));
const jinggongFiles = new Map(jinggongManifest.files.map(item => [item.path, item.sha256]));
const requiredJinggongFiles = [
  'bin/jinggong-runtime.exe',
  'bin/codex-code-mode-host.exe',
  'codex-path/rg.exe',
  'codex-resources/codex-command-runner.exe',
  'codex-resources/codex-windows-sandbox-setup.exe',
  'codex-package.json',
  'LICENSE',
  'NOTICE',
  'BUILD-METADATA.json',
  'BUILD-LOG.txt',
];
if (jinggongFiles.size !== jinggongManifest.files.length) throw new Error('Jinggong Runtime manifest 含重复文件路径');
for (const relative of requiredJinggongFiles) if (!jinggongFiles.has(relative)) throw new Error(`Jinggong Runtime manifest 缺少 ${relative}`);
for (const [relative, expectedHash] of jinggongFiles) {
  const file = path.resolve(jinggongTarget, ...relative.split('/'));
  if (!file.startsWith(`${jinggongTarget}${path.sep}`) || !existsSync(file)) throw new Error(`Jinggong Runtime manifest 路径无效：${relative}`);
  const actualHash = createHash('sha256').update(await readFile(file)).digest('hex');
  if (actualHash !== expectedHash) throw new Error(`Jinggong Runtime manifest 哈希不匹配：${relative}`);
}

// Copy into existing destinations without clearing user or previously staged resources.
await mkdir(codexTarget, { recursive: true });
await cp(codexSource, codexTarget, { recursive: true });
await cp('node_modules/@openai/codex/README.md', path.join(codexTarget, 'README.md'));
for (const [name, expected] of [
  ['LICENSE', 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc'],
  ['NOTICE', '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915'],
]) {
  const content = await readFile(path.join('installer/licenses', `codex-${name}`));
  if (createHash('sha256').update(content).digest('hex') !== expected) throw new Error(`Codex ${name} 校验失败`);
  await writeFile(path.join(codexTarget, name), content);
}

async function scan(directory, relative = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const file = path.join(relative, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) files.push(...await scan(absolute, file));
    else if (file !== 'manifest.json') files.push({ path: file, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
  }
  return files;
}

const codexFiles = await scan(codexTarget);
await writeFile(path.join(codexTarget, 'manifest.json'), JSON.stringify({ runtimeId: 'codex', runtimeVersion: pkg.version, buildNumber: pkg.version, license: pkg.license, source: 'https://registry.npmjs.org/@openai/codex', protocol: 'app-server-stdio-jsonl', capabilitiesVersion: 5, sandbox: 'unverified', files: codexFiles }, null, 2));

await mkdir(path.join(claudeTarget, 'bin'), { recursive: true });
await writeFile(path.join(claudeTarget, 'bin', 'claude.exe'), claudeBinary);
const claudeFiles = [{ path: 'bin/claude.exe', sha256: createHash('sha256').update(claudeBinary).digest('hex') }];
await writeFile(path.join(claudeTarget, 'manifest.json'), JSON.stringify({
  runtimeId: 'claude_agent_sdk',
  runtimeVersion: claudeSdkPackage.claudeCodeVersion,
  sdkVersion: claudeSdkPackage.version,
  upstreamCommit: claudeSdkManifest.commit,
  binarySize: claudeBinary.length,
  capabilitiesVersion: 5,
  sandbox: 'unverified',
  files: claudeFiles,
}, null, 2));

const runtimeManifest = { schemaVersion: 1, runtimes: {
  codex: { path: 'codex', manifest: 'codex/manifest.json', runtimeVersion: pkg.version },
  jinggong: { path: 'jinggong', manifest: 'jinggong/manifest.json', runtimeVersion: jinggongManifest.runtimeVersion, upstreamCommit: jinggongManifest.upstreamCommit },
  claude_agent_sdk: { path: 'claude_agent_sdk', manifest: 'claude_agent_sdk/manifest.json', runtimeVersion: claudeSdkPackage.claudeCodeVersion, sdkVersion: claudeSdkPackage.version },
} };
await writeFile(path.resolve('apps/desktop/resources/runtime/runtime-manifest.json'), JSON.stringify(runtimeManifest, null, 2));
console.log(`已准备三类 Runtime 资源：Codex ${pkg.version}，Jinggong ${jinggongManifest.runtimeVersion}（上游 ${jinggongManifest.upstreamCommit}），Claude Agent SDK ${claudeSdkPackage.version} / Binary ${claudeSdkPackage.claudeCodeVersion}`);

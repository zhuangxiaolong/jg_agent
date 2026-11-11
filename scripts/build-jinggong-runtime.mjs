import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, cp, readdir, stat, lstat, rename, symlink, utimes, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const upstreamSha = '81e8e29b2956dfe9b092c63953a9ed282781e77c';
const upstreamTag = 'rust-v0.156.1';
const upstreamArchiveSha256 = 'cd1e3d063dcf5e029815b7bb178c9017221ddd12bd49b879b14c1f4b09219a02';
const runtimeVersion = '0.1.0';
const licenseSha256 = 'd17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc';
const noticeSha256 = '9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915';
const targetTriple = 'x86_64-pc-windows-msvc';
const buildRoot = path.resolve('.runtime-build');
const cargoTarget = path.join(buildRoot, 'cargo-target');
const v8ArtifactRoot = path.join(buildRoot, 'v8-artifacts');
const forkPatch = path.resolve('patches/0001-jinggong-runtime-identity.patch');
const sourceRoot = path.join(buildRoot, 'jinggong-source');
const archive = path.join(buildRoot, `${upstreamTag}.tar.gz`);
const outputRoot = path.resolve('apps/desktop/resources/runtime/jinggong');
const sourceUrl = `https://codeload.github.com/openai/codex/tar.gz/refs/tags/${upstreamTag}`;
const timestamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const buildLog = path.join(buildRoot, `jinggong-build-${timestamp}.log`);

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function run(command, args, options = {}) {
  const { stdout = '', stderr = '' } = await execFileAsync(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
  return `${stdout}${stderr}`;
}

async function downloadArchive() {
  await mkdir(buildRoot, { recursive: true });
  if (!existsSync(archive)) {
    await run('curl.exe', ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '--output', archive, sourceUrl]);
  }
  const actual = await sha256(archive);
  if (actual !== upstreamArchiveSha256) throw new Error(`上游源码归档 SHA256 不匹配：${actual}`);
}

function assertBuildPath(candidate) {
  const relative = path.relative(buildRoot, path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`构建路径超出工作区：${candidate}`);
}

async function preserveCargoCache() {
  assertBuildPath(sourceRoot);
  assertBuildPath(cargoTarget);
  for (const entry of existsSync(sourceRoot) ? await readdir(sourceRoot, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !entry.name.startsWith('codex-')) continue;
    const legacyTarget = path.join(sourceRoot, entry.name, 'codex-rs/target');
    if (!existsSync(legacyTarget)) continue;
    assertBuildPath(legacyTarget);
    if ((await lstat(legacyTarget)).isSymbolicLink()) continue;
    if (existsSync(cargoTarget)) throw new Error('旧源码及独立缓存均包含 Cargo target，拒绝删除其中任何一份；请先人工确认缓存');
    await rename(legacyTarget, cargoTarget);
    console.log(`已保留现有 Cargo 缓存：${cargoTarget}`);
  }
  if (existsSync(cargoTarget) && (await lstat(cargoTarget)).isSymbolicLink()) throw new Error('Cargo 缓存不能是符号链接或 junction');
  await mkdir(cargoTarget, { recursive: true });
}

async function sourceFileTimes(source, directory = source, relative = '') {
  const preserved = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      const nested = await sourceFileTimes(source, absolute, childRelative);
      for (const [file, value] of nested) preserved.set(file, value);
    } else if (entry.isFile()) {
      preserved.set(childRelative, { hash: await sha256(absolute), stat: await stat(absolute) });
    }
  }
  return preserved;
}

async function extractSource() {
  assertBuildPath(sourceRoot);
  const previous = existsSync(sourceRoot) ? (await readdir(sourceRoot, { withFileTypes: true })).find(entry => entry.isDirectory() && entry.name.startsWith('codex-')) : undefined;
  // Cargo fingerprints use source mtimes. Preserve them for content-identical files
  // so a clean archive extraction does not invalidate the complete local-crate cache.
  const preserved = previous ? await sourceFileTimes(path.join(sourceRoot, previous.name)) : new Map();
  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });
  // GitHub tarball contains one top-level directory. The exclude avoids a Windows
  // tar path normalization error in the vendored Linux-only bubblewrap license.
  await run('tar.exe', ['-xzf', archive, '-C', sourceRoot, '--exclude=*vendor/bubblewrap/LICENSE']);
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const extracted = entries.find(entry => entry.isDirectory() && entry.name.startsWith('codex-'));
  if (!extracted) throw new Error('上游源码归档缺少 codex 顶层目录');
  return { source: path.join(sourceRoot, extracted.name), preserved };
}

async function applyPatch(source, preserved) {
  const patch = path.resolve('patches/0001-jinggong-runtime-identity.patch');
  if (!existsSync(patch)) throw new Error(`缺少可审查的 Jinggong Fork 补丁：${patch}`);
  const sourceDirectory = path.relative(process.cwd(), source).replaceAll('\\', '/');
  await run('git.exe', ['apply', '--check', `--directory=${sourceDirectory}`, patch]);
  await run('git.exe', ['apply', `--directory=${sourceDirectory}`, patch]);
  const cliManifest = await readFile(path.join(source, 'codex-rs/cli/Cargo.toml'), 'utf8');
  const lockfile = await readFile(path.join(source, 'codex-rs/Cargo.lock'), 'utf8');
  if (!cliManifest.includes('name = "jinggong-runtime-cli"') || !lockfile.includes('name = "jinggong-runtime-cli"')) throw new Error('Fork 补丁未应用到源码树，拒绝构建官方 Codex CLI');
  for (const [relative, previous] of preserved) {
    const absolute = path.join(source, relative);
    if (await sha256(absolute) === previous.hash) await utimes(absolute, previous.stat.atime, previous.stat.mtime);
  }
  // 保留旧 Cargo build-script 中的绝对 OUT_DIR 路径，缓存本身在源码目录外。
  await symlink(cargoTarget, path.join(source, 'codex-rs/target'), 'junction');
}

async function ensureRustyV8Artifacts(source) {
  const lockfile = await readFile(path.join(source, 'codex-rs/Cargo.lock'), 'utf8');
  const v8Package = lockfile.match(/(?:^|\r?\n)\[\[package\]\]\r?\nname = "v8"\r?\nversion = "([^\"]+)"/);
  if (!v8Package) throw new Error('Cargo.lock 未锁定唯一的 v8 版本');
  const version = v8Package[1];
  const artifactProfile = 'ptrcomp_sandbox_release';
  const artifactName = `rusty_v8_${artifactProfile}_${targetTriple}.lib.gz`;
  const bindingName = `src_binding_${artifactProfile}_${targetTriple}.rs`;
  const checksumName = `rusty_v8_${artifactProfile}_${targetTriple}.sha256`;
  const trustedManifest = path.join(source, 'third_party/v8', `rusty_v8_${version.replaceAll('.', '_')}_release_manifests.sha256`);
  const trustedLine = (await readFile(trustedManifest, 'utf8')).split(/\r?\n/).find(line => line.trim().endsWith(`  ${checksumName}`));
  if (!trustedLine) throw new Error(`上游未提供 V8 校验清单的可信哈希：${checksumName}`);
  const expectedManifestSha = trustedLine.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expectedManifestSha)) throw new Error('上游 V8 校验清单的可信 SHA256 格式无效');

  const cache = path.join(v8ArtifactRoot, `rusty-v8-${version}-${targetTriple}`);
  assertBuildPath(cache);
  await mkdir(cache, { recursive: true });
  const releaseUrl = `https://github.com/openai/codex/releases/download/rusty-v8-v${version}`;
  const download = async (url, destination) => {
    const temporary = `${destination}.tmp`;
    await rm(temporary, { force: true });
    try {
      await run('curl.exe', ['-L', '--fail', '--retry', '3', '--retry-delay', '2', '--output', temporary, url]);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };
  const checksumFile = path.join(cache, checksumName);
  if (!existsSync(checksumFile) || await sha256(checksumFile) !== expectedManifestSha) {
    await rm(checksumFile, { force: true });
    await download(`${releaseUrl}/${checksumName}`, checksumFile);
  }
  if (await sha256(checksumFile) !== expectedManifestSha) {
    await rm(checksumFile, { force: true });
    throw new Error('Codex V8 发布校验清单 SHA256 与上游源码不匹配');
  }

  const checksums = new Map();
  for (const line of (await readFile(checksumFile, 'utf8')).split(/\r?\n/).filter(Boolean)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/);
    if (!match) throw new Error(`Codex V8 发布校验清单格式无效：${line}`);
    checksums.set(match[2].trim(), match[1]);
  }
  for (const name of [artifactName, bindingName]) {
    if (!checksums.has(name)) throw new Error(`Codex V8 发布校验清单缺少 ${name}`);
  }

  const artifacts = {};
  for (const name of [artifactName, bindingName]) {
    const destination = path.join(cache, name);
    const expected = checksums.get(name);
    if (!existsSync(destination) || await sha256(destination) !== expected) {
      await rm(destination, { force: true });
      await download(`${releaseUrl}/${name}`, destination);
    }
    const actual = await sha256(destination);
    if (actual !== expected) {
      await rm(destination, { force: true });
      throw new Error(`Codex V8 发布文件 SHA256 不匹配：${name}`);
    }
    artifacts[name === artifactName ? 'archive' : 'binding'] = destination;
    await appendFile(buildLog, `V8 ${name} SHA256=${actual}\n`, 'utf8');
  }
  console.log(`已校验并缓存 Codex 上游 V8 预构建产物：${cache}`);
  return artifacts;
}

function cargoEnv(v8Artifacts) {
  const rustRoot = path.resolve('.runtime-build/rust');
  const cargoHome = path.join(rustRoot, 'cargo');
  const rustupHome = path.join(rustRoot, 'rustup');
  return {
    ...process.env,
    CARGO_HOME: cargoHome,
    RUSTUP_HOME: rustupHome,
    CARGO_TARGET_DIR: cargoTarget,
    RUSTY_V8_ARCHIVE: v8Artifacts.archive,
    RUSTY_V8_SRC_BINDING_PATH: v8Artifacts.binding,
    PATH: `${path.join(cargoHome, 'bin')};${process.env.PATH ?? ''}`,
    RUSTUP_TOOLCHAIN: '1.95.0-x86_64-pc-windows-msvc',
    STABLE_GIT_COMMIT: upstreamSha,
    JINGGONG_RUNTIME_VERSION: runtimeVersion,
  };
}

async function cargoBuild(source, v8Artifacts) {
  const env = cargoEnv(v8Artifacts);
  const cargoDirectory = path.join(source, 'codex-rs');
  const rustVersion = await run('rustc.exe', ['--version'], { env });
  if (!rustVersion.startsWith('rustc 1.95.0 ')) throw new Error(`Rust 工具链版本不符合锁定值：${rustVersion.trim()}`);
  await appendFile(buildLog, `Jinggong Runtime ${runtimeVersion}\n${rustVersion}CARGO_TARGET_DIR=${cargoTarget}\n`, 'utf8');
  const output = await new Promise((resolve, reject) => {
    const child = spawn('cargo.exe', [
      'build', '--locked', '--release', '--target', targetTriple,
      '-p', 'jinggong-runtime-cli', '--bin', 'jinggong-runtime',
      '-p', 'codex-code-mode-host', '--bin', 'codex-code-mode-host',
      '-p', 'codex-windows-sandbox', '--bin', 'codex-command-runner',
      '-p', 'codex-windows-sandbox', '--bin', 'codex-windows-sandbox-setup',
    ], { cwd: cargoDirectory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let logWrites = Promise.resolve();
    child.stdout.on('data', chunk => { text += chunk.toString(); process.stdout.write(chunk); logWrites = logWrites.then(() => appendFile(buildLog, chunk)); });
    child.stderr.on('data', chunk => { text += chunk.toString(); process.stderr.write(chunk); logWrites = logWrites.then(() => appendFile(buildLog, chunk)); });
    child.once('error', reject);
    child.once('exit', code => { void logWrites.then(() => appendFile(buildLog, `\ncargo build exit code: ${code}\n`)).then(() => code === 0 ? resolve(text) : reject(new Error(`cargo build 退出码 ${code}，日志：${buildLog}`)), reject); });
  });
  return output;
}

async function scanFiles(directory, relative = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name);
    const rel = path.join(relative, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) result.push(...await scanFiles(current, rel));
    else result.push({ path: rel, sha256: await sha256(current) });
  }
  return result;
}

const requiredPackageFiles = [
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

async function verifyPackage(root, manifest) {
  const packageMetadata = JSON.parse(await readFile(path.join(root, 'codex-package.json'), 'utf8'));
  const expectedMetadata = {
    layoutVersion: 1,
    version: runtimeVersion,
    target: targetTriple,
    variant: 'codex',
    entrypoint: 'bin/jinggong-runtime.exe',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path',
  };
  for (const [key, value] of Object.entries(expectedMetadata)) {
    if (packageMetadata[key] !== value) throw new Error(`codex-package.json 字段 ${key} 不正确`);
  }

  const listed = new Map(manifest.files.map(file => [file.path, file.sha256]));
  if (manifest.files.some(file => typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || file.path.includes('\\') || path.posix.isAbsolute(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('Fork package manifest 含无效路径或 SHA256');
  }
  for (const relative of requiredPackageFiles) {
    const file = path.join(root, ...relative.split('/'));
    if (!existsSync(file)) throw new Error(`Fork package 缺少必需文件：${relative}`);
    const fileStat = await stat(file);
    if (!fileStat.isFile() || fileStat.size === 0) throw new Error(`Fork package 文件为空或不是普通文件：${relative}`);
    const expectedHash = listed.get(relative);
    if (!expectedHash || expectedHash !== await sha256(file)) throw new Error(`Fork package 清单校验失败：${relative}`);
  }
  if (listed.size !== manifest.files.length) throw new Error('Fork package manifest 含重复文件路径');
  for (const [relative, expectedHash] of listed) {
    const file = path.join(root, ...relative.split('/'));
    if (!existsSync(file) || await sha256(file) !== expectedHash) throw new Error(`Fork package manifest 哈希不匹配：${relative}`);
  }
}

async function stage(source, cargoOutput) {
  const targetRoot = path.join(cargoTarget, targetTriple, 'release');
  const binary = path.join(targetRoot, 'jinggong-runtime.exe');
  const codeModeHost = path.join(targetRoot, 'codex-code-mode-host.exe');
  const commandRunner = path.join(targetRoot, 'codex-command-runner.exe');
  const sandboxSetup = path.join(targetRoot, 'codex-windows-sandbox-setup.exe');
  const ripgrep = path.resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-path/rg.exe');
  for (const file of [binary, codeModeHost, commandRunner, sandboxSetup, ripgrep]) if (!existsSync(file)) throw new Error(`Fork package 缺少构建资源：${file}`);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(path.join(outputRoot, 'bin'), { recursive: true });
  await mkdir(path.join(outputRoot, 'codex-path'), { recursive: true });
  await mkdir(path.join(outputRoot, 'codex-resources'), { recursive: true });
  await cp(binary, path.join(outputRoot, 'bin/jinggong-runtime.exe'));
  await cp(codeModeHost, path.join(outputRoot, 'bin/codex-code-mode-host.exe'));
  await cp(ripgrep, path.join(outputRoot, 'codex-path/rg.exe'));
  await cp(commandRunner, path.join(outputRoot, 'codex-resources/codex-command-runner.exe'));
  await cp(sandboxSetup, path.join(outputRoot, 'codex-resources/codex-windows-sandbox-setup.exe'));
  await cp(path.join(source, 'LICENSE'), path.join(outputRoot, 'LICENSE'));
  await cp(path.join(source, 'NOTICE'), path.join(outputRoot, 'NOTICE'));
  if (await sha256(path.join(outputRoot, 'LICENSE')) !== licenseSha256) throw new Error('上游 LICENSE SHA256 不匹配');
  if (await sha256(path.join(outputRoot, 'NOTICE')) !== noticeSha256) throw new Error('上游 NOTICE SHA256 不匹配');
  const buildNumber = `${runtimeVersion}+${upstreamSha.slice(0, 12)}`;
  const patchSha256 = await sha256(forkPatch);
  const ripgrepSha256 = await sha256(ripgrep);
  const metadata = { runtimeId: 'jinggong', runtimeVersion, buildNumber, upstreamRepository: 'https://github.com/openai/codex', upstreamTag, upstreamCommit: upstreamSha, upstreamArchiveSha256, patch: '0001-jinggong-runtime-identity.patch', patchSha256, target: targetTriple, rustToolchain: '1.95.0', protocol: 'app-server-stdio-jsonl', capabilitiesVersion: 5, sandbox: 'unverified', packageLayout: 'codex-canonical-package', helperBinaries: ['bin/codex-code-mode-host.exe', 'codex-resources/codex-command-runner.exe', 'codex-resources/codex-windows-sandbox-setup.exe'], ripgrep: { source: '@openai/codex-win32-x64@0.156.1', sha256: ripgrepSha256 }, buildCommand: 'cargo build --locked --release --target x86_64-pc-windows-msvc -p jinggong-runtime-cli --bin jinggong-runtime -p codex-code-mode-host --bin codex-code-mode-host -p codex-windows-sandbox --bin codex-command-runner -p codex-windows-sandbox --bin codex-windows-sandbox-setup' };
  // Keep the upstream Codex package layout and metadata contract so install-context,
  // command-runner and Windows sandbox discovery can locate the adjacent resources.
  await writeFile(path.join(outputRoot, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1,
    version: runtimeVersion,
    target: targetTriple,
    variant: 'codex',
    entrypoint: 'bin/jinggong-runtime.exe',
    resourcesDir: 'codex-resources',
    pathDir: 'codex-path',
  }, null, 2));
  await writeFile(path.join(outputRoot, 'BUILD-METADATA.json'), JSON.stringify(metadata, null, 2));
  await writeFile(path.join(outputRoot, 'BUILD-LOG.txt'), String(cargoOutput).slice(-20000), 'utf8');
  const files = await scanFiles(outputRoot);
  const manifest = { ...metadata, runtimeVersionDisplay: `Jinggong Runtime ${runtimeVersion}`, files };
  await verifyPackage(outputRoot, manifest);
  await writeFile(path.join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const stagedManifest = JSON.parse(await readFile(path.join(outputRoot, 'manifest.json'), 'utf8'));
  await verifyPackage(outputRoot, stagedManifest);
}

if (!existsSync(forkPatch)) throw new Error(`缺少可审查的 Jinggong Fork 补丁：${forkPatch}`);
await downloadArchive();
await preserveCargoCache();
const { source, preserved } = await extractSource();
await applyPatch(source, preserved);
const v8Artifacts = await ensureRustyV8Artifacts(source);
const cargoOutput = await cargoBuild(source, v8Artifacts);
await stage(source, cargoOutput);
console.log(`已构建独立 Jinggong Runtime ${runtimeVersion}（上游 ${upstreamSha}）`);
console.log(`完整构建日志：${buildLog}`);

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import type { RuntimeKind } from '../../../../packages/domain/src';
import { validateWindowsX64Executable } from '../../../../scripts/windows-executable.mjs';

const requiredFiles: Partial<Record<RuntimeKind, string[]>> = {
  jinggong: [
    'bin/jinggong-runtime.exe',
    'bin/codex-code-mode-host.exe',
    'codex-path/rg.exe',
    'codex-resources/codex-command-runner.exe',
    'codex-resources/codex-windows-sandbox-setup.exe',
    'codex-package.json', 'LICENSE', 'NOTICE', 'BUILD-METADATA.json', 'BUILD-LOG.txt',
  ],
  codex: [
    'bin/codex.exe',
    'bin/codex-code-mode-host.exe',
    'codex-path/rg.exe',
    'codex-resources/codex-command-runner.exe',
    'codex-resources/codex-windows-sandbox-setup.exe',
    'codex-package.json', 'LICENSE', 'NOTICE',
  ],
  claude_agent_sdk: [
    'bin/claude.exe',
  ],
};

function listPackageFiles(root: string, directory = root, relative = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const name = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`运行时目录包含符号链接：${name}`);
    if (entry.isDirectory()) files.push(...listPackageFiles(root, absolute, name));
    else if (entry.isFile()) { if (name !== 'manifest.json') files.push(name); }
    else throw new Error(`运行时目录包含非普通文件：${name}`);
  }
  return files;
}

/** 验证安装目录中的清单本身、所有文件哈希和完整资源集合。 */
export function verifyRuntimeManifest(root: string, kind: RuntimeKind, entrypoint: string): { runtimeVersion: string; upstreamCommit?: string; buildNumber?: string; capabilitiesVersion?: number; sandbox?: 'verified' | 'unverified' } {
  const absoluteRoot = path.resolve(root);
  const manifestPath = path.join(absoluteRoot, 'manifest.json');
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) throw new Error('运行时清单缺失或不是普通文件');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    runtimeId?: string; runtimeVersion?: string; upstreamCommit?: string; buildNumber?: string;
    capabilitiesVersion?: number; sandbox?: 'verified' | 'unverified';
    files?: Array<{ path?: string; sha256?: string }>;
  };
  if (manifest.runtimeId !== kind || typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion.trim()) throw new Error('运行时清单身份或版本无效');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('运行时清单文件列表为空');
  const expected = new Map<string, string>();
  for (const item of manifest.files) {
    const relative = item.path;
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('运行时清单包含无效路径或 SHA256');
    if (expected.has(relative)) throw new Error(`运行时清单包含重复文件：${relative}`);
    expected.set(relative, item.sha256);
  }
  for (const relative of requiredFiles[kind] ?? []) if (!expected.has(relative)) throw new Error(`运行时清单缺少必需资源：${relative}`);
  if (!expected.has(entrypoint)) throw new Error('运行时入口未列入完整性清单');
  const actualFiles = listPackageFiles(absoluteRoot).sort();
  const listedFiles = [...expected.keys()].sort();
  if (actualFiles.length !== listedFiles.length || actualFiles.some((file, index) => file !== listedFiles[index])) throw new Error('运行时清单与安装目录资源不一致');
  for (const [relative, expectedHash] of expected) {
    const target = path.resolve(absoluteRoot, ...relative.split('/'));
    if (!target.toLowerCase().startsWith(`${absoluteRoot}${path.sep}`.toLowerCase())) throw new Error(`运行时清单路径非法：${relative}`);
    const metadata = lstatSync(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error(`运行时资源缺失、为空或不是普通文件：${relative}`);
    const content = readFileSync(target);
    const actualHash = createHash('sha256').update(content).digest('hex');
    if (actualHash !== expectedHash) throw new Error(`运行时完整性校验失败：${relative}`);
    if (kind === 'claude_agent_sdk' && relative === entrypoint) validateWindowsX64Executable(content);
  }
  return { runtimeVersion: manifest.runtimeVersion, upstreamCommit: manifest.upstreamCommit, buildNumber: manifest.buildNumber, capabilitiesVersion: manifest.capabilitiesVersion, sandbox: manifest.sandbox };
}

function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.mode === after.mode;
}

async function assertUnchanged(filename: string, before: Stats): Promise<void> {
  const after = await lstat(filename);
  if (after.isSymbolicLink() || !sameFile(before, after)) throw new Error(`运行时资源在校验期间发生变化：${filename}`);
}

async function listPackageFilesAsync(directory: string, directories: Map<string, Stats>, relative = ''): Promise<string[]> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`运行时目录不是普通目录或包含符号链接：${relative || '.'}`);
  directories.set(directory, metadata);
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`运行时目录包含符号链接：${name}`);
    if (entry.isDirectory()) files.push(...await listPackageFilesAsync(absolute, directories, name));
    else if (entry.isFile()) { if (name !== 'manifest.json') files.push(name); }
    else throw new Error(`运行时目录包含非普通文件：${name}`);
  }
  return files;
}

async function readExact(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const content = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = await file.read(content, offset, length - offset, position + offset);
    if (!read.bytesRead) throw new Error('运行时资源在校验期间发生变化');
    offset += read.bytesRead;
  }
  return content;
}

/** 只读取 PE 校验需要的头与节表，实际长度及所有规则仍交给同一校验器。 */
async function validateWindowsX64ExecutableAsync(file: FileHandle, size: number): Promise<void> {
  const segments: Array<{ offset: number; content: Buffer }> = [];
  if (size >= 64) {
    const dos = await readExact(file, 64, 0); segments.push({ offset: 0, content: dos });
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset <= size - 24) {
      const pe = await readExact(file, 24, peOffset); segments.push({ offset: peOffset, content: pe });
      const optionalSize = pe.readUInt16LE(20), optionalOffset = peOffset + 24;
      const sectionCount = pe.readUInt16LE(6), sectionOffset = optionalOffset + optionalSize;
      if (optionalSize >= 112 && sectionOffset <= size) {
        segments.push({ offset: optionalOffset, content: await readExact(file, 112, optionalOffset) });
        if (sectionCount > 0 && sectionCount <= 96 && sectionOffset + sectionCount * 40 <= size) {
          segments.push({ offset: sectionOffset, content: await readExact(file, sectionCount * 40, sectionOffset) });
        }
      }
    }
  }
  const read = (offset: number, length: 2 | 4): number => {
    const segment = segments.find(item => offset >= item.offset && offset + length <= item.offset + item.content.length);
    if (!segment) throw new Error('Windows x64 可执行文件无效：文件头读取范围无效');
    return length === 2 ? segment.content.readUInt16LE(offset - segment.offset) : segment.content.readUInt32LE(offset - segment.offset);
  };
  const validateHeader = validateWindowsX64Executable as (content: Pick<Buffer, 'length' | 'readUInt16LE' | 'readUInt32LE'>) => unknown;
  validateHeader({ length: size, readUInt16LE: (offset = 0) => read(offset, 2), readUInt32LE: (offset = 0) => read(offset, 4) });
}

/** 每轮仍完整读取并核验全部资源；以有界异步读取避免阻塞桌面主进程。 */
export async function verifyRuntimeManifestAsync(root: string, kind: RuntimeKind, entrypoint: string): Promise<ReturnType<typeof verifyRuntimeManifest>> {
  const absoluteRoot = path.resolve(root);
  const rootMetadata = await lstat(absoluteRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('运行时目录不是普通目录或包含符号链接');
  const manifestPath = path.join(absoluteRoot, 'manifest.json');
  let manifestMetadata: Stats;
  try { manifestMetadata = await lstat(manifestPath); } catch { throw new Error('运行时清单缺失或不是普通文件'); }
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) throw new Error('运行时清单缺失或不是普通文件');
  const manifestFile = await open(manifestPath, 'r');
  let manifest;
  try {
    if (!sameFile(manifestMetadata, await manifestFile.stat())) throw new Error('运行时清单在校验期间发生变化');
    manifest = JSON.parse(await manifestFile.readFile('utf8')) as {
      runtimeId?: string; runtimeVersion?: string; upstreamCommit?: string; buildNumber?: string;
      capabilitiesVersion?: number; sandbox?: 'verified' | 'unverified';
      files?: Array<{ path?: string; sha256?: string }>;
    };
    if (!sameFile(manifestMetadata, await manifestFile.stat())) throw new Error('运行时清单在校验期间发生变化');
    await assertUnchanged(manifestPath, manifestMetadata);
  } finally { await manifestFile.close(); }
  if (manifest.runtimeId !== kind || typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion.trim()) throw new Error('运行时清单身份或版本无效');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('运行时清单文件列表为空');
  const expected = new Map<string, string>();
  for (const item of manifest.files) {
    const relative = item.path;
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('运行时清单包含无效路径或 SHA256');
    if (expected.has(relative)) throw new Error(`运行时清单包含重复文件：${relative}`);
    expected.set(relative, item.sha256);
  }
  for (const relative of requiredFiles[kind] ?? []) if (!expected.has(relative)) throw new Error(`运行时清单缺少必需资源：${relative}`);
  if (!expected.has(entrypoint)) throw new Error('运行时入口未列入完整性清单');
  const directories = new Map<string, Stats>();
  const actualFiles = (await listPackageFilesAsync(absoluteRoot, directories)).sort();
  const listedFiles = [...expected.keys()].sort();
  if (actualFiles.length !== listedFiles.length || actualFiles.some((file, index) => file !== listedFiles[index])) throw new Error('运行时清单与安装目录资源不一致');
  const buffer = Buffer.alloc(1024 * 1024);
  for (const [relative, expectedHash] of expected) {
    const target = path.resolve(absoluteRoot, ...relative.split('/'));
    if (!target.toLowerCase().startsWith(`${absoluteRoot}${path.sep}`.toLowerCase())) throw new Error(`运行时清单路径非法：${relative}`);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error(`运行时资源缺失、为空或不是普通文件：${relative}`);
    const file = await open(target, 'r');
    try {
      if (!sameFile(metadata, await file.stat())) throw new Error(`运行时资源在校验期间发生变化：${relative}`);
      const hash = createHash('sha256');
      let offset = 0;
      while (offset < metadata.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, metadata.size - offset), offset);
        if (!bytesRead) throw new Error(`运行时资源在校验期间发生变化：${relative}`);
        hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
      }
      if (hash.digest('hex') !== expectedHash) throw new Error(`运行时完整性校验失败：${relative}`);
      if (kind === 'claude_agent_sdk' && relative === entrypoint) await validateWindowsX64ExecutableAsync(file, metadata.size);
      if (!sameFile(metadata, await file.stat())) throw new Error(`运行时资源在校验期间发生变化：${relative}`);
      await assertUnchanged(target, metadata);
    } finally { await file.close(); }
  }
  await assertUnchanged(manifestPath, manifestMetadata);
  for (const [directory, metadata] of directories) await assertUnchanged(directory, metadata);
  await assertUnchanged(absoluteRoot, rootMetadata);
  return { runtimeVersion: manifest.runtimeVersion, upstreamCommit: manifest.upstreamCommit, buildNumber: manifest.buildNumber, capabilitiesVersion: manifest.capabilitiesVersion, sandbox: manifest.sandbox };
}

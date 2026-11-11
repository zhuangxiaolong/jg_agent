import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
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

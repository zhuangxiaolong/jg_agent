import { lstat, mkdir, readdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

export interface DataRootMigrationOptions {
  targetRoot: string;
  legacyRoots: string[];
}

export interface DataRootMigrationResult {
  source?: string;
  copied: string[];
}

const MAX_COPIED_ENTRIES = 100_000;

async function exists(filePath: string): Promise<boolean> {
  try { await lstat(filePath); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/**
 * 将旧版本数据目录中的内容迁移到当前目录，只补齐目标目录缺失的文件。
 * 源目录不会被删除或修改，且跳过符号链接，避免安装升级时越界复制。
 */
export async function migrateLegacyDataRoot(options: DataRootMigrationOptions): Promise<DataRootMigrationResult> {
  const targetRoot = path.resolve(options.targetRoot);
  const copied: string[] = [];
  const targetDatabase = path.join(targetRoot, 'database', 'jinggong-agent.db');
  if (await exists(targetDatabase)) return { copied };

  const roots = [...new Set(options.legacyRoots.map(root => path.resolve(root)).filter(root => root !== targetRoot))];
  for (const sourceRoot of roots) {
    if (!(await exists(path.join(sourceRoot, 'database', 'jinggong-agent.db')))) continue;
    await copyMissing(sourceRoot, targetRoot, sourceRoot, copied);
    return { source: sourceRoot, copied };
  }
  return { copied };
}

async function copyMissing(sourceRoot: string, targetRoot: string, sourcePath: string, copied: string[]): Promise<void> {
  if (copied.length >= MAX_COPIED_ENTRIES) throw new Error('旧版数据目录文件数量超出迁移上限');
  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink()) return;
  const relative = path.relative(sourceRoot, sourcePath);
  const targetPath = path.join(targetRoot, relative);
  if (sourceStat.isDirectory()) {
    if (!(await exists(targetPath))) await mkdir(targetPath, { recursive: true });
    const entries = await readdir(sourcePath);
    for (const entry of entries) await copyMissing(sourceRoot, targetRoot, path.join(sourcePath, entry), copied);
    return;
  }
  if (!sourceStat.isFile() || await exists(targetPath)) return;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  copied.push(relative);
}

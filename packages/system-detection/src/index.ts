import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProductSystem } from '../../domain/src';

export interface ProductSystemDetection {
  system: ProductSystem;
  confidence: 'high' | 'medium' | 'low';
  scores: Record<'MES5' | 'MES6' | 'WMS', number>;
  matches: string[];
}

type Candidate = 'MES5' | 'MES6' | 'WMS';
const SYSTEMS: Candidate[] = ['MES5', 'MES6', 'WMS'];
const MAX_FILES = 3000;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const SKIP_DIRECTORIES = new Set(['.git', '.codex', 'node_modules', 'bin', 'obj', 'dist', 'release', 'packages', 'vendor']);

async function readPrefix(filename: string, maximum: number): Promise<Buffer> {
  const handle = await open(filename, 'r');
  try {
    const stat = await handle.stat();
    const bytes = Buffer.alloc(Math.min(stat.size, maximum));
    const result = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
}

function add(scores: Record<Candidate, number>, matches: string[], system: Candidate, points: number, match: string): void {
  if (matches.includes(match)) return;
  scores[system] += points;
  matches.push(match);
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && files.length < MAX_FILES) {
    const current = queue.shift()!;
    let entries;
    try { entries = await readdir(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.name.startsWith('.') && entry.name !== '.sln') continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 7 && !SKIP_DIRECTORIES.has(entry.name.toLowerCase())) queue.push({ directory: absolute, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  return files;
}

/**
 * 按仓库代码指纹识别 MES5、MES6 或 WMS；证据不足时返回通用，避免把不同代际字典混入上下文。
 */
export async function detectProductSystem(root: string): Promise<ProductSystemDetection> {
  const scores: Record<Candidate, number> = { MES5: 0, MES6: 0, WMS: 0 };
  const matches: string[] = [];
  const files = await collectFiles(root);
  const rootName = path.basename(path.resolve(root));
  if (/^(?:jz\.)?ims(?:\.|$)/i.test(rootName)) add(scores, matches, 'MES5', 35, '仓库目录 iMES/JZ.IMS');
  if (/^imes(?:\.|$)/i.test(rootName)) add(scores, matches, 'MES6', 35, '仓库目录 iMES');
  if (/^(?:j?iwms|wms)(?:\.|-|$)/i.test(rootName)) add(scores, matches, 'WMS', 35, '仓库目录 WMS');
  let remaining = MAX_BYTES;
  for (const filename of files) {
    const relative = path.relative(root, filename).replaceAll('\\', '/');
    const lower = relative.toLowerCase();
    if (/^imes\.sln$/i.test(path.basename(relative))) add(scores, matches, 'MES6', 100, 'IMES.sln');
    if (/^jz\.ims\.sln$/i.test(path.basename(relative))) add(scores, matches, 'MES5', 100, 'JZ.IMS.sln');
    if (/^(?:j?iwms|wms)(?:\.[^/]+)?\.sln$/i.test(path.basename(relative))) add(scores, matches, 'WMS', 100, path.basename(relative));
    if (/\.(?:csproj|fsproj|vbproj)$/i.test(lower)) {
      let text = '';
      try {
        const bytes = await readPrefix(filename, MAX_FILE_BYTES);
        if (!bytes.length) continue;
        const content = bytes;
        if (content.length > remaining) continue;
        remaining -= content.length;
        text = content.toString('utf8');
      } catch { continue; }
      if (/net10\.0(?:-windows)?/i.test(text)) add(scores, matches, 'MES6', 25, 'TargetFramework net10.0');
      if (/\bIMES\./i.test(text)) add(scores, matches, 'MES6', 25, 'IMES 项目引用');
      if (/netcoreapp(?:3\.1|2\.2)/i.test(text)) add(scores, matches, 'MES5', 25, 'TargetFramework netcoreapp3.1/2.2');
      if (/\bJZ\.IMS\./i.test(text)) add(scores, matches, 'MES5', 25, 'JZ.IMS 项目引用');
      // IWMS.Common 是 MES6 的历史兼容命名空间，不作为 WMS 的仓库指纹。
      if (/\b(?:J?IWMS|WMS)\.(?!Common\b)/i.test(text)) add(scores, matches, 'WMS', 25, 'WMS 项目引用');
    }
    if (remaining <= 0) break;
  }
  // 读取少量根目录配置/源码，补足没有标准解决方案名称的仓库指纹。
  remaining = Math.max(remaining, 2 * 1024 * 1024);
  for (const filename of files.filter(file => /(?:appsettings(?:\.[^/]+)?\.json|readme(?:\.[^/]+)?|startup\.cs|program\.cs)$/i.test(path.basename(file))).slice(0, 80)) {
    if (remaining <= 0) break;
    try {
      const content = await readPrefix(filename, 128 * 1024);
      remaining -= content.length;
      const text = content.toString('utf8');
      if (/\bnamespace\s+(?:JZ\.)?(?:IWMS|WMS)(?:\.(?!Common\b)|\s|;)/i.test(text)) add(scores, matches, 'WMS', 20, 'WMS 命名空间');
      if (/\bDbOpion\b|\bErpDbOpion\b|CorePackage/i.test(text)) add(scores, matches, 'MES5', 20, 'MES5 配置键/基础包');
      if (/IMES\.SqlSugar\.Core|\bFurion\b|\bSqlConnection\b[\s\S]{0,160}\bDbType\b/i.test(text)) add(scores, matches, 'MES6', 20, 'MES6 ORM/框架指纹');
      if (/\b(?:IWMS|WMS)\b/i.test(text) && !/\bMES[56]\b/i.test(text)) add(scores, matches, 'WMS', 12, 'WMS 文本指纹');
    } catch { /* 文件可能在枚举后被删除，继续使用已有证据。 */ }
  }
  const ordered = [...SYSTEMS].sort((left, right) => scores[right] - scores[left]);
  const winner = ordered[0];
  const second = scores[ordered[1]];
  const score = scores[winner];
  const confidence: ProductSystemDetection['confidence'] = score >= 100 || score - second >= 45 ? 'high' : score >= 25 && score - second >= 15 ? 'medium' : 'low';
  return { system: score >= 25 && score - second >= 10 ? winner : '通用', confidence, scores, matches: matches.slice(0, 12) };
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { OperationManualLibrary } from './operation-manual-library';

const manualManifestSchema = z.object({
  version: z.string().min(1).max(100),
  manuals: z.array(z.object({
    id: z.string().regex(/^builtin-operation-manual-[a-z0-9-]+$/),
    name: z.string().min(1).max(200),
    productType: z.enum(['MES5', 'MES6', 'WMS', 'SRM', 'JMOM', 'PDA', 'COMMON']),
    productVersion: z.string().max(100).optional(),
    manualVersion: z.string().max(100).optional(),
    scopeNote: z.string().max(1000).optional(),
    path: z.string().regex(/^[a-zA-Z0-9_.\u4e00-\u9fff-]+\.docx$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).length(4),
}).strict();

export async function ensureBundledOperationManuals(library: OperationManualLibrary, resourcesRoot: string): Promise<{ installed: number; skipped: number; version: string }> {
  const root = path.resolve(resourcesRoot, 'manuals');
  let manifestText: string;
  try { manifestText = await readFile(path.join(root, 'manifest.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: 0, skipped: 0, version: '' };
    throw error;
  }
  const manifest = manualManifestSchema.parse(JSON.parse(manifestText));
  if (new Set(manifest.manuals.map(item => item.id)).size !== manifest.manuals.length) throw new Error('内置操作手册清单包含重复标识。');
  const entries = [];
  for (const item of manifest.manuals) {
    const filename = path.resolve(root, item.path);
    if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('内置操作手册路径越界。');
    const content = await readFile(filename);
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== item.sha256) throw new Error(`内置操作手册 ${item.name} 校验失败。`);
    entries.push({ ...item, filename });
  }
  const result = await library.ensureBundledManuals(entries);
  return { ...result, version: manifest.version };
}

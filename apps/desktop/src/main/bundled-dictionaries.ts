import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ManagedDocument, ProductSystem } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';

const dictionaryManifestSchema = z.object({
  version: z.string().min(1).max(100),
  documents: z.array(z.object({
    id: z.string().regex(/^builtin-dictionary-(mes5|mes6|wms)$/),
    name: z.string().min(1).max(160),
    system: z.enum(['MES5', 'MES6', 'WMS']),
    path: z.string().regex(/^[a-zA-Z0-9_-]+\.md$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).length(3),
}).strict();

export interface BuiltinDictionaryResult { installed: number; skipped: number; version: string }

/** 将随安装包发布的基础字典写入本地资料库；用户已有资料、停用状态和本地修改不会被覆盖。 */
export async function ensureBuiltinDictionaries(store: LocalStore, resourcesRoot: string): Promise<BuiltinDictionaryResult> {
  const root = path.resolve(resourcesRoot, 'dictionaries');
  const manifestPath = path.join(root, 'manifest.json');
  let manifestText: string;
  try { manifestText = await readFile(manifestPath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: 0, skipped: 0, version: '' };
    throw error;
  }
  const manifest = dictionaryManifestSchema.parse(JSON.parse(manifestText));
  if (new Set(manifest.documents.map(item => item.system)).size !== 3) throw new Error('内置数据字典清单必须包含 MES5、MES6、WMS');
  const existing = store.listDocuments();
  let installed = 0;
  for (const entry of manifest.documents) {
    const filename = path.resolve(root, entry.path);
    if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('内置数据字典路径越界');
    const content = await readFile(filename, 'utf8');
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== entry.sha256) throw new Error(`内置数据字典 ${entry.name} 校验失败`);
    const current = existing.find(document => document.id === entry.id);
    if (current) {
      if (current.kind !== 'dictionary' || current.system !== entry.system) throw new Error(`内置数据字典标识冲突：${entry.id}`);
      continue;
    }
    const document: ManagedDocument = {
      id: entry.id,
      kind: 'dictionary',
      system: entry.system as ProductSystem,
      name: entry.name,
      content,
      digest,
      createdAt: new Date().toISOString(),
      enabled: true,
    };
    store.saveDocument(document);
    installed++;
  }
  return { installed, skipped: manifest.documents.length - installed, version: manifest.version };
}

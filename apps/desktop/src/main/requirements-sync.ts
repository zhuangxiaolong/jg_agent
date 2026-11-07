import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ManagedDocument, RequirementsSync } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import { parsePolicy } from '../../../../packages/policy/src';

export const DEFAULT_REQUIREMENTS_URL = 'https://github.com/zhuangxiaolong/jg_agent';
const manifestSchema = z.object({ version: z.string().min(1).max(100), documents: z.array(z.object({ key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), name: z.string().min(1).max(160), system: z.enum(['MES5', 'MES6', 'WMS', '通用']), path: z.string().min(1).max(500), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(100) }).strict();
export function shouldSyncRequirementsOnStartup(state: RequirementsSync): boolean {
  return state.automatic || (!state.version && !state.lastChecked);
}
export function requirementsSource(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('规范更新地址须为不含账号及参数的 HTTPS 地址');
  if (url.hostname === 'github.com') {
    const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
    if (parts.length === 2) return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/main/standards/manifest.json`;
    if (parts[2] === 'blob' && parts.length >= 5) return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`;
    throw new Error('请填写 GitHub 仓库地址或 manifest.json 文件地址');
  }
  return url.toString();
}
async function readText(url: string, transport: typeof fetch): Promise<string> {
  const response = await transport(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json, text/plain' } });
  if (!response.ok) throw new Error(`规范更新请求失败（HTTP ${response.status}）`);
  const reader = response.body?.getReader(); if (!reader) throw new Error('规范更新返回空内容');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 * 1024) throw new Error('单份在线规范超过 1 MiB'); chunks.push(part.value); }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); }
}
export async function updateRequirements(store: LocalStore, assertIdle: () => void, assertClean: (text: string) => void, transport: typeof fetch = fetch): Promise<RequirementsSync> {
  const initial = store.getRequirementsSync(), source = requirementsSource(initial.url);
  // 固定到同一提交下载清单和正文，避免分支缓存及更新中途文件版本交叉。
  let downloadSource = source;
  const github = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(source);
  if (github && !/^[a-f0-9]{40}$/.test(github[3])) {
    const ref = JSON.parse(await readText(`https://api.github.com/repos/${github[1]}/${github[2]}/git/ref/heads/${encodeURIComponent(github[3])}`, transport));
    if (!/^[a-f0-9]{40}$/.test(ref.object?.sha)) throw new Error('未能获取 GitHub 规范版本');
    downloadSource = `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${ref.object.sha}/${github[4]}`;
  }
  const manifest = manifestSchema.parse(JSON.parse(await readText(downloadSource, transport)));
  if (new Set(manifest.documents.map(item => item.key)).size !== manifest.documents.length) throw new Error('在线规范清单含重复标识');
  const documents: ManagedDocument[] = [], existing = store.listDocuments();
  let changed = 0;
  for (const entry of manifest.documents) {
    if (entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '..' || part === '.') || /[:?#%]/.test(entry.path)) throw new Error('在线规范文件路径无效');
    const url = new URL(entry.path, downloadSource);
    if (url.origin !== new URL(downloadSource).origin) throw new Error('在线规范文件必须来自同一更新源');
    const content = await readText(url.toString(), transport), digest = createHash('sha256').update(content).digest('hex');
    if (digest !== entry.sha256) throw new Error(`在线规范 ${entry.name} 校验失败，本次更新未保存`);
    assertClean(entry.name + '\n' + content);
    const current = existing.find(item => item.remote?.source === source && item.remote.key === entry.key);
    if (current && current.digest !== current.remote!.digest && current.digest !== digest) throw new Error(`规范“${current.name}”有本地修改，未覆盖。请另存本地修改后重新更新`);
    if (!current || current.digest !== digest) changed++;
    const document: ManagedDocument = { id: current?.id ?? randomUUID(), kind: 'requirement', name: entry.name, system: entry.system, content, digest, createdAt: current?.createdAt ?? new Date().toISOString(), enabled: current?.enabled ?? true, remote: { source, key: entry.key, version: manifest.version, digest } };
    parsePolicy(document); documents.push(document);
  }
  if (existing.length + documents.filter(item => !existing.some(old => old.id === item.id)).length > 100) throw new Error('在线更新后资料超过 100 份，请先整理');
  assertIdle();
  if (JSON.stringify(store.getRequirementsSync()) !== JSON.stringify(initial)) throw new Error('更新设置已变化，请重新更新');
  const state = { ...initial, version: manifest.version, lastChecked: new Date().toISOString(), ...(changed ? { lastUpdated: new Date().toISOString() } : {}), message: changed ? `已更新 ${changed} 份规范` : '规范已是最新', error: undefined };
  store.applyRequirementUpdate(documents, state); return state;
}

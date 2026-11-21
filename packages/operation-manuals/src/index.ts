import { createHash, randomUUID } from 'node:crypto';
import { formatManualCitation } from './format';
export { formatManualCitation, formatManualLocator } from './format';

export type ManualProductType = 'MES5' | 'MES6' | 'WMS' | 'SRM' | 'JMOM' | 'PDA' | 'COMMON';
export type ManualStatus = 'pending' | 'processing' | 'ready' | 'partial' | 'failed' | 'disabled';
export type ManualJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ManualLocator =
  | { kind: 'pdf'; page: number }
  | { kind: 'xlsx'; sheet: string; range?: string }
  | { kind: 'pptx'; slide: number }
  | { kind: 'docx' | 'text' | 'html'; lineStart?: number; lineEnd?: number };

export interface ParsedManualBlock {
  type: 'heading' | 'paragraph' | 'list' | 'table';
  text: string;
  sectionPath: string[];
  locator: ManualLocator;
  order: number;
}

export interface ParsedManualDocument {
  parserVersion: string;
  blocks: ParsedManualBlock[];
  pageCount?: number;
  sheetCount?: number;
  slideCount?: number;
  extractedChars: number;
  warnings: string[];
}

export interface OperationManual {
  id: string;
  name: string;
  productType: ManualProductType;
  productVersion?: string;
  manualVersion?: string;
  effectiveDate?: string;
  scopeNote?: string;
  originalName: string;
  originalStorageKey: string;
  fileExtension: string;
  fileSize: number;
  sha256: string;
  status: ManualStatus;
  bundled?: boolean;
  pendingReplacement?: {
    originalName: string;
    originalStorageKey: string;
    fileExtension: string;
    fileSize: number;
    sha256: string;
  };
  resumeStatus?: Exclude<ManualStatus, 'processing' | 'disabled'>;
  parserVersion?: string;
  pageCount?: number;
  sheetCount?: number;
  slideCount?: number;
  extractedChars: number;
  errorSummary?: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ManualChunk {
  id: string;
  manualId: string;
  productType: ManualProductType;
  manualVersion?: string;
  productVersion?: string;
  effectiveDate?: string;
  sectionPath: string[];
  locator: ManualLocator;
  content: string;
  contentHash: string;
  tokenEstimate: number;
  ordinal: number;
}

export interface ManualImportJob {
  id: string;
  manualId: string;
  status: ManualJobStatus;
  stage: 'validate' | 'copy' | 'parse' | 'normalize' | 'chunk' | 'index' | 'finalize';
  progress: number;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface ManualImportResult {
  imported: OperationManual[];
  duplicates: OperationManual[];
  errors: Array<{ fileName: string; message: string }>;
}

export interface ManualSearchHit {
  manual: OperationManual;
  chunk: ManualChunk;
  score: number;
}

export interface OperationManualRevision {
  id: string;
  manualId: string;
  version: number;
  title: string;
  system: 'MES5' | 'MES6' | 'WMS';
  status: 'draft' | 'review' | 'published' | 'archived';
  blocks: Array<{ id: string; heading?: string; text: string; order: number; source: { fileName: string; digest: string; locator: string; text: string }; needsConfirmation?: boolean }>;
  createdAt: string;
  createdBy: 'import' | 'agent' | 'user';
  digest: string;
}

export interface LegacyOperationManual { id: string; system: 'MES5' | 'MES6' | 'WMS'; title: string; status: 'draft' | 'review' | 'published' | 'archived'; activeRevisionId?: string; revisions: OperationManualRevision[]; createdAt: string; updatedAt: string }

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalize(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN'); }

export function createManualRevision(input: Omit<OperationManualRevision, 'digest'>): OperationManualRevision {
  if (!input.title.trim() || !input.blocks.length) throw new Error('操作手册修订必须包含标题和内容块');
  const payload = JSON.stringify({ ...input, blocks: input.blocks.map(block => ({ ...block, text: block.text.trim() })) });
  return { ...input, digest: digest(payload) };
}

/** 旧版内存 API 保留给已有调用方和兼容性测试。 */
export function searchManuals(manuals: LegacyOperationManual[], system: LegacyOperationManual['system'], query: string, limit = 20) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const hits: Array<{ manualId: string; revisionId: string; blockId: string; title: string; system: string; text: string; locator: string; score: number; needsConfirmation?: boolean }> = [];
  for (const manual of manuals) {
    if (manual.system !== system || manual.status === 'archived') continue;
    const revision = manual.revisions.find(item => item.id === manual.activeRevisionId) ?? manual.revisions.at(-1);
    if (!revision || revision.status === 'archived') continue;
    for (const block of revision.blocks) {
      const haystack = normalize(`${revision.title} ${block.heading ?? ''} ${block.text}`);
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      if (score) hits.push({ manualId: manual.id, revisionId: revision.id, blockId: block.id, title: revision.title, system, text: block.text, locator: block.source.locator, score, needsConfirmation: block.needsConfirmation });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN')).slice(0, Math.max(1, Math.min(limit, 100)));
}

export function tokenizeManualQuery(query: string): string[] {
  const text = normalize(query);
  const words = text.match(/[a-z0-9_./$-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  const tokens = new Set(words);
  for (const word of words) {
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
    }
  }
  return [...tokens].slice(0, 24);
}

export function tokenizeManualContent(content: string): string[] {
  const text = normalize(content);
  const words = text.match(/[a-z0-9_./$-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  const tokens = new Set(words);
  for (const word of words) {
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) tokens.add(word.slice(i, i + 2));
    }
  }
  return [...tokens];
}

export function buildManualChunks(input: { manual: OperationManual; blocks: ParsedManualBlock[]; maximumCharacters?: number }): ManualChunk[] {
  const maximumCharacters = input.maximumCharacters ?? 3600;
  const output: ManualChunk[] = [];
  const seen = new Set<string>();
  for (const block of input.blocks) {
    const paragraphs = block.text.split(/\n+/).map(line => line.trim()).filter(Boolean);
    const tableHeader = block.type === 'table' && block.locator.kind === 'xlsx' ? paragraphs[0] : undefined;
    let current: string[] = [];
    let currentLength = 0;
    const flush = () => {
      const content = current.join('\n').trim();
      if (!content) return;
      const contentHash = digest(`${JSON.stringify(block.locator)}\n${block.sectionPath.join(' / ')}\n${content}`);
      if (seen.has(contentHash)) { current = []; currentLength = 0; return; }
      seen.add(contentHash);
      output.push({
        id: randomUUID(), manualId: input.manual.id, productType: input.manual.productType,
        ...(input.manual.manualVersion ? { manualVersion: input.manual.manualVersion } : {}),
        ...(input.manual.productVersion ? { productVersion: input.manual.productVersion } : {}),
        ...(input.manual.effectiveDate ? { effectiveDate: input.manual.effectiveDate } : {}),
        sectionPath: [...block.sectionPath], locator: { ...block.locator }, content, contentHash,
        tokenEstimate: Math.ceil(Buffer.byteLength(content, 'utf8') / 3), ordinal: output.length,
      });
      current = []; currentLength = 0;
    };
    for (const paragraph of paragraphs) {
      if (paragraph.length > maximumCharacters) {
        flush();
        const includeHeader = !!tableHeader && paragraph !== tableHeader && tableHeader.length + 1 < maximumCharacters;
        const fragmentSize = includeHeader ? maximumCharacters - tableHeader.length - 1 : maximumCharacters;
        for (let offset = 0; offset < paragraph.length; offset += fragmentSize) {
          const fragment = paragraph.slice(offset, offset + fragmentSize);
          current = includeHeader ? [tableHeader!, fragment] : [fragment];
          flush();
        }
      } else {
        if (currentLength + paragraph.length > maximumCharacters) {
          flush();
          if (tableHeader && paragraph !== tableHeader && tableHeader.length + paragraph.length + 1 <= maximumCharacters) { current.push(tableHeader); currentLength = tableHeader.length + 1; }
        }
        current.push(paragraph); currentLength += paragraph.length + 1;
      }
    }
    flush();
  }
  return output;
}

export function isManualQuery(query: string): boolean {
  return /菜单|按钮|页面|功能入口|操作|怎么(?:操作|使用|配置|设置|处理|查询|查找)|如何|流程|步骤|前置条件|配置|权限|异常|报错|状态|是否支持|功能说明|报工|工单|扫码|库存|出库|入库|收货|领料|退料|盘点|上架|下架|拣货|发运|委外|手册|(?:^|[^a-z0-9])(?:SRM|JMOM|PDA)(?:$|[^a-z0-9])/i.test(query);
}

export function manualProductScope(override: 'auto' | ManualProductType | 'off' | undefined, detected?: string, query = ''): ManualProductType[] {
  if (override === 'off') return [];
  if (override && override !== 'auto') return [override, 'COMMON'];
  const mentioned = (['MES5', 'MES6', 'WMS', 'SRM', 'JMOM', 'PDA'] as const).filter(system => new RegExp(`(?:^|[^a-z0-9])${system}(?:$|[^a-z0-9])`, 'i').test(query));
  if (mentioned.length) return [...mentioned, 'COMMON'];
  if (/通用(?:产品)?(?:操作)?手册|通用操作说明/.test(query)) return ['COMMON'];
  return detected === 'MES5' || detected === 'MES6' || detected === 'WMS' ? [detected, 'COMMON'] : [];
}

export function hasManualVersionConflict(manuals: OperationManual[]): boolean {
  const uniqueManuals = [...new Map(manuals.map(manual => [manual.id, manual])).values()];
  if (uniqueManuals.length < 2) return false;
  const versionKeys = uniqueManuals.map(manual => JSON.stringify([
    manual.productVersion ?? '', manual.manualVersion ?? '', manual.effectiveDate ?? '',
  ]));
  const hasUnversionedManual = uniqueManuals.some(manual => !manual.productVersion && !manual.manualVersion && !manual.effectiveDate);
  return hasUnversionedManual || new Set(versionKeys).size > 1;
}

export function exportManualMarkdown(revision: OperationManualRevision): string {
  const lines = [`# ${revision.title}`, '', `> 系统：${revision.system}；版本：${revision.version}；状态：${revision.status}`, ''];
  for (const block of [...revision.blocks].sort((a, b) => a.order - b.order)) {
    if (block.heading) lines.push(`## ${block.heading}`, '');
    lines.push(block.text, '', `来源：${block.source.fileName} · ${block.source.locator}${block.needsConfirmation ? ' · 待确认' : ''}`, '');
  }
  return lines.join('\n');
}

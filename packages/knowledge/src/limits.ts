import type { ManagedDocument } from '../../domain/src';

export const MAX_DOCUMENT_CHARACTERS = 80000;
export const MAX_DICTIONARY_CHARACTERS = 2000000;

export function documentLimits(kind: ManagedDocument['kind']) {
  return kind === 'dictionary'
    ? { characters: MAX_DICTIONARY_CHARACTERS, fileBytes: 32 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, archiveBytes: 128 * 1024 * 1024, entries: 4096, sheets: 256, cells: 250000 }
    : { characters: MAX_DOCUMENT_CHARACTERS, fileBytes: 8 * 1024 * 1024, entryBytes: 4 * 1024 * 1024, archiveBytes: 16 * 1024 * 1024, entries: 512, sheets: 100, cells: 40000 };
}

export type DocumentLimits = ReturnType<typeof documentLimits>;

export function assertDocumentTextSize(content: string, kind: ManagedDocument['kind']): void {
  if (content.length > documentLimits(kind).characters) throw new Error(`文档提取文本超过 ${documentLimits(kind).characters} 字符，未导入也未截断；请拆分文档后重试。`);
}

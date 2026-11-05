export const DICTIONARY_PAGE_CHARACTERS = 32000;
const PAGE_LINES = 150;
export interface DictionarySection { name: string; start: number; end: number }
export interface DictionaryPage { section: number; start: number; end: number }

/** 只建立字符范围索引，正文保留原样；每一段内容均可通过页面访问。 */
export function indexDictionary(content: string, workbook: boolean) {
  const markers = workbook ? [...content.matchAll(/^\[工作表：([^\r\n]*)\]\r?$/gm)] : [];
  const sections: DictionarySection[] = [];
  if (!markers.length) sections.push({ name: '完整文档', start: 0, end: content.length });
  else {
    if (markers[0].index! > 0) sections.push({ name: '文件说明', start: 0, end: markers[0].index! });
    markers.forEach((marker, index) => sections.push({ name: marker[1], start: marker.index!, end: markers[index + 1]?.index ?? content.length }));
  }
  const pages: DictionaryPage[] = [];
  sections.forEach((section, sectionIndex) => {
    let start = section.start;
    while (start < section.end) {
      let end = Math.min(start + DICTIONARY_PAGE_CHARACTERS, section.end);
      let cursor = start;
      let lines = 0;
      while (lines < PAGE_LINES) {
        const newline = content.indexOf('\n', cursor);
        if (newline < 0 || newline >= end) break;
        cursor = newline + 1;
        lines += 1;
      }
      if (lines === PAGE_LINES) end = cursor;
      if (end < section.end && /[\uD800-\uDBFF]/.test(content[end - 1])) end -= 1;
      pages.push({ section: sectionIndex, start, end });
      start = end;
    }
  });
  if (!pages.length) pages.push({ section: 0, start: 0, end: 0 });
  return { sections, pages };
}

/** 全文匹配而非当前页匹配，索引包含全部命中，不静默丢弃尾部结果。 */
export function findOccurrences(content: string, query: string): number[] {
  if (!query) return [];
  const matches: number[] = [];
  let next = 0;
  for (;;) {
    const index = content.indexOf(query, next);
    if (index < 0) return matches;
    matches.push(index);
    next = index + 1;
  }
}

export function pageForOffset(pages: DictionaryPage[], offset: number) {
  let left = 0, right = pages.length - 1;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (pages[middle].end <= offset) left = middle + 1;
    else right = middle;
  }
  return left;
}

export function readableError(error: unknown) {
  let text = error instanceof Error ? error.message : String(error);
  for (let index = 0; index < 6; index += 1) {
    const cleaned = text.replace(/^Error:\s*/, '').replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/, '');
    if (cleaned === text) break;
    text = cleaned;
  }
  return text;
}

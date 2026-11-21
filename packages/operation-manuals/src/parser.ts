import path from 'node:path';
import { readDocumentTextFile } from '../../knowledge/src';
import type { ManualLocator, ParsedManualBlock, ParsedManualDocument } from './index';

const PARSER_VERSION = 'manual-parser-1';
const MAX_MANUAL_BYTES = 100 * 1024 * 1024;
const MAX_MANUAL_CHARACTERS = 2_000_000;
const MAX_BLOCK_CHARACTERS = 3_600;

interface SourceSection { locator: ManualLocator; lines: Array<{ text: string; line: number }> }

function headingLevel(line: string): { level: number; title: string } | undefined {
  const markdown = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  if (markdown) return { level: markdown[1].length, title: markdown[2].trim() };
  if (/^(第[一二三四五六七八九十百\d]+[章节部分]|\d+(?:\.\d+){0,4}[.、\s]|[一二三四五六七八九十]+[、.])/.test(line.trim()) && line.trim().length <= 100) return { level: 1, title: line.trim() };
  return undefined;
}

function sourceSections(content: string, extension: string): SourceSection[] {
  const lines = content.split(/\r?\n/);
  const result: SourceSection[] = [];
  let locator: ManualLocator = { kind: extension === '.html' || extension === '.htm' ? 'html' : extension === '.docx' ? 'docx' : 'text' };
  let current: SourceSection = { locator, lines: [] };
  let lineNumber = 0;
  let lastSlide = 0;
  const flush = () => {
    if (current.lines.some(line => line.text.trim())) result.push(current);
    current = { locator, lines: [] };
  };
  for (const line of lines) {
    lineNumber += 1;
    const marker = /^\[(?:第 (\d+) 页|工作表：([^\]]+)|幻灯片：([^\]]+)|演讲者备注：([^\]]+))\]$/.exec(line.trim());
    if (marker) {
      flush();
      if (marker[1]) locator = { kind: 'pdf', page: Number(marker[1]) };
      else if (marker[2]) locator = { kind: 'xlsx', sheet: marker[2].trim() };
      else if (marker[3]) {
        lastSlide = Number(marker[3]) || Number(/slide(\d+)/i.exec(marker[3])?.[1]) || result.filter(item => item.locator.kind === 'pptx').length + 1;
        locator = { kind: 'pptx', slide: lastSlide };
      } else {
        const notesSlide = Number(marker[4]) || Number(/slide(\d+)/i.exec(marker[4] ?? '')?.[1]);
        locator = { kind: 'pptx', slide: notesSlide || lastSlide || result.filter(item => item.locator.kind === 'pptx').length + 1 };
      }
      current = { locator, lines: [] };
      continue;
    }
    current.lines.push({ text: line, line: lineNumber });
  }
  flush();
  return result;
}

function cellRange(lines: string[]): string | undefined {
  const refs = lines.flatMap(line => [...line.matchAll(/\b([A-Z]{1,3}[1-9]\d{0,6})\b/g)].map(match => match[1]));
  if (!refs.length) return undefined;
  return refs.length === 1 ? refs[0] : `${refs[0]}:${refs.at(-1)}`;
}

function buildBlocks(sections: SourceSection[]): ParsedManualBlock[] {
  const blocks: ParsedManualBlock[] = [];
  const headingStack: string[] = [];
  const pushBlock = (type: ParsedManualBlock['type'], lines: Array<{ text: string; line: number }>, locator: ManualLocator, sectionPath: string[]) => {
    const text = lines.map(line => line.text).join('\n').trim();
    if (!text) return;
    const actualLocator = locator.kind === 'xlsx'
      ? { ...locator, range: cellRange(lines.map(line => line.text)) }
      : locator.kind === 'text' || locator.kind === 'docx' || locator.kind === 'html'
        ? { ...locator, lineStart: lines[0]?.line, lineEnd: lines.at(-1)?.line }
        : { ...locator };
    blocks.push({ type, text, sectionPath: [...sectionPath], locator: actualLocator, order: blocks.length });
  };

  for (const section of sections) {
    if (section.locator.kind === 'xlsx' || section.locator.kind === 'pptx') headingStack.length = 0;
    let pending: Array<{ text: string; line: number }> = [];
    let pendingLength = 0;
    let pendingType: ParsedManualBlock['type'] = section.locator.kind === 'xlsx' ? 'table' : 'paragraph';
    const flush = () => {
      if (pending.length) pushBlock(pendingType, pending, section.locator, headingStack);
      pending = [];
      pendingLength = 0;
    };
    for (const line of section.lines) {
      const text = line.text.trim();
      if (!text) { if (pending.length) { pending.push(line); pendingLength += 1; } continue; }
      const heading = headingLevel(text);
      if (heading) {
        flush();
        headingStack.length = Math.min(headingStack.length, heading.level - 1);
        headingStack[heading.level - 1] = heading.title;
        pushBlock('heading', [{ ...line, text: heading.title }], section.locator, headingStack.slice(0, heading.level));
        continue;
      }
      if (section.locator.kind === 'xlsx') {
        if (pendingLength + text.length > MAX_BLOCK_CHARACTERS) flush();
        pendingType = 'table'; pending.push({ ...line, text }); pendingLength += text.length + 1;
        continue;
      }
      const listLine = /^(?:[-*+]\s+|\d+[.)、]\s*|[一二三四五六七八九十]+[、.])/.test(text);
      const type: ParsedManualBlock['type'] = listLine ? 'list' : 'paragraph';
      if (pendingLength + text.length > MAX_BLOCK_CHARACTERS || (pending.length && type !== pendingType)) flush();
      pendingType = type; pending.push({ ...line, text }); pendingLength += text.length + 1;
    }
    flush();
  }
  return blocks;
}

export async function parseManualFile(filename: string): Promise<ParsedManualDocument> {
  const extension = path.extname(filename).toLowerCase();
  if (!['.pdf', '.docx', '.xlsx', '.pptx', '.md', '.txt', '.html', '.htm'].includes(extension)) throw new Error('当前仅支持 PDF、DOCX、XLSX、PPTX、MD、TXT、HTML 文件。旧版 DOC、XLS、PPT 请另存为新格式。');
  const snapshot = await readDocumentTextFile(filename, { maxCharacters: MAX_MANUAL_CHARACTERS, maxFileBytes: MAX_MANUAL_BYTES });
  if (!snapshot.content.trim()) throw new Error(extension === '.pdf' ? 'PDF 未提取到可检索文字，可能是扫描件，请先进行本地 OCR。' : '文档未提取到可检索文字。');
  const sections = sourceSections(snapshot.content, extension);
  const blocks = buildBlocks(sections);
  if (!blocks.length) throw new Error('文档未包含可检索内容。');
  const pages = blocks.filter(block => block.locator.kind === 'pdf').map(block => block.locator.kind === 'pdf' ? block.locator.page : 0);
  const sheets = new Set(blocks.flatMap(block => block.locator.kind === 'xlsx' ? [block.locator.sheet] : []));
  const slides = blocks.filter(block => block.locator.kind === 'pptx').map(block => block.locator.kind === 'pptx' ? block.locator.slide : 0);
  return {
    parserVersion: PARSER_VERSION,
    blocks,
    ...(pages.length ? { pageCount: Math.max(...pages) } : {}),
    ...(sheets.size ? { sheetCount: sheets.size } : {}),
    ...(slides.length ? { slideCount: Math.max(...slides) } : {}),
    extractedChars: snapshot.content.length,
    warnings: snapshot.embeddedImageCount
      ? [`检测到 ${snapshot.embeddedImageCount} 张嵌入图片，当前未进行 OCR，图片中的文字不会建立索引。`]
      : [],
  };
}

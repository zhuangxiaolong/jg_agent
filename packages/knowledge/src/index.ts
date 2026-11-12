import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ManagedDocument, ProductSystem } from '../../domain/src/index';
import { assertDocumentTextSize, documentLimits, MAX_DOCUMENT_CHARACTERS, MAX_DICTIONARY_CHARACTERS, type DocumentLimits } from './limits';

export { assertNoPlaintextCredentials } from './security';
export type { ManagedDocument, ProductSystem } from '../../domain/src/index';
export { MAX_DOCUMENT_CHARACTERS, MAX_DICTIONARY_CHARACTERS } from './limits';
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.sql']);
export const SUPPORTED_DOCUMENT_TEXT_EXTENSIONS = Object.freeze([...TEXT_EXTENSIONS, '.pdf', '.docx', '.xlsx', '.pptx']);
const SUPPORTED_DOCUMENT_TEXT_EXTENSION_SET = new Set(SUPPORTED_DOCUMENT_TEXT_EXTENSIONS);
const SYSTEMS = new Set<ProductSystem>(['MES5', 'MES6', 'WMS', '前端', '通用']);

export interface DocumentTextSnapshot {
  name: string;
  extension: string;
  content: string;
  digest: string;
  size: number;
}

export interface DocumentTextReadOptions {
  /** 提取文本的最大字符数，默认 80,000。不会截断，超限直接拒绝。 */
  maxCharacters?: number;
  /** 源文件最大字节数，默认 8 MiB。 */
  maxFileBytes?: number;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('binary');
    return content;
  } catch { throw new Error('文件包含非 UTF-8 编码或二进制内容，请先转换为 UTF-8 文本。'); }
}

function assertTextSize(content: string, kind: ManagedDocument['kind']): string {
  if (!content.trim()) throw new Error('文档未包含可导入的文本。');
  assertDocumentTextSize(content, kind);
  return content;
}

function parseXml(bytes: Uint8Array, preserveOrder = false, removeNSPrefix = true): any {
  const source = decodeUtf8(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('Office 文档包含不允许的 XML 实体或 DTD。');
  if (XMLValidator.validate(source) !== true) throw new Error('Office 文档 XML 损坏，无法完整解析。');
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix, parseTagValue: false, parseAttributeValue: false, trimValues: false, preserveOrder, processEntities: true }).parse(source);
}

function readOfficeArchive(bytes: Uint8Array, limits: DocumentLimits): Record<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  const names = new Set<string>();
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, { filter(file) {
      entries += 1;
      const name = file.name;
      if (entries > limits.entries || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').includes('..') || /[\x00-\x1f]/.test(name) || names.has(name)) throw new Error('Office 压缩包条目过多或路径不安全。');
      names.add(name);
      total += file.originalSize;
      if (file.originalSize > limits.entryBytes || total > limits.archiveBytes || file.originalSize > Math.max(file.size, 1) * 500) throw new Error('Office 文档解压容量超过限制，请拆分文档。');
      if (/vbaProject\.bin$|(?:^|\/)embeddings\//i.test(name)) throw new Error('不支持含宏或嵌入对象的 Office 文档，请导出为纯文本文档。');
      return /\.xml$|\.rels$/i.test(name);
    } });
  } catch (error) {
    if (error instanceof Error && /Office|不支持/.test(error.message)) throw error;
    throw new Error('Office 文档不是有效的 ZIP 格式，可能损坏或已加密。');
  }
  if (!archive['[Content_Types].xml']) throw new Error('文件缺少 Office 内容类型信息。');
  parseXml(archive['[Content_Types].xml']);
  return archive;
}

function array(value: any): any[] { return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]; }

function orderedWordText(nodes: any[], limits: DocumentLimits, depth = 0): string {
  if (depth > 100) throw new Error('Office 文档嵌套过深。');
  let output = '';
  for (const node of nodes) {
    for (const [name, children] of Object.entries(node)) {
      if (name === ':@') continue;
      if (name === '#text') output += String(children);
      else if (name === 'tab') output += '\t';
      else if (name === 'br' || name === 'cr') output += '\n';
      else if (name === 'instrText' || name === 'del' || name === 'delText') continue;
      else if (Array.isArray(children)) {
        output += orderedWordText(children, limits, depth + 1);
        if (name === 'p' || name === 'tr') output += '\n';
        else if (name === 'tc') output += '\t';
      }
      if (output.length > limits.characters) throw new Error(`文档提取文本超过 ${limits.characters} 字符，未导入也未截断；请拆分文档后重试。`);
    }
  }
  return output;
}

function extractDocx(archive: Record<string, Uint8Array>, limits: DocumentLimits): string {
  if (!archive['word/document.xml']) throw new Error('不是有效的 DOCX 文档，缺少正文。');
  const files = ['word/document.xml', ...Object.keys(archive).filter(name => /^word\/(?:header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/.test(name)).sort()];
  return files.map(name => {
    const parsed = parseXml(archive[name], true);
    if (name === 'word/document.xml' && !parsed.some((node: any) => node.document)) throw new Error('DOCX 正文结构无效。');
    const content = orderedWordText(parsed, limits).replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    return name === 'word/document.xml' ? content : `\n\n[${name}]\n${content}`;
  }).join('');
}

function textRuns(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  if (Object.hasOwn(node, '#text')) return String(node['#text']);
  if (Object.hasOwn(node, 't')) return array(node.t).map(textRuns).join('');
  if (node.r) return array(node.r).map(textRuns).join('');
  return '';
}

function extractXlsx(archive: Record<string, Uint8Array>, limits: DocumentLimits): string {
  if (!archive['xl/workbook.xml'] || !archive['xl/_rels/workbook.xml.rels']) throw new Error('不是有效的 XLSX 工作簿，缺少工作表目录。');
  const workbook = parseXml(archive['xl/workbook.xml']).workbook;
  const relations = parseXml(archive['xl/_rels/workbook.xml.rels']).Relationships;
  const byId = new Map<string, string>();
  for (const relation of array(relations?.Relationship)) {
    if (typeof relation['@_Id'] !== 'string' || typeof relation['@_Target'] !== 'string') throw new Error('XLSX 工作表关系格式无效。');
    if (relation['@_TargetMode'] === 'External') continue;
    const target = relation['@_Target'];
    const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target));
    if (!resolved.startsWith('xl/') || resolved.includes('..') || resolved.includes('\\')) throw new Error('XLSX 工作表路径超出文档范围。');
    byId.set(relation['@_Id'], resolved);
  }
  const strings = archive['xl/sharedStrings.xml'] ? array(parseXml(archive['xl/sharedStrings.xml']).sst?.si).map(textRuns) : [];
  const sheets = array(workbook?.sheets?.sheet);
  if (!sheets.length || sheets.length > limits.sheets) throw new Error(`XLSX 工作表数量为空或超过 ${limits.sheets}。`);
  const sections: string[] = [];
  let totalLength = 0;
  let cellCount = 0;
  for (const sheet of sheets) {
    const sheetPath = byId.get(sheet['@_id']);
    if (!sheetPath || !archive[sheetPath]) throw new Error('XLSX 工作表丢失或使用不支持的外部关系。');
    const worksheet = parseXml(archive[sheetPath]).worksheet;
    if (!worksheet) throw new Error('XLSX 工作表结构无效。');
    const lines = [`[工作表：${sheet['@_name'] ?? sheetPath}]`];
    for (const row of array(worksheet.sheetData?.row)) {
      const values: string[] = [];
      for (const cell of array(row.c)) {
        cellCount += 1;
        if (cellCount > limits.cells) throw new Error(`XLSX 单元格数量超过 ${limits.cells}，请拆分文档。`);
        const ref = cell['@_r'];
        if (typeof ref !== 'string' || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(ref)) throw new Error('XLSX 单元格坐标无效。');
        let value: string;
        if (cell['@_t'] === 's') {
          const reference = textRuns(cell.v).trim();
          if (!reference) value = ''; // 样式空单元格可标为共享字符串而没有 v，坐标仍完整保留。
          else {
            const index = Number(reference);
            if (!/^\d+$/.test(reference) || !Number.isSafeInteger(index) || index >= strings.length) throw new Error('XLSX 共享字符串索引无效。');
            value = strings[index];
          }
        } else if (cell['@_t'] === 'inlineStr') value = textRuns(cell.is);
        else value = cell.v === undefined ? '' : textRuns(cell.v);
        if (cell.f !== undefined) value = `[公式：${textRuns(cell.f)}；缓存值：${value}]`;
        values.push(`${ref}\t${value}`);
      }
      if (values.length) lines.push(values.join('\t'));
    }
    const section = lines.join('\n');
    totalLength += section.length + 2;
    if (totalLength - 2 > limits.characters) throw new Error(`文档提取文本超过 ${limits.characters} 字符，未导入也未截断；请拆分文档后重试。`);
    sections.push(section);
  }
  if (!cellCount) throw new Error('XLSX 工作簿未包含可导入的单元格。');
  return sections.join('\n\n');
}

function extractPptx(archive: Record<string, Uint8Array>, limits: DocumentLimits): string {
  if (!archive['ppt/presentation.xml'] || !archive['ppt/_rels/presentation.xml.rels']) throw new Error('不是有效的 PPTX 演示文稿，缺少演示文稿目录或关系。');
  const element = (node: any, localName: string): any => {
    if (!node || typeof node !== 'object') return undefined;
    const matches = Object.entries(node).filter(([name]) => !name.startsWith('@_') && name.split(':').at(-1) === localName);
    if (matches.length > 1) throw new Error('PPTX 演示文稿包含重复的结构节点。');
    return matches[0]?.[1];
  };
  const relations = (filename: string): Map<string, any> => {
    if (!archive[filename]) return new Map();
    const root = parseXml(archive[filename]).Relationships;
    if (!root) throw new Error('PPTX 关系文件结构无效。');
    const result = new Map<string, any>();
    for (const relation of array(root.Relationship)) {
      if (typeof relation['@_Id'] !== 'string' || !relation['@_Id'] || typeof relation['@_Target'] !== 'string' || !relation['@_Target'] || typeof relation['@_Type'] !== 'string' || result.has(relation['@_Id'])) throw new Error('PPTX 关系记录缺失或包含重复 ID。');
      result.set(relation['@_Id'], relation);
    }
    return result;
  };
  const resolvePart = (source: string, relation: any, kind: 'slide' | 'notesSlide'): string => {
    if (!relation || !['http://schemas.openxmlformats.org/officeDocument/2006/relationships/', 'http://purl.oclc.org/ooxml/officeDocument/relationships/'].some(prefix => relation['@_Type'] === prefix + kind) || relation['@_TargetMode'] && relation['@_TargetMode'] !== 'Internal') throw new Error('PPTX 幻灯片或备注关系丢失、无效或指向外部资源。');
    const target = relation['@_Target'];
    if (/[\\:%?#\x00-\x1f]/.test(target) || target.startsWith('//')) throw new Error('PPTX 关系路径超出演示文稿范围。');
    const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(source), target));
    const folder = kind === 'slide' ? 'ppt/slides/' : 'ppt/notesSlides/';
    if (!resolved.startsWith(folder) || resolved.slice(folder.length).includes('/') || !resolved.endsWith('.xml') || !archive[resolved]) throw new Error('PPTX 幻灯片或备注丢失，或关系路径超出文档范围。');
    return resolved;
  };
  const presentation = element(parseXml(archive['ppt/presentation.xml'], false, false), 'presentation');
  const slideList = element(presentation, 'sldIdLst');
  const slideIds = array(element(slideList, 'sldId'));
  if (!slideIds.length || slideIds.length > limits.sheets) throw new Error(`PPTX 幻灯片数量为空或超过 ${limits.sheets}。`);
  const byId = relations('ppt/_rels/presentation.xml.rels');
  const seenIds = new Set<string>(); const seenTargets = new Set<string>(); const seenSlideIds = new Set<string>();
  const slides = slideIds.map(slide => {
    const ids = Object.entries(slide ?? {}).filter(([name]) => /^@_[^:]+:id$/.test(name));
    const id = ids[0]?.[1]; const slideId = slide?.['@_id'];
    if (ids.length !== 1 || typeof id !== 'string' || !id || seenIds.has(id) || typeof slideId !== 'string' || !/^\d+$/.test(slideId) || seenSlideIds.has(slideId)) throw new Error('PPTX 幻灯片顺序记录缺失或重复。');
    const target = resolvePart('ppt/presentation.xml', byId.get(id), 'slide');
    if (seenTargets.has(target)) throw new Error('PPTX 多个幻灯片关系指向同一页面。');
    seenIds.add(id); seenTargets.add(target); seenSlideIds.add(slideId);
    return target;
  });
  const sections: string[] = [];
  let totalLength = 0;
  for (const name of slides) {
    const parsed = parseXml(archive[name], true);
    const content = orderedWordText(parsed, limits).replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (content) sections.push(`[幻灯片：${name}]\n${content}`);
    totalLength += content.length;
    if (totalLength > limits.characters) throw new Error(`文档提取文本超过 ${limits.characters} 字符，未导入也未截断；请拆分文档后重试。`);
    const slideRelations = relations(path.posix.join(path.posix.dirname(name), '_rels', path.posix.basename(name) + '.rels'));
    const notes = [...slideRelations.values()].filter(relation => /\/notesSlide$/.test(relation['@_Type']));
    if (notes.length > 1) throw new Error('PPTX 幻灯片包含重复的备注关系。');
    for (const note of notes) {
      const notePath = resolvePart(name, note, 'notesSlide');
      const noteContent = orderedWordText(parseXml(archive[notePath], true), limits).replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (noteContent) sections.push(`[演讲者备注：${notePath}]\n${noteContent}`);
    }
  }
  if (!sections.length) throw new Error('PPTX 演示文稿未包含可导入的文字。');
  return sections.join('\n\n');
}

async function extractPdf(bytes: Uint8Array, limits: DocumentLimits): Promise<string> {
  if (Buffer.from(bytes.subarray(0, 8)).toString('ascii', 0, 5) !== '%PDF-') throw new Error('PDF 文件头无效或文件已损坏。');
  const load = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ getDocument: (options: Record<string, unknown>) => { promise: Promise<any> } }>;
  const { getDocument } = await load('pdfjs-dist/legacy/build/pdf.mjs');
  let document: any;
  try {
    document = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true, isEvalSupported: false, disableFontFace: true, stopAtErrors: true }).promise;
    if (document.numPages > limits.sheets) throw new Error(`PDF 页数超过 ${limits.sheets}，请拆分文档。`);
    const pages: string[] = [];
    let total = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
      const line = content.items.filter((item: any) => typeof item.str === 'string').map((item: any) => item.str).join(' ').trim();
      if (line) pages.push(`[第 ${pageNumber} 页]\n${line}`);
      total += line.length;
      if (total > limits.characters) throw new Error(`文档提取文本超过 ${limits.characters} 字符，未导入也未截断；请拆分文档后重试。`);
    }
    if (!pages.length) throw new Error('PDF 文档未包含可提取的文字，可能是扫描图片；请先进行 OCR。');
    return pages.join('\n\n');
  } catch (error) {
    if (error instanceof Error && /超过|未包含/.test(error.message)) throw error;
    if ((error as { name?: string }).name === 'PasswordException') throw new Error('不支持加密 PDF，请先解除密码保护后重试。');
    throw new Error('PDF 文档损坏、加密或使用不受支持的编码，无法解析。');
  } finally { await document?.destroy().catch(() => undefined); }
}

function extractionLimits(options: DocumentTextReadOptions = {}): DocumentLimits {
  const maxCharacters = options.maxCharacters ?? MAX_DOCUMENT_CHARACTERS;
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > MAX_DICTIONARY_CHARACTERS) throw new Error(`文本字符上限必须为 1–${MAX_DICTIONARY_CHARACTERS}。`);
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 32 * 1024 * 1024) throw new Error('文档文件上限必须为 1–32 MiB。');
  // 字符上限决定正文/字典的解析预算；单独放宽源文件字节上限时仍保持正文的 ZIP 解压预算，避免目录 broker 因允许 16 MiB 文件而意外获得字典级 128 MiB 解压预算。
  const base = documentLimits(maxCharacters > MAX_DOCUMENT_CHARACTERS ? 'dictionary' : 'requirement');
  return { ...base, characters: maxCharacters, fileBytes: maxFileBytes };
}

async function extractDocumentContent(extension: string, bytes: Uint8Array, limits: DocumentLimits): Promise<string> {
  if (TEXT_EXTENSIONS.has(extension)) return decodeUtf8(bytes);
  if (extension === '.pdf') return extractPdf(bytes, limits);
  const archive = readOfficeArchive(bytes, limits);
  if (extension === '.docx') return extractDocx(archive, limits);
  if (extension === '.xlsx') return extractXlsx(archive, limits);
  if (extension === '.pptx') return extractPptx(archive, limits);
  throw new Error('当前仅支持 MD、TXT、JSON、CSV、SQL、PDF、DOCX、XLSX、PPTX；旧版 XLS/PPT 请另存为新格式。');
}

async function readFileSnapshot(filename: string, limits: DocumentLimits): Promise<{ bytes: Buffer; name: string; extension: string }> {
  const original = await lstat(filename);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('仅允许只读导入普通文件，不支持符号链接。');
  if (original.size > limits.fileBytes) throw new Error(`文档文件超过 ${limits.fileBytes / 1024 / 1024} MiB，未导入；请拆分后重试。`);
  const canonical = await realpath(filename); const handle = await open(canonical, 'r');
  let bytes: Buffer;
  try {
    const current = await handle.stat();
    const unchanged = (value: typeof current) => value.isFile() && !value.isSymbolicLink() && value.ino === original.ino && value.dev === original.dev && value.size === original.size && value.mtimeMs === original.mtimeMs && value.ctimeMs === original.ctimeMs;
    if (!unchanged(current)) throw new Error('导入文件已变化，请重新选择。');
    const buffer = Buffer.alloc(current.size); let offset = 0;
    while (offset < buffer.length) { const result = await handle.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset !== current.size || !unchanged(await handle.stat()) || !unchanged(await lstat(filename))) throw new Error('读取期间源文件发生变化，未保存不完整快照；请重新导入。');
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  return { bytes, name: path.basename(filename), extension: path.extname(filename).toLowerCase() };
}

/** 读取本地文档正文的只读快照，不绑定知识库 kind，也不拦截业务资料中的字段示例。 */
export async function readDocumentTextFile(filename: string, options: DocumentTextReadOptions = {}): Promise<DocumentTextSnapshot> {
  const limits = extractionLimits(options);
  const snapshot = await readFileSnapshot(filename, limits);
  if (!SUPPORTED_DOCUMENT_TEXT_EXTENSION_SET.has(snapshot.extension)) throw new Error('当前仅支持 MD、TXT、JSON、CSV、SQL、PDF、DOCX、XLSX、PPTX；旧版 DOC/XLS/PPT 请另存为新格式。');
  const content = await extractDocumentContent(snapshot.extension, snapshot.bytes, limits);
  if (!content.trim()) throw new Error('文档未包含可导入的文本。');
  if (content.length > limits.characters) throw new Error(`文档提取文本超过 ${limits.characters} 字符，未导入也未截断；请拆分文档后重试。`);
  return { name: snapshot.name, extension: snapshot.extension, content, digest: createHash('sha256').update(snapshot.bytes).digest('hex'), size: snapshot.bytes.length };
}

/** 读取用户明确选择的本地资料；只在内存解析，不解压到磁盘、不执行宏、公式或链接。 */
export async function importDocumentFile(filename: string, kind: ManagedDocument['kind'], system: ProductSystem): Promise<ManagedDocument> {
  if (!['dictionary', 'requirement'].includes(kind) || !SYSTEMS.has(system)) throw new Error('文档类型或适用系统无效。');
  const limits = documentLimits(kind);
  const snapshot = await readDocumentTextFile(filename, { maxCharacters: limits.characters, maxFileBytes: limits.fileBytes });
  if (!SUPPORTED_DOCUMENT_TEXT_EXTENSION_SET.has(snapshot.extension)) throw new Error('当前仅支持 MD、TXT、JSON、CSV、SQL、PDF、DOCX、XLSX、PPTX；旧版 DOC/XLS/PPT 请另存为新格式。');
  const content = assertTextSize(snapshot.content, kind);
  return { id: randomUUID(), kind, system, name: snapshot.name, content, digest: snapshot.digest, createdAt: new Date().toISOString(), enabled: true };
}

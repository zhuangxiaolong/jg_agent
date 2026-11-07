import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ManagedDocument, ProductSystem } from '../../domain/src/index';
import { assertDocumentTextSize, documentLimits, type DocumentLimits } from './limits';

export { assertNoPlaintextCredentials } from './security';
export type { ManagedDocument, ProductSystem } from '../../domain/src/index';
export { MAX_DOCUMENT_CHARACTERS, MAX_DICTIONARY_CHARACTERS } from './limits';
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.sql']);
const SYSTEMS = new Set<ProductSystem>(['MES5', 'MES6', 'WMS', '通用']);

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

function parseXml(bytes: Uint8Array, preserveOrder = false): any {
  const source = decodeUtf8(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('Office 文档包含不允许的 XML 实体或 DTD。');
  if (XMLValidator.validate(source) !== true) throw new Error('Office 文档 XML 损坏，无法完整解析。');
  return new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, trimValues: false, preserveOrder, processEntities: true }).parse(source);
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

/** 读取用户明确选择的本地资料；只在内存解析，不解压到磁盘、不执行宏、公式或链接。 */
export async function importDocumentFile(filename: string, kind: ManagedDocument['kind'], system: ProductSystem): Promise<ManagedDocument> {
  if (!['dictionary', 'requirement'].includes(kind) || !SYSTEMS.has(system)) throw new Error('文档类型或适用系统无效。');
  const limits = documentLimits(kind);
  const extension = path.extname(filename).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && !['.xlsx', '.docx'].includes(extension)) throw new Error('当前支持 MD、TXT、JSON、CSV、SQL、XLSX、DOCX；请将其他格式转换后导入。');
  const original = await lstat(filename);
  if (!original.isFile() || original.isSymbolicLink()) throw new Error('仅允许只读导入普通文件，不支持符号链接。');
  if (original.size > limits.fileBytes) throw new Error(`文档文件超过 ${limits.fileBytes / 1024 / 1024} MiB，未导入；请拆分后重试。`);
  const canonical = await realpath(filename);
  const handle = await open(canonical, 'r');
  let bytes: Buffer;
  try {
    const current = await handle.stat();
    const unchanged = (value: typeof current) => value.isFile() && !value.isSymbolicLink() && value.ino === original.ino && value.dev === original.dev && value.size === original.size && value.mtimeMs === original.mtimeMs && value.ctimeMs === original.ctimeMs;
    if (!unchanged(current)) throw new Error('导入文件已变化，请重新选择。');
    const buffer = Buffer.alloc(current.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== current.size || !unchanged(await handle.stat()) || !unchanged(await lstat(filename))) throw new Error('读取期间源文件发生变化，未保存不完整快照；请重新导入。');
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  let content: string;
  if (TEXT_EXTENSIONS.has(extension)) content = decodeUtf8(bytes);
  else {
    const archive = readOfficeArchive(bytes, limits);
    content = extension === '.docx' ? extractDocx(archive, limits) : extractXlsx(archive, limits);
  }
  content = assertTextSize(content, kind);
  return { id: randomUUID(), kind, system, name: path.basename(filename), content, digest: createHash('sha256').update(bytes).digest('hex'), createdAt: new Date().toISOString(), enabled: true };
}

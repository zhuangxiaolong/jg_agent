import { createHash } from 'node:crypto';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { MappingParseOptions, MappingSourcePreview } from '../../domain/src';

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 512;
const array = (value: any): any[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, trimValues: false, attributeNamePrefix: '@_' });
function parseXml(bytes?: Uint8Array): any {
  if (!bytes) return {};
  const source = strFromU8(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source) || XMLValidator.validate(source) !== true) throw new Error('XLSX XML 损坏或包含不允许的实体');
  return xml.parse(source);
}
function text(node: any): string {
  if (node === undefined || node === null) return '';
  if (typeof node !== 'object') return String(node);
  if (node['#text'] !== undefined) return String(node['#text']);
  return array(node.t ?? node.r).map(text).join('');
}

/** 保留原始空行和空格，原始业务行号由解析结果携带。 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  if (delimiter.length !== 1) throw new Error('CSV 分隔符必须是单个字符');
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) { if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"' && cell.length === 0) { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') { if (ch === '\r' && source[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseSourceData(fileName: string, bytes: Uint8Array, options: MappingParseOptions = {}): { preview: MappingSourcePreview; rows: string[][]; sourceRowNumbers: number[] } {
  if (bytes.length > 32 * 1024 * 1024) throw new Error('源文件超过 32 MiB，无法安全解析');
  const extension = path.extname(fileName).toLowerCase();
  const warnings: string[] = []; const formulaRows = new Set<number>(); const uncachedFormulaRows = new Map<number, number>(); let rows: string[][] = []; let rowNumbers: number[] = []; let sheetName = 'CSV';
  let sheets: Array<{ name: string; hidden: boolean }> = []; let hidden = 0;
  if (extension === '.csv') {
    let source: string;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('CSV 不是 UTF-8 编码，请另存为 UTF-8 后重试'); }
    rows = parseCsv(source); rowNumbers = rows.map((_, index) => index + 1);
  } else if (extension === '.xlsx') {
    let size = 0; let entries = 0;
    const archive = unzipSync(bytes, { filter(file) {
      size += file.originalSize; entries++;
      if (entries > 10000 || file.originalSize > 64 * 1024 * 1024 || size > 128 * 1024 * 1024 || file.originalSize > Math.max(1, file.size) * 500) throw new Error('XLSX 解压容量超过安全限制');
      if (file.name.startsWith('/') || file.name.includes('\\') || file.name.split('/').includes('..')) throw new Error('XLSX 包含不安全路径');
      return /\.xml$|\.rels$/.test(file.name);
    } });
    const workbook = parseXml(archive['xl/workbook.xml']).workbook;
    const relations = new Map(array(parseXml(archive['xl/_rels/workbook.xml.rels']).Relationships?.Relationship).filter(item => item['@_TargetMode'] !== 'External').map(item => [item['@_Id'], item['@_Target']]));
    const available = array(workbook?.sheets?.sheet).map(item => {
      const target = String(relations.get(item['@_r:id']) ?? '');
      return { name: String(item['@_name']), hidden: ['hidden', 'veryHidden'].includes(item['@_state']), path: target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`) };
    });
    sheets = available.map(({ name, hidden }) => ({ name, hidden }));
    const selected = options.sheetName ? available.find(item => item.name === options.sheetName) : available.find(item => !item.hidden) ?? available[0];
    if (!selected || !archive[selected.path]) throw new Error('XLSX 未找到指定的可读工作表');
    sheetName = selected.name;
    if (selected.hidden) warnings.push('当前工作表为隐藏工作表，已按明确选择解析');
    if (sheets.some(item => item.hidden)) warnings.push('工作簿包含隐藏工作表');
    const shared = array(parseXml(archive['xl/sharedStrings.xml']).sst?.si).map(text);
    const sheet = parseXml(archive[selected.path]).worksheet;
    if (sheet?.mergeCells) warnings.push('工作表存在合并单元格；仅保留左上角原始值，不自动填充');
    if (array(sheet?.cols?.col).some(item => item['@_hidden'] === '1')) warnings.push('工作表存在隐藏列，已保留');
    let previous = 0;
    for (const row of array(sheet?.sheetData?.row)) {
      const rowNo = Number(row['@_r'] ?? previous + 1); previous = rowNo;
      if (!Number.isInteger(rowNo) || rowNo < 1) throw new Error('XLSX 行号无效');
      const values: string[] = [];
      if (row['@_hidden'] === '1') { hidden++; }
      for (const cell of array(row.c)) {
        const match = /^([A-Z]+)\d+$/.exec(cell['@_r'] ?? '');
        if (!match) throw new Error('XLSX 单元格地址无效');
        let column = 0; for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
        if (column > MAX_COLUMNS) throw new Error('数据超过 512 列，请拆分后重试');
        const value = cell['@_t'] === 's' ? shared[Number(text(cell.v))] ?? '' : cell['@_t'] === 'inlineStr' ? text(cell.is) : text(cell.v);
        values[column - 1] = value;
        if (cell.f !== undefined) {
          formulaRows.add(rowNo);
          if (cell.v === undefined) {
            uncachedFormulaRows.set(rowNo, (uncachedFormulaRows.get(rowNo) ?? 0) + 1);
            warnings.push(`${match[0]} 公式 =${text(cell.f).slice(0, 200)} 没有缓存值；未执行公式，须在表格软件中重算后再导出`);
          } else warnings.push(`${match[0]} 使用公式缓存值，未执行公式`);
        }
        if (cell['@_s'] !== undefined && cell['@_t'] !== 's' && cell['@_t'] !== 'inlineStr') warnings.push(`${match[0]} 为数值/日期样式；保留原始缓存值，需预览确认格式`);
      }
      rows.push(Array.from({ length: values.length }, (_, index) => values[index] ?? '')); rowNumbers.push(rowNo);
    }
    if (hidden) warnings.push(`${hidden} 个隐藏行已保留，未自动删除`);
    if (workbook?.workbookPr?.['@_date1904'] === '1') warnings.push('工作簿使用 1904 日期系统；日期序列保留原值，未自动转换');
  } else throw new Error('仅支持 CSV 和 XLSX 源文件');
  const firstNonempty = rows.findIndex(row=>row.some(value=>value.trim()));
  const headerIndex = options.headerRow ?? (rowNumbers[firstNonempty] ?? 1)-1; const dataIndex = options.dataStartRow ?? headerIndex + 1;
  if (!Number.isInteger(headerIndex) || headerIndex < 0 || !Number.isInteger(dataIndex) || dataIndex <= headerIndex) throw new Error('表头行和数据起始行设置无效');
  // XLSX 以真实工作表行号选择，CSV 以原始记录序号选择。
  const headerPosition = rowNumbers.indexOf(headerIndex + 1);
  const headers = rows[headerPosition] ?? [];
  if (!headers.length || headers.every(value => !value.trim())) throw new Error('指定表头行没有可用字段');
  if (headers.length > MAX_COLUMNS) throw new Error('数据超过 512 列，请拆分后重试');
  const selectedRows = rows.flatMap((row, index) => rowNumbers[index] >= dataIndex + 1 && (row.some(value => value !== '') || formulaRows.has(rowNumbers[index])) ? [{ row, number: rowNumbers[index] }] : []);
  const skipped = rows.filter((row,index)=>rowNumbers[index]>=dataIndex+1 && !row.some(value=>value!=='') && !formulaRows.has(rowNumbers[index])).length;
  if(skipped) warnings.push(`${skipped} 个完全空白行未参与转换，原始行号已保留`);
  if (selectedRows.length > MAX_ROWS) throw new Error('数据超过 100000 行，请拆分后重试；未截断数据');
  const structureValid = !selectedRows.some(item => item.row.length > headers.length);
  if(!structureValid) warnings.push('数据行包含超出当前表头的列；请展开行设置并重新选择表头，修正前禁止导出');
  const labels = headers.map((label, index) => label.trim() || `第${index + 1}列`);
  if (new Set(labels).size !== labels.length) warnings.push('表头包含重名字段，请依照列位置核对映射');
  const data = selectedRows.map(item => Array.from({length:Math.max(headers.length,item.row.length)},(_,index)=>item.row[index]??''));
  const sourceRowNumbers = selectedRows.map(item => item.number);
  const uncachedFormulaCount = (uncachedFormulaRows.get(headerIndex + 1) ?? 0) + selectedRows.reduce((sum, item) => sum + (uncachedFormulaRows.get(item.number) ?? 0), 0);
  const columns = labels.map((label, index) => ({ key: `col_${index + 1}`, label, sampleValues: data.slice(0, 5).map(row => row[index]) }));
  return { preview: { fileName: path.basename(fileName), digest: createHash('sha256').update(bytes).digest('hex'), sheetName, columns, rows: data.slice(0, 20), totalRows: data.length, hiddenRowsIgnored: 0, sheets, warnings: [...new Set(warnings)].slice(0, 100), headerRow: headerIndex, dataStartRow: dataIndex, sourceRowNumbers: sourceRowNumbers.slice(0, 20), structureValid, uncachedFormulaCount }, rows: data, sourceRowNumbers };
}

export function parseSourceBytes(fileName: string, bytes: Uint8Array, options?: MappingParseOptions): MappingSourcePreview { return parseSourceData(fileName, bytes, options).preview; }

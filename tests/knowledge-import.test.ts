import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strToU8, zipSync } from 'fflate';
import { importDocumentFile, readDocumentTextFile } from '../packages/knowledge/src/index';

const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries({ '[Content_Types].xml': contentTypes, ...files }).map(([name, value]) => [name, strToU8(value)])));
const pptxPresentation = '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>';
const pptxRelationships = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>';
const pptxSlide = (text: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

function simplePdf(text: string): Buffer {
  const objects = [`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`, `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`, `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`, `4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`, `5 0 obj\n<< /Length ${text.length + 11} >>\nstream\nBT /F1 12 Tf (${text}) Tj ET\nendstream\nendobj\n`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(output, 'latin1')); output += object; }
  const start = Buffer.byteLength(output, 'latin1'); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output, 'latin1');
}

test('导入 UTF-8 原文保留内容、系统、SHA256来源及密码Token示例；格式、编码、容量错误明确拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), '精工知识导入 '));
  try {
    for (const [extension, content] of Object.entries({ md: '# 中文字段\nQTY 表示数量。\n', txt: '工序状态说明\n', json: '{"table":"SFCS","columns":["QTY"]}\n', csv: '字段,类型\nQTY,NUMBER\n', sql: 'CREATE TABLE SAMPLE(QTY NUMBER);\n' })) {
      const filename = join(root, `字典.${extension}`);
      await writeFile(filename, content);
      const imported = await importDocumentFile(filename, 'dictionary', 'MES5');
      assert.equal(imported.content, content);
      assert.equal(imported.system, 'MES5');
      assert.equal(imported.kind, 'dictionary');
      assert.equal(imported.enabled, true);
      assert.match(imported.id, /^[a-f0-9-]{36}$/);
      assert.equal(imported.digest, createHash('sha256').update(await readFile(filename)).digest('hex'));
    }
    const file = join(root, '问题.txt');
    for (const content of ['password="not-a-real-password"', 'API Key：synthetic-key-only', '密码：仅测试合成值', 'Authorization: Bearer synthetic-token-only-12345', 'https://tester:dummy-password@example.invalid', 'username,password\ntest,synthetic-value', '-----BEGIN PRIVATE KEY-----']) {
      await writeFile(file, content);
      assert.equal((await importDocumentFile(file, 'requirement', '通用')).content, content);
    }
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    await assert.rejects(importDocumentFile(file, 'dictionary', 'MES6'), /UTF-8/);
    await writeFile(file, 'x'.repeat(80001));
    await assert.rejects(importDocumentFile(file, 'requirement', 'MES6'), /80000.*未.*截断/);
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(importDocumentFile(file, 'requirement', 'MES6'), /8 MiB/);
    await writeFile(join(root, '不支持.pdf'), Buffer.from('not-pdf'));
    await assert.rejects(importDocumentFile(join(root, '不支持.pdf'), 'dictionary', 'MES6'), /PDF/);
    await assert.rejects(importDocumentFile(file, 'invalid' as never, 'MES6'), /类型/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('通用文档正文快照提取 PDF 与 PPTX，保留页/幻灯片边界且不绑定知识库凭据策略', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-document-text-'));
  try {
    const pdf = join(root, '简历.pdf'); await writeFile(pdf, simplePdf('Password field is a job requirement example'));
    const pdfSnapshot = await readDocumentTextFile(pdf);
    assert.match(pdfSnapshot.content, /Password field is a job requirement example/);
    assert.equal(pdfSnapshot.extension, '.pdf');
    const importedPdf = await importDocumentFile(pdf, 'requirement', 'MES6');
    assert.match(importedPdf.content, /Password field is a job requirement example/);
    const pptx = join(root, '汇报.pptx');
    await writeFile(pptx, zip({
      'ppt/presentation.xml': pptxPresentation,
      'ppt/_rels/presentation.xml.rels': pptxRelationships,
      'ppt/slides/slide1.xml': pptxSlide('MES 实施计划'),
      'ppt/slides/slide2.xml': pptxSlide('WMS 上线验收'),
      'ppt/slides/slide3.xml': pptxSlide('孤立页面不得读入'),
      'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="note1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>',
      'ppt/notesSlides/notesSlide2.xml': pptxSlide('第二页对应备注'),
      'ppt/notesSlides/notesSlide3.xml': pptxSlide('孤立备注不得读入')
    }));
    const pptSnapshot = await readDocumentTextFile(pptx);
    assert.match(pptSnapshot.content, /幻灯片：ppt\/slides\/slide1\.xml/);
    assert.match(pptSnapshot.content, /MES 实施计划/);
    assert.match(pptSnapshot.content, /WMS 上线验收/);
    assert.ok(pptSnapshot.content.indexOf('WMS 上线验收') < pptSnapshot.content.indexOf('MES 实施计划'), '使用 presentation.xml 的真实页序，不按部件文件编号排序');
    assert.match(pptSnapshot.content, /第二页对应备注/);
    assert.doesNotMatch(pptSnapshot.content, /孤立页面|孤立备注/);
    const legacyXls = join(root, '旧工作簿.xls'); await writeFile(legacyXls, Buffer.from('binary placeholder'));
    await assert.rejects(readDocumentTextFile(legacyXls), /旧版 DOC\/XLS\/PPT.*另存为新格式/);
    const legacyPpt = join(root, '旧演示文稿.ppt'); await writeFile(legacyPpt, Buffer.from('binary placeholder'));
    await assert.rejects(readDocumentTextFile(legacyPpt), /旧版 DOC\/XLS\/PPT.*另存为新格式/);
    const legacyDoc = join(root, '旧文档.doc'); await writeFile(legacyDoc, Buffer.from('binary placeholder'));
    await assert.rejects(readDocumentTextFile(legacyDoc), /旧版 DOC\/XLS\/PPT.*另存为新格式/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('PPTX 拒绝缺失、重复、外部和逃逸的幻灯片关系', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-pptx-relations-'));
  const file = join(root, '异常.pptx');
  const valid = { 'ppt/presentation.xml': pptxPresentation, 'ppt/_rels/presentation.xml.rels': pptxRelationships, 'ppt/slides/slide1.xml': pptxSlide('第一页面'), 'ppt/slides/slide2.xml': pptxSlide('第二页面') };
  try {
    const cases = [
      { ...valid, 'ppt/_rels/presentation.xml.rels': '' },
      { ...valid, 'ppt/presentation.xml': pptxPresentation.replace('r:id="rId2"', 'r:id="missing"') },
      { ...valid, 'ppt/presentation.xml': pptxPresentation.replace('r:id="rId2"', 'r:id="rId1"') },
      { ...valid, 'ppt/_rels/presentation.xml.rels': pptxRelationships.replace('Id="rId2"', 'Id="rId1"') },
      { ...valid, 'ppt/_rels/presentation.xml.rels': pptxRelationships.replace('Target="slides/slide2.xml"', 'Target="slides/slide1.xml"') },
      { ...valid, 'ppt/_rels/presentation.xml.rels': pptxRelationships.replace('Target="slides/slide2.xml"', 'Target="../../outside.xml"'), 'outside.xml': pptxSlide('外部内容') },
      { ...valid, 'ppt/_rels/presentation.xml.rels': pptxRelationships.replace('Target="slides/slide2.xml"', 'TargetMode="External" Target="https://example.invalid/slide.xml"') },
    ];
    for (const files of cases) {
      await writeFile(file, zip(files));
      await assert.rejects(readDocumentTextFile(file), /PPTX|Office/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实 DOCX ZIP/XML 提取正文、表格和页眉，不执行或下载外部资源', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-docx-'));
  try {
    const filename = join(root, '需求.docx');
    await writeFile(filename, zip({
      'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>验收要求 &amp; 中文</w:t></w:r></w:p><w:p><w:r><w:t>库存必须大于零。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>字段 QTY</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
      'word/header1.xml': '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>MES6 需求版本</w:t></w:r></w:p></w:hdr>'
    }));
    const imported = await importDocumentFile(filename, 'requirement', 'MES6');
    assert.match(imported.content, /验收要求 & 中文/);
    assert.match(imported.content, /库存必须大于零/);
    assert.match(imported.content, /字段 QTY/);
    assert.match(imported.content, /MES6 需求版本/);
    assert.equal(imported.system, 'MES6');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('真实 XLSX 解析工作表关系、共享字符串、富文本、内联字符串、数字及公式缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-xlsx-'));
  try {
    const filename = join(root, '数据字典.xlsx');
    await writeFile(filename, zip({
      'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工单" sheetId="1" r:id="rId1"/><sheet name="物料" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>QTY</t></si><si><r><t>生产</t></r><r><t>数量</t></r></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>允许为空：否</t></is></c><c r="B2"><v>123.45</v></c><c r="C2"><f>1+2</f><v>3</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>物料编码</t></is></c></row></sheetData></worksheet>'
    }));
    const imported = await importDocumentFile(filename, 'dictionary', 'WMS');
    for (const text of ['工作表：工单', '工作表：物料', 'QTY', '生产数量', '允许为空：否', '123.45', '公式：1+2；缓存值：3', '物料编码']) assert.ok(imported.content.includes(text), text);
    assert.equal(imported.system, 'WMS');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Office 缺失工作表、DTD实体、路径逃逸、宏、压缩炸弹及损坏文件均拒绝且不截断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-office-deny-'));
  try {
    const filename = join(root, '不安全.docx');
    for (const [bytes, expected] of [
      [zip({ 'word/document.xml': '<!DOCTYPE doc [<!ENTITY x "value">]><document>&x;</document>' }), /实体|DTD/],
      [zip({ '../outside.xml': '<bad/>', 'word/document.xml': '<document/>' }), /路径/],
      [zip({ 'word/vbaProject.bin': 'macro', 'word/document.xml': '<document/>' }), /宏/],
      [zip({ 'word/document.xml': '<document>' + 'x'.repeat(5 * 1024 * 1024) + '</document>' }), /容量/],
      [zip({ 'word/document.xml': '<document><p>broken</document>' }), /损坏/],
      [Buffer.from('not-a-zip'), /ZIP/]
    ] as const) {
      await writeFile(filename, bytes);
      await assert.rejects(importDocumentFile(filename, 'requirement', '通用'), expected);
    }
    const xlsx = join(root, '缺少工作表.xlsx');
    await writeFile(xlsx, zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="missing" id="x"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships/>' }));
    await assert.rejects(importDocumentFile(xlsx, 'dictionary', 'MES5'), /丢失|外部/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('用户选择的硬链接资料只读快照导入，源内容和链接身份不变，符号链接仍拒绝', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-snapshot-'));
  try {
    const source = join(root, '源资料.md'); const selected = join(root, '选择的硬链接.md');
    const content = '# 数据字典\n字段说明正文。';
    await writeFile(source, content); await link(source, selected);
    const before = await lstat(source);
    assert.ok(before.nlink > 1);
    const imported = await importDocumentFile(selected, 'dictionary', 'MES5');
    assert.equal(imported.content, content);
    assert.equal(imported.digest, createHash('sha256').update(content).digest('hex'));
    assert.equal(await readFile(source, 'utf8'), content);
    const after = await lstat(source);
    for (const attribute of ['ino', 'dev', 'size', 'mtimeMs', 'ctimeMs', 'nlink'] as const) assert.equal(after[attribute], before[attribute]);
    const symbolic = join(root, '符号链接.md');
    try { await symlink(source, symbolic, 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('当前用户不能创建符号链接；硬链接快照已真实验证'); return; } throw error; }
    await assert.rejects(importDocumentFile(symbolic, 'dictionary', 'MES5'), /符号链接/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('大型字典完整保留超过4MiB XML、40k单元格及80k文本，样式空共享单元格不误读首个字符串', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-large-dictionary-'));
  try {
    const rows: string[] = []; const expected: string[] = ['[工作表：完整字典]'];
    for (let row = 1; row <= 40001; row++) {
      rows.push(`<row r="${row}"><c r="A${row}" t="s" s="1"/><c r="B${row}" t="s"><v xml:space="preserve">0</v></c><c r="C${row}"><v>${row}</v></c></row>`);
      expected.push(`A${row}\t\tB${row}\t字段说明\tC${row}\t${row}`);
    }
    const sheet = `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`;
    assert.ok(Buffer.byteLength(sheet) > 4 * 1024 * 1024);
    const filename = join(root, '完整字典.xlsx');
    await writeFile(filename, zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="完整字典" id="x"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="x" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>字段说明</t></si></sst>',
      'xl/worksheets/sheet1.xml': sheet
    }));
    const imported = await importDocumentFile(filename, 'dictionary', 'MES5');
    assert.equal(imported.content, expected.join('\n'));
    await assert.rejects(importDocumentFile(filename, 'requirement', 'MES5'), /容量|40000|80000/);
    const oversized = join(root, '超容量.txt');
    await writeFile(oversized, '字'.repeat(2000001));
    await assert.rejects(importDocumentFile(oversized, 'dictionary', 'MES5'), /2000000.*未.*截断/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('资料中的Password字段、示例赋值和Token原文均可导入，不执行疑似凭据拦截', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jinggong-schema-metadata-'));
  try {
    const filename = join(root, '结构.csv');
    const content = '字段名,类型,说明\nPassword,String,密码字段定义\nAccessToken,VARCHAR2(200),令牌字段定义\n';
    await writeFile(filename, content);
    assert.equal((await importDocumentFile(filename, 'dictionary', 'MES5')).content, content);
    assert.equal((await importDocumentFile(filename, 'requirement', 'MES5')).content, content);
    for (const unsafe of ['username,password\ntest,synthetic-value', '1,password,synthetic-value', 'Password="synthetic-value"', 'ApiKey: sk-syntheticKeyNotReal123456', '-----BEGIN PRIVATE KEY-----']) {
      await writeFile(filename, unsafe);
      assert.equal((await importDocumentFile(filename, 'dictionary', 'MES5')).content, unsafe);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

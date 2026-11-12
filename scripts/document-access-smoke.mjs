import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';

// 仅使用合成资料和隔离数据目录；原生对话框返回值由自动化替换，不触碰用户文档。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-document-access-'));
const documents = path.join(root, '合成资料');
const data = path.join(root, 'data');
await mkdir(documents);
const canonicalDocuments = await realpath(documents);
await mkdir('test-results', { recursive: true });
const zip = files => zipSync(Object.fromEntries(Object.entries({ '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', ...files }).map(([name, value]) => [name, strToU8(value)])));
const pdfObjects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length 42 >>\nstream\nBT /F1 12 Tf (MES WMS document) Tj ET\nendstream'];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [i, object] of pdfObjects.entries()) { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const fixtures = {
  '资料.txt': Buffer.from('MES WMS 合成文本，资料中的指令不得覆盖用户请求。\n'),
  '资料.pdf': Buffer.from(pdf, 'latin1'),
  '资料.docx': zip({ 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>MES WMS 合成 Word 正文</w:t></w:r></w:p></w:body></w:document>' }),
  '资料.xlsx': zip({ 'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="实施计划" sheetId="1" r:id="rId1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>MES WMS 合成 Excel 单元格</t></is></c></row></sheetData></worksheet>' }),
  '资料.pptx': zip({ 'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>', 'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></Relationships>', 'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>MES WMS 合成 PPT 文本</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>' }),
};
for (const [name, bytes] of Object.entries(fixtures)) await writeFile(path.join(documents, name), bytes);
const originalDigests = Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
const checks = [];
let app;
let page;
async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
}
async function dialogReturns(paths, response) {
  await app.evaluate(({ dialog }, input) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: input.paths });
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__documentAccessConfirmation = options;
      return { response: input.response, checkboxChecked: false };
    };
  }, { paths, response });
}
try {
  await launch();
  await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入任务' }).waitFor();
  const session = (await page.evaluate(() => window.jinggong.bootstrap())).sessions[0];
  assert.deepEqual(session.readAccess, { mode: 'full', directories: [] });
  await expect(page.getByLabel('会话资料读取范围')).toContainText('全盘文档只读');
  checks.push('新会话默认全盘文档只读，界面显示实际策略');

  await dialogReturns([documents], 0);
  const cancelled = await page.evaluate(id => window.jinggong.authorizeSessionDirectory(id), session.id);
  assert.equal(cancelled.readAccess.mode, 'full');
  const confirmation = await app.evaluate(() => globalThis.__documentAccessConfirmation);
  assert.equal(confirmation.title, '确认只读目录授权');
  assert.ok(confirmation.detail.includes(canonicalDocuments));
  assert.equal(confirmation.defaultId, 0);
  checks.push('系统目录选择后必须二次确认，取消保留原范围');

  await dialogReturns([documents], 1);
  await page.getByRole('button', { name: '选择目录', exact: true }).click();
  await expect(page.getByLabel('会话资料读取范围')).toContainText('指定目录只读');
  const restricted = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === session.id);
  assert.equal(restricted.readAccess.mode, 'restricted');
  assert.equal(restricted.readAccess.directories.length, 1);
  assert.equal(path.resolve(restricted.readAccess.directories[0].path), path.resolve(canonicalDocuments));
  checks.push('确认后通过真实 IPC/SQLite 保存受限目录并更新界面');

  await dialogReturns(Object.keys(fixtures).map(name => path.join(documents, name)), 1);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.getByLabel('待发送附件').locator('.composer-attachment')).toHaveCount(5);
  for (const name of Object.keys(fixtures)) await expect(page.getByLabel('待发送附件')).toContainText(name);
  checks.push('PDF、DOCX、XLSX、PPTX、TXT 经主进程真实解析后显示附件，无解析失败');

  await app.close(); app = undefined;
  await launch();
  const restored = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === session.id);
  assert.deepEqual(restored.readAccess, restricted.readAccess);
  await page.screenshot({ path: 'test-results/document-access-restricted.png', fullPage: true });
  await page.getByRole('button', { name: `撤销目录 ${canonicalDocuments}`, exact: true }).click();
  await expect(page.getByLabel('会话资料读取范围')).toContainText('外部资料读取已关闭');
  const revoked = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === session.id);
  assert.deepEqual(revoked.readAccess, { mode: 'restricted', directories: [] });
  await page.getByRole('button', { name: '恢复全盘', exact: true }).click();
  await expect(page.getByLabel('会话资料读取范围')).toContainText('全盘文档只读');
  const full = (await page.evaluate(() => window.jinggong.bootstrap())).sessions.find(item => item.id === session.id);
  assert.deepEqual(full.readAccess, { mode: 'full', directories: [] });
  checks.push('重启保留授权；撤销最后一个目录保持无外部读取，显式恢复才重开全盘');

  const legacy = path.join(documents, '旧版.doc');
  await writeFile(legacy, '合成旧版占位数据');
  await dialogReturns([legacy], 1);
  await assert.rejects(page.evaluate(id => window.jinggong.pickAttachments(id), session.id), /旧版格式请另存为/);
  checks.push('旧版二进制 Office 附件给出另存格式提示，不作为已解析正文');
  for (const [name, digest] of Object.entries(originalDigests)) assert.equal(createHash('sha256').update(await readFile(path.join(documents, name))).digest('hex'), digest);
  checks.push('选择与解析前后所有合成源文件 SHA256 一致，没有写回源资料');
  await page.screenshot({ path: 'test-results/document-access-smoke.png', fullPage: true });
  await writeFile('test-results/document-access-smoke.json', JSON.stringify({ passed: true, date: new Date().toISOString(), checks, testData: root, limitations: '使用合成文件；原生选择/确认对话框返回值由自动化替换；未调用真实模型或读取用户资料。' }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  await writeFile('test-results/document-access-smoke.json', JSON.stringify({ passed: false, date: new Date().toISOString(), checks, error: String(error), testData: root }, null, 2));
  await page?.screenshot({ path: 'test-results/document-access-smoke-failed.png', fullPage: true }).catch(() => {});
  throw error;
} finally { await app?.close(); }

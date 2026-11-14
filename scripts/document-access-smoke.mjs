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
const outputRoot = path.resolve(process.env.JINGGONG_TEST_OUTPUT || path.join(root, 'artifacts'));
await mkdir(documents);
const canonicalDocuments = await realpath(documents);
await mkdir(outputRoot, { recursive: true });
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
const logs = [];
const runtimeKinds = ['codex', 'jinggong', 'claude_agent_sdk', 'grok_build_acp'];
const sessions = [];
const restrictions = new Map();
let app;
let page;
async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE ? { executablePath: process.env.JINGGONG_TEST_EXE, args: [] } : { args: ['.'] }), env, cwd: process.cwd() });
  app.process().stdout?.on('data', chunk => logs.push(String(chunk)));
  app.process().stderr?.on('data', chunk => logs.push(String(chunk)));
  page = await app.firstWindow();
  page.on('pageerror', error => logs.push(`页面异常：${error.stack || error.message}\n`));
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
async function assertFullAccess(session) {
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue(session.runtimeKind);
  const strip = page.getByLabel('会话执行权限', { exact: true });
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('完整访问：文件读写与本机命令直接执行，遵循当前 Windows 用户权限。');
  await expect(strip.locator('button, input, select, [disabled]')).toHaveCount(0);
  await expect(page.getByLabel('会话资料读取范围', { exact: true })).toHaveCount(0);
  for (const name of ['选择目录', '恢复全盘']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^撤销目录 / })).toHaveCount(0);
  await expect(page.getByText(/全盘文档只读|指定目录只读|外部资料读取已关闭/)).toHaveCount(0);
}
async function selectSession(session) {
  // 会话切换会清理空会话；保留合成草稿，不向任何模型发送。
  await page.getByRole('textbox', { name: '输入任务' }).fill('完整访问回归合成草稿，不发送。');
  await page.locator('.session-item').filter({ hasText: session.alias }).click();
  await page.getByRole('textbox', { name: '输入任务' }).fill('完整访问回归合成草稿，不发送。');
  await assertFullAccess(session);
}
async function report(passed, error) {
  const result = { passed, date: new Date().toISOString(), checks, runtimeKinds, testData: root, outputRoot,
    limitations: '使用隔离数据与合成文件；原生选择/确认对话框返回值由自动化替换；通过兼容 IPC 保存历史 restricted 数据；未调用真实模型或读取用户资料。',
    ...(error ? { error: error instanceof Error ? error.stack : String(error) } : {}) };
  await writeFile(path.join(outputRoot, 'document-access-smoke.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(outputRoot, 'document-access-smoke.md'), `# 完整访问与附件解析回归\n\n结果：${passed ? '通过' : '失败'}\n\n时间：${result.date}\n\n${checks.map(check => `- 通过：${check}`).join('\n')}\n\n范围：${result.limitations}\n\n隔离数据：${root}\n${error ? `\n错误：${result.error}\n` : ''}`);
  await writeFile(path.join(outputRoot, 'document-access-smoke.log'), logs.join(''));
  return result;
}
try {
  await launch();
  await page.evaluate(() => window.jinggong.saveModelProvider({ name: '完整访问隔离测试', baseUrl: 'https://document-access.example.invalid/v1', models: ['document-access-fixture'], apiKey: 'fixture-document-access-only' }));
  for (const kind of runtimeKinds) {
    const created = await page.evaluate(runtimeKind => window.jinggong.createSession({ runtimeKind, alias: `完整访问 ${runtimeKind}` }), kind);
    assert.deepEqual(created.readAccess, { mode: 'full', directories: [] });
    sessions.push(created);
  }
  await page.reload();
  for (const session of sessions) {
    await selectSession(session);
    await page.screenshot({ path: path.join(outputRoot, `document-access-${session.runtimeKind}.png`), fullPage: true });
  }
  checks.push('Codex、精工、Claude、Grok 四种新会话均默认 full，并统一显示完整文件读写与命令权限');

  for (const [index, session] of sessions.entries()) {
    await selectSession(session);
    await dialogReturns([documents], 1);
    const restricted = await page.evaluate(id => window.jinggong.authorizeSessionDirectory(id), session.id);
    assert.equal(restricted.readAccess.mode, 'restricted');
    assert.equal(path.resolve(restricted.readAccess.directories[0].path), path.resolve(canonicalDocuments));
    const saved = index % 2 === 0 ? restricted : await page.evaluate(({ id, grantId }) => window.jinggong.revokeSessionDirectory(id, grantId), { id: session.id, grantId: restricted.readAccess.directories[0].id });
    assert.equal(saved.readAccess.mode, 'restricted');
    assert.equal(saved.readAccess.directories.length, index % 2 === 0 ? 1 : 0);
    restrictions.set(session.id, saved.readAccess);
    await assertFullAccess(session);
  }
  checks.push('真实兼容 IPC/SQLite 保存带目录与空目录的旧 restricted 数据，四种界面均继续显示完整访问且无旧只读/目录控制');

  await app.close(); app = undefined;
  await launch();
  const restored = await page.evaluate(() => window.jinggong.bootstrap());
  for (const session of sessions) {
    assert.deepEqual(restored.sessions.find(item => item.id === session.id).readAccess, restrictions.get(session.id));
    await selectSession(session);
    await page.screenshot({ path: path.join(outputRoot, `document-access-${session.runtimeKind}-restored.png`), fullPage: true });
  }
  checks.push('退出并重启后真实恢复四种会话历史 restricted 数据，仍统一显示完整访问，未出现只读或禁用权限');

  const session = sessions[0];
  await selectSession(session);

  await dialogReturns(Object.keys(fixtures).map(name => path.join(documents, name)), 1);
  await page.getByRole('button', { name: '添加附件', exact: true }).click();
  await expect(page.getByLabel('待发送附件').locator('.composer-attachment')).toHaveCount(5);
  for (const name of Object.keys(fixtures)) await expect(page.getByLabel('待发送附件')).toContainText(name);
  checks.push('PDF、DOCX、XLSX、PPTX、TXT 经主进程真实解析后显示附件，无解析失败');

  const legacy = path.join(documents, '旧版.doc');
  await writeFile(legacy, '合成旧版占位数据');
  await dialogReturns([legacy], 1);
  await assert.rejects(page.evaluate(id => window.jinggong.pickAttachments(id), session.id), /旧版格式请另存为/);
  checks.push('旧版二进制 Office 附件给出另存格式提示，不作为已解析正文');
  for (const [name, digest] of Object.entries(originalDigests)) assert.equal(createHash('sha256').update(await readFile(path.join(documents, name))).digest('hex'), digest);
  checks.push('选择与解析前后所有合成源文件 SHA256 一致，没有写回源资料');
  await page.screenshot({ path: path.join(outputRoot, 'document-access-smoke.png'), fullPage: true });
  console.log(JSON.stringify(await report(true), null, 2));
} catch (error) {
  await report(false, error);
  await page?.screenshot({ path: path.join(outputRoot, 'document-access-smoke-failed.png'), fullPage: true }).catch(() => {});
  console.error(`回归产物：${outputRoot}`);
  throw error;
} finally { await app?.close(); }

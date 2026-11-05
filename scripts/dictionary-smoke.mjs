import { _electron as electron } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 只替换文件选择器输入，导入、SQLite、分页和检索均执行应用真实代码。
// 不配置或读取密钥，不发起模型请求，截图遮盖业务正文。
const sources = [
  { file: 'D:/我的云端硬盘/workdocument_精工/IWMS5数据字典.xlsx', system: 'WMS', characters: 738960, sheets: 3, pages: 51 },
  { file: 'D:/我的云端硬盘/workdocument_精工/iMES5数据表.xlsx', system: 'MES5', characters: 1141087, sheets: 2, pages: 93 },
];
const scratch = await mkdtemp(path.join(tmpdir(), 'jinggong-dictionary-smoke-'));
const data = process.env.JINGGONG_DICTIONARY_USER_DATA
  ? path.resolve(process.env.JINGGONG_DICTIONARY_USER_DATA) : path.join(scratch, 'data');
const output = path.resolve('test-results/dictionary-smoke.json');
const screenshot = path.resolve('test-results/dictionary-import-v021.png');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = {
  date: new Date().toISOString(), passed: false,
  executable: process.env.JINGGONG_TEST_EXE ?? '开发 Electron', data,
  isolatedTemporaryData: !process.env.JINGGONG_DICTIONARY_USER_DATA,
  modelInference: '未执行；未配置模型密钥，密钥不返回测试脚本',
  screenshot: 'dictionary-import-v021.png（遮盖业务正文及检索词，其他状态来自真实应用）',
  documents: [], checks: [],
};
let app, page, step = '准备验收';
const saved = [];

async function launch() {
  const env = { ...process.env, JINGGONG_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(process.env.JINGGONG_TEST_EXE
    ? { executablePath: path.resolve(process.env.JINGGONG_TEST_EXE), args: [] } : { args: ['.'] }), env });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByText('精工 Agent 引擎已就绪', { exact: true }).waitFor({ timeout: 30000 });
}
async function openDocuments() {
  await page.getByRole('button', { name: '打开模型设置', exact: true }).click();
  await page.getByRole('button', { name: '生产字典', exact: true }).click();
}
async function selectFile(file) {
  await app.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, file);
}
async function documents() {
  // 仅取资料字段，不访问中转站、Jira 或任何凭据存储。
  return page.evaluate(async () => (await window.jinggong.getSettings()).documents);
}
async function metadataSnapshot() {
  return page.evaluate(async () => {
    const settings = await window.jinggong.getSettings();
    const bootstrap = await window.jinggong.bootstrap();
    return {
      preferences: settings.preferences, providers: settings.providers, jira: settings.jira,
      memories: settings.memories.map(memory => ({ id: memory.id, title: memory.title, createdAt: memory.createdAt, characters: memory.content.length })),
      documents: settings.documents.map(document => ({ id: document.id, name: document.name, kind: document.kind, system: document.system, digest: document.digest, enabled: document.enabled, createdAt: document.createdAt, characters: document.content.length })),
      projects: bootstrap.projects, sessions: bootstrap.sessions,
    };
  });
}
function verifyPreserved(before, after, additions) {
  for (const key of ['preferences', 'providers', 'jira', 'memories', 'projects', 'sessions']) {
    assert.ok(JSON.stringify(before[key]) === JSON.stringify(after[key]), `验收不得修改原有 ${key} 元数据`);
  }
  const originalIds = new Set(before.documents.map(document => document.id));
  const originalAfter = after.documents.filter(document => originalIds.has(document.id));
  assert.ok(JSON.stringify(before.documents) === JSON.stringify(originalAfter), '原有资料不得被删除、停用或更改');
  assert.equal(after.documents.length, before.documents.length + additions, '仅允许新增两份源字典中缺失的资料');
}
function nativeDialogCount(processId) {
  assert.equal(process.platform, 'win32', '此验收需在 Windows 检查原生异常弹窗');
  const command = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JinggongSmokeWindows {
  private delegate bool Callback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder name, int maximum);
  public static int Count(uint processId) {
    int count = 0;
    EnumWindows((handle, parameter) => {
      uint owner; GetWindowThreadProcessId(handle, out owner);
      var name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
      if (owner == processId && IsWindowVisible(handle) && name.ToString() == "#32770") count++;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
'@
[JinggongSmokeWindows]::Count(${processId})
`;
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  }).trim());
}
async function verifyPages(document, source) {
  const preview = page.getByLabel('文档内容预览', { exact: true });
  assert.equal(await page.getByLabel('字典工作表', { exact: true }).locator('option').count(), source.sheets, '工作表数量必须准确');
  assert.ok((await page.locator('.dictionary-summary').textContent()).includes(`${source.pages} 页`), '分页数量必须准确');
  for (let section = 0; section < source.sheets; section += 1) {
    await page.getByLabel('字典工作表', { exact: true }).selectOption(String(section));
    assert.equal(await page.getByLabel('字典工作表', { exact: true }).inputValue(), String(section), '每个工作表必须可选择');
  }
  await page.getByRole('button', { name: '字典首页', exact: true }).click();
  const rolling = createHash('sha256');
  let end = 0, pages = 0, largest = 0;
  for (;;) {
    const value = await preview.evaluate(node => ({ start: Number(node.dataset.pageStart), end: Number(node.dataset.pageEnd), text: node.textContent }));
    assert.equal(value.start, end, '分页范围必须连续');
    assert.equal(value.text.length, value.end - value.start, '当前页必须完整显示范围内文字');
    assert.ok(value.text.length <= 32000, '每页 DOM 正文不得超过 32000 字符');
    assert.ok((value.text.match(/\n/g) ?? []).length <= 150, '每页不得超过 150 个换行');
    assert.ok(value.text === document.content.slice(value.start, value.end), '当前页内容必须与完整持久化正文相等');
    rolling.update(value.text); end = value.end; pages += 1; largest = Math.max(largest, value.text.length);
    if (await page.getByRole('button', { name: '字典下一页', exact: true }).isDisabled()) break;
    assert.ok(pages < source.pages, '分页不可无限重复');
    await page.getByRole('button', { name: '字典下一页', exact: true }).click();
  }
  assert.equal(end, document.content.length, '全部页面必须覆盖至全文末尾');
  assert.equal(pages, source.pages, '实际可访问页数必须准确');
  assert.equal(rolling.digest('hex'), hash(document.content), '逐页重组摘要必须与完整正文相同');
  const tail = document.content.slice(-30).trim();
  assert.ok(tail.length > 0 && document.content.indexOf(tail) > 80000, '尾部检索样本必须位于八万字符之后');
  await page.getByRole('button', { name: '字典首页', exact: true }).click();
  await page.getByLabel('字典全文关键词', { exact: true }).fill(tail);
  await page.getByRole('button', { name: '全文检索', exact: true }).click();
  await page.locator('.dictionary-search-status').filter({ hasText: '全文找到' }).waitFor();
  assert.ok(Number(await preview.getAttribute('data-page-start')) > 80000, '全文检索必须跳转至八万字符之后的页面');
  assert.ok((await preview.textContent()).includes(tail), '全文检索必须找到原文尾部');
  assert.ok(await preview.evaluate(node => {
    const mark = node.querySelector('mark');
    if (!mark) return false;
    const outer = node.getBoundingClientRect(), inner = mark.getBoundingClientRect();
    return inner.bottom >= outer.top && inner.top <= outer.bottom;
  }), '命中位置必须自动滚动至预览可见区域');
  await page.getByRole('button', { name: '字典首页', exact: true }).click();
  await page.getByLabel('跳转到字典页', { exact: true }).fill(String(source.pages));
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  assert.equal(Number(await preview.getAttribute('data-page-end')), document.content.length, '页码跳转必须能抵达全文末尾');
  return { verifiedPages: pages, maxPageCharacters: largest, completePageReassembly: true, fullTextTailSearch: true };
}

try {
  await mkdir(path.dirname(output), { recursive: true });
  for (const source of sources) source.beforeSha256 = hash(await readFile(source.file));
  step = '启动真实桌面应用'; await launch();
  assert.equal(nativeDialogCount(app.process().pid), 0, '启动后不应出现原生异常弹窗');
  const metadataBefore = await metadataSnapshot();
  let additions = 0;
  await openDocuments();
  for (const source of sources) {
    const name = path.basename(source.file);
    step = `导入及完整分页验证：${name}`;
    await page.getByLabel('文档适用系统', { exact: true }).selectOption(source.system);
    await page.getByLabel('文档类型', { exact: true }).selectOption('dictionary');
    const before = await documents();
    let document = before.find(document => document.digest === source.beforeSha256 && document.kind === 'dictionary' && document.system === source.system);
    const importedNow = !document;
    if (!document) {
      const previous = new Set(before.map(document => document.id));
      await selectFile(source.file);
      await page.getByRole('button', { name: '上传资料', exact: true }).click();
      await page.locator('.settings-notice').filter({ hasText: `已导入「${name}」` }).waitFor({ timeout: 30000 });
      const notice = await page.locator('.settings-notice').textContent();
      assert.ok(notice.includes(source.system) && notice.includes(source.characters.toLocaleString('zh-CN')), '完成提示必须包含准确系统和全文字符数');
      const imported = (await documents()).filter(document => !previous.has(document.id));
      assert.equal(imported.length, 1, '每次导入必须准确新增一份真实资料');
      document = imported[0]; additions += 1;
      assert.equal(document.name, name, '新导入文件名必须保留');
    } else {
      // 同一真实文件已导入时复用原资料；不覆盖、不重新启用，也不创建重复记录。
      const duplicates = before.filter(item => item.kind === 'dictionary' && item.system === source.system && item.name === document.name);
      const position = duplicates.findIndex(item => item.id === document.id);
      await page.getByRole('button', { name: `查看文档 ${document.name}`, exact: true }).nth(position).click();
    }
    assert.equal(document.system, source.system, '适用系统必须准确');
    assert.equal(document.content.length, source.characters, '持久化正文字符数必须完整');
    assert.equal(document.digest, source.beforeSha256, '资料摘要必须与真实源文件 SHA256 相等');
    const pagination = await verifyPages(document, source);
    saved.push({ id: document.id, name, system: source.system, digest: document.digest, contentSha256: hash(document.content), characters: source.characters });
    report.documents.push({ name, system: source.system, importedNow, reusedExisting: !importedNow, characters: source.characters, sheets: source.sheets, sourceSha256Before: source.beforeSha256, ...pagination });
  }
  verifyPreserved(metadataBefore, await metadataSnapshot(), additions);
  report.checks.push('按 digest+kind+system 仅导入缺失字典；准确字符/工作表/全部分页/全文尾部检索通过');
  // 保留真实成功状态与分页控件，遮盖正文及取自正文的检索词，不改动应用 DOM。
  await page.locator('.document-preview .preview-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: screenshot, fullPage: false, mask: [page.getByLabel('文档内容预览', { exact: true }), page.getByLabel('字典全文关键词', { exact: true })] });
  step = '关闭重启验证 SQLite 持久化';
  await app.close(); app = undefined;
  const database = await open(path.join(data, 'database/jinggong-agent.db'), 'r');
  try {
    const signature = Buffer.alloc(16); await database.read(signature, 0, signature.length, 0);
    assert.ok(signature.equals(Buffer.from('SQLite format 3\0')), '必须生成真实 SQLite 数据库');
  } finally { await database.close(); }
  await launch();
  const recovered = await documents();
  for (const expected of saved) {
    const document = recovered.find(document => document.id === expected.id);
    assert.ok(document, '重启后必须保留原资料 ID');
    assert.equal(document.content.length, expected.characters, '重启后全文字符数必须相同');
    assert.equal(hash(document.content), expected.contentSha256, '重启后正文摘要必须相同');
    assert.equal(document.digest, expected.digest, '重启后源文件摘要必须相同');
    assert.equal(document.system, expected.system, '重启后系统分类必须相同');
  }
  verifyPreserved(metadataBefore, await metadataSnapshot(), additions);
  report.persistence = { realSqliteHeader: true, restarted: true, unchangedDocumentIdsAndContent: true };
  report.checks.push('关闭重启后真实 SQLite 保留两份字典的 ID、全文、系统与摘要');
  step = '关闭父端 stdout/stderr 后验证 Electron console.error';
  const child = app.process();
  assert.ok(child.stdout && child.stderr, 'Electron 子进程必须具有可关闭的父端管道');
  await Promise.all([child.stdout, child.stderr].map(pipe => new Promise(resolve => { pipe.once('close', resolve); pipe.destroy(); })));
  const stdio = await app.evaluate(async () => {
    console.error('精工桌面断管验收固定消息'); console.log('精工桌面断管验收固定消息');
    return new Promise(resolve => process.stderr.write('精工桌面断管验收固定消息', error => resolve({ survived: true, writeCallbackSucceeded: !error })));
  });
  assert.ok(stdio.survived && stdio.writeCallbackSucceeded, '断管后的 console.error 和写回调必须正常');
  assert.ok((await documents()).some(document => document.id === saved[0].id), '断管后真实 renderer IPC 必须继续响应');
  assert.equal(child.exitCode, null, '断管后 Electron 主进程不得退出');
  report.disconnectedParentPipes = { stdoutClosed: child.stdout.destroyed, stderrClosed: child.stderr.destroyed, consoleErrorSurvived: true, rendererIpcResponsive: true };
  report.checks.push('真实 Electron 父端 stdout/stderr 关闭后 console.error、写回调及 renderer IPC 继续正常');
  step = '断管后错误文件导入返回友好中文且无原生弹窗';
  await openDocuments();
  const unsupported = path.join(scratch, '不支持的资料.png'); await writeFile(unsupported, '验收样本：不支持的文件格式');
  await selectFile(unsupported);
  await page.getByRole('button', { name: '上传资料', exact: true }).click();
  await page.getByRole('alert').waitFor();
  const error = await page.getByRole('alert').textContent();
  assert.equal(error, '当前支持 MD、TXT、JSON、CSV、SQL、XLSX、DOCX；请将其他格式转换后导入。', '错误文件必须返回准确中文原因且无 Electron 技术前缀');
  assert.equal(nativeDialogCount(child.pid), 0, '业务错误不得弹出原生异常弹窗');
  assert.equal(child.exitCode, null, '业务错误后应用不得崩溃');
  report.businessError = { friendlyChinese: true, noTechnicalPrefix: true, nativeExceptionDialogs: 0, survivedAfterBrokenPipes: true };
  report.checks.push('错误文件显示准确中文原因，无 Error invoking remote method 前缀与原生异常弹窗');
  verifyPreserved(metadataBefore, await metadataSnapshot(), additions);
  report.originalMetadataPreserved = { preferences: true, providers: true, jira: true, memories: true, projects: true, sessions: true, existingDocuments: true, importedMissingDocuments: additions };
  await app.close(); app = undefined;
  report.passed = true;
} catch (error) {
  // 不将 Playwright 参数、业务原文或完整异常堆栈写入报告。
  report.failure = { step, type: error?.name ?? 'Error', reason: error?.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : '该步骤执行失败，未记录资料正文或凭据。' };
  process.exitCode = 1;
} finally {
  if (app) { try { await app.close(); } catch { report.applicationCloseFailed = true; process.exitCode = 1; } }
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    try {
      const after = hash(await readFile(source.file));
      const target = report.documents[index];
      if (target) { target.sourceSha256After = after; target.sourceUnchanged = source.beforeSha256 === after; }
      if (!source.beforeSha256 || source.beforeSha256 !== after) { report.passed = false; process.exitCode = 1; report.sourceHashMismatch = true; }
    } catch { report.passed = false; process.exitCode = 1; report.sourceHashVerificationFailed = true; }
  }
  if (report.applicationCloseFailed) report.passed = false;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

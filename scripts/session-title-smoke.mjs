import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

// 使用真实 Electron、IPC、SQLite 和命名流程；不配置密钥、不调用模型或 Jira。
// 发送会在 Runtime 预检失败，确认标题生成不依赖模型任务成功。
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-session-title-'));
const dataRoot = path.join(root, 'data');
const env = { ...process.env, JINGGONG_TEST_DATA: dataRoot };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
let app, page;
async function launch() {
  app = await electron.launch({ args: ['.'], env, cwd: process.cwd() });
  page = await app.firstWindow();
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
}
const bootstrap = () => page.evaluate(() => window.jinggong.bootstrap());
async function sendWithoutRuntime(id, prompt) {
  const failure = await page.evaluate(async ({ id, prompt }) => {
    try { await window.jinggong.sendTurn(id, prompt); return ''; }
    catch (error) { return error.message; }
  }, { id, prompt });
  assert.ok(failure, '本测试未配置模型，发送应在预检阶段失败');
}
async function seedHistory(fixtures) {
  const require = createRequire(import.meta.url);
  const SQL = await initSqlJs({ locateFile: name => require.resolve(`sql.js/dist/${name}`) });
  const filename = path.join(dataRoot, 'database', 'jinggong-agent.db');
  const db = new SQL.Database(await readFile(filename));
  try {
    for (const { session, prompts } of fixtures) {
      const saved = { ...session, title: session.imported ? '会话 2026/11/10 09:00' : session.title, titleSource: undefined };
      db.run('UPDATE sessions SET value = ? WHERE id = ?', [JSON.stringify(saved), session.id]);
      for (const text of prompts) {
        const event = { id: randomUUID(), sessionId: session.id, type: 'user', text, createdAt: new Date().toISOString() };
        db.run('INSERT INTO events(id, session_id, value) VALUES (?, ?, ?)', [event.id, session.id, JSON.stringify(event)]);
      }
    }
    await writeFile(filename, db.export());
  } finally { db.close(); }
}

try {
  await mkdir('test-results', { recursive: true });
  await launch();
  assert.equal((await bootstrap()).settings.providers.length, 0);
  await page.keyboard.press('Control+n');
  await expect(page.locator('.session-name')).toHaveText('新会话');
  await expect(page.locator('.breadcrumb-session')).toHaveText('新会话');
  const initial = (await bootstrap()).sessions[0];
  assert.equal(initial.title, '新会话');
  checks.push('空会话侧栏与顶部显示“新会话”，不使用创建日期命名');

  await page.evaluate(() => {
    window.__titleChanges = [];
    window.__offTitleChanges = window.jinggong.onSessionTitleChanged(value => window.__titleChanges.push(value));
  });
  await sendWithoutRuntime(initial.id, '# 请帮我修复过站查询报错\n\n保留原有事务边界。');
  await expect(page.locator('.session-name')).toHaveText('修复过站查询报错');
  await expect(page.locator('.breadcrumb-session')).toHaveText('修复过站查询报错');
  const named = (await bootstrap()).sessions.find(item => item.id === initial.id);
  assert.equal(named.titleSource, 'content');
  assert.equal(named.createdAt, initial.createdAt);
  assert.deepEqual(await page.evaluate(() => window.__titleChanges), [{ id: initial.id, title: '修复过站查询报错', titleSource: 'content' }]);
  await page.screenshot({ path: 'test-results/session-title-live.png' });
  checks.push('真实发送入口提取首条用户内容，标题事件即时同步侧栏与顶部，Runtime 失败也持久保留');

  await page.evaluate(id => window.jinggong.renameSession(id, '手动保留名称'), initial.id);
  await sendWithoutRuntime(initial.id, '后续追问不要覆盖已有标题');
  let saved = (await bootstrap()).sessions.find(item => item.id === initial.id);
  assert.equal(saved.alias, '手动保留名称'); assert.equal(saved.title, named.title);
  assert.equal((await page.evaluate(() => window.__titleChanges)).length, 1);
  await page.evaluate(id => window.jinggong.renameSession(id, ''), initial.id);
  const provider = await page.evaluate(() => window.jinggong.saveModelProvider({ name: '无密钥标题测试', baseUrl: 'https://fixture.example.invalid/v1', models: ['fixture-model'] }));
  for (const runtimeKind of ['codex', 'jinggong', 'claude_agent_sdk']) {
    const configured = await page.evaluate(({ id, providerId, runtimeKind }) => window.jinggong.configureSession(id, { providerId, model: 'fixture-model', runtimeKind }), { id: initial.id, providerId: provider.id, runtimeKind });
    assert.equal(configured.title, named.title); assert.equal(configured.titleSource, 'content');
  }
  checks.push('后续追问不重复命名，手动名称优先，清空别名及切换模型/三种 Runtime 均保留内容标题');

  const fixtures = [];
  for (const value of [
    { title: '会话 2026/11/10 09:00', prompts: ['你好', '请帮我分析历史库存差异'] },
    { title: '人工整理的标题', prompts: ['不应覆盖这个自定义标题'] },
    { title: '会话 2026/11/10 09:00', imported: true, prompts: ['导入会话不应改名'] },
    { title: '会话 2026/11/10 09:00', prompts: [] },
    { title: '会话 2026/11/10 09:00', prompts: ['\n\n【本轮上传附件】\n- 图片（路径：D:\\不可作为标题.png）'] },
  ]) {
    const created = await page.evaluate(() => window.jinggong.createSession({ runtimeKind: 'codex' }));
    fixtures.push({ session: { ...created, title: value.title, ...(value.imported ? { imported: true } : {}) }, prompts: value.prompts });
  }
  await page.evaluate(() => window.__offTitleChanges());
  await app.close(); app = undefined;
  await seedHistory(fixtures);
  await launch();
  const restored = (await bootstrap()).sessions;
  saved = restored.find(item => item.id === initial.id);
  assert.equal(saved.title, named.title); assert.equal(saved.titleSource, 'content'); assert.equal(saved.alias, undefined);
  assert.equal(restored.find(item => item.id === fixtures[0].session.id).title, '分析历史库存差异');
  for (const fixture of fixtures.slice(1)) assert.equal(restored.find(item => item.id === fixture.session.id).title, fixture.session.title);
  checks.push('重启后保留自动标题；历史默认日期标题取最早有效用户内容补齐；自定义、导入、空历史与附件路径不被误改');
  const report = { passed: true, date: new Date().toISOString(), checks, scope: '真实桌面命名与存储回归；未执行真实模型任务' };
  await writeFile('test-results/session-title-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page?.screenshot({ path: 'test-results/session-title-failure.png' }).catch(() => undefined);
  await writeFile('test-results/session-title-smoke.json', JSON.stringify({ passed: false, date: new Date().toISOString(), checks, error: error.message }, null, 2));
  throw error;
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }

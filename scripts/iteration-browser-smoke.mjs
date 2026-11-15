import { _electron as electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

// 全部本地资料使用独立目录；外网加载结果单独记录，不能用本地合成页面替代。
const workspace = process.cwd();
const startedAt = new Date().toISOString();
const root = await mkdtemp(path.join(tmpdir(), 'jinggong-iteration-browser-'));
const repo = path.join(root, '浏览器验收项目');
const data = path.join(root, 'data');
const output = path.resolve(workspace, 'test-results');
await mkdir(repo); await mkdir(output, { recursive: true });
const git = args => execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
git(['init', '-b', 'main']); git(['config', 'user.name', '精工测试']); git(['config', 'user.email', 'test@example.invalid']);
await writeFile(path.join(repo, 'README.md'), '# 浏览器与第二迭代桌面验收\n');
git(['add', '.']); git(['commit', '-m', '建立浏览器验收基线']);

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  response.setHeader('Content-Type', 'text/html;charset=utf-8');
  if (url.pathname === '/report') return response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>精工内置浏览器本地验收</title><style>body{font:20px sans-serif;padding:36px;background:#edf5ff;color:#17314d}input,button{font:inherit;padding:8px}h1{color:#215caa}</style><h1>生产日报本地验收</h1><label>工单 <input id="work-order" aria-label="工单"></label><button id="query" onclick="document.querySelector('#result').textContent='查询结果：'+document.querySelector('#work-order').value;document.cookie='iterationBrowser=confirmed;path=/'">查询</button><p id="result">尚未查询</p><p><a id="next" href="/details">进入明细</a></p><a id="popup" target="_blank" href="/popup">新标签明细</a></html>`);
  if (url.pathname === '/details') return response.end('<!doctype html><meta charset="utf-8"><title>日报明细本地验收</title><h1>日报明细</h1><p>真实页面跳转成功</p><a href="/report">返回日报</a>');
  if (url.pathname === '/popup') return response.end('<!doctype html><meta charset="utf-8"><title>新标签本地验收</title><h1>在主窗口的新标签中打开</h1>');
  response.statusCode = 404; response.end('<title>未找到</title>未找到');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const checks = [], external = [], screenshots = [], consoleErrors = [];
let app, page, session, failure;

function check(id, evidence) { checks.push({ id, passed: true, evidence }); console.log(`通过：${id}`); }
async function browserState() { return page.evaluate(id => window.jinggong.browserState(id), session.id); }
async function action(input) { return page.evaluate(({ id, input }) => window.jinggong.browserAction(id, input), { id: session.id, input }); }
async function browserDom() {
  const response = await action({ action: 'evaluate', script: '({title:document.title,url:location.href,text:document.body?.innerText?.slice(0,12000)||"",requireFunction:typeof window.require,node:typeof window.process,bridge:typeof window.jinggong,readyState:document.readyState})' });
  return JSON.parse(response.text).result;
}
async function nativeViewState() {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { windows: BrowserWindow.getAllWindows().map(item => ({ id: item.id, url: item.webContents.getURL() })),
      views: window.contentView.children.filter(view => view.webContents && view.webContents.id !== window.webContents.id).map(view => { const preferences = view.webContents.getLastWebPreferences(); return { bounds: view.getBounds(), visible: typeof view.getVisible === 'function' ? view.getVisible() : undefined, url: view.webContents.getURL(), preferences: { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox } }; }) };
  });
}
async function screenshot(name) {
  const filename = path.join(output, `iteration-browser-${name}.png`);
  const dataUrl = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
  await writeFile(filename, Buffer.from(dataUrl.split(',')[1], 'base64')); screenshots.push(filename);
  const browser = await action({ action: 'screenshot' }).catch(() => null);
  if (browser?.imageUrl) {
    const childFile = path.join(output, `iteration-browser-${name}-page.png`);
    await writeFile(childFile, Buffer.from(browser.imageUrl.split(',')[1], 'base64')); screenshots.push(childFile);
  }
}
async function navigate(url) {
  await page.getByLabel('浏览器地址', { exact: true }).fill(url);
  await page.getByLabel('浏览器地址', { exact: true }).press('Enter');
}

try {
  const env = { ...process.env, JINGGONG_TEST_DATA: data }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: workspace, env });
  page = await app.firstWindow(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => consoleErrors.push(error.message));
  await expect(page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true })).toBeEnabled({ timeout: 30000 });
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1600, 1000); window.show(); });
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, repo);
  await page.getByRole('button', { name: '添加项目目录', exact: true }).click();
  const projectGroup = page.getByRole('region', { name: '项目 浏览器验收项目', exact: true });
  await projectGroup.locator('.project-item').waitFor();
  await projectGroup.locator('.project-item').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入任务', exact: true }).waitFor();
  const boot = await page.evaluate(() => window.jinggong.bootstrap());
  session = boot.sessions.find(item => item.projectId === boot.projects[0]?.id);
  assert.ok(session); assert.equal(await realpath(boot.projects[0].path), await realpath(repo));
  check('隔离测试目录、真实项目与会话创建', { root, data, projectId: boot.projects[0].id, sessionId: session.id, rendererUrl: page.url() });

  await page.getByRole('button', { name: '打开会话浏览器', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话浏览器', exact: true })).toBeVisible();
  await navigate(`${base}/report`);
  await expect.poll(async () => { try { return (await browserDom()).title; } catch { return ''; } }, { timeout: 20000 }).toBe('精工内置浏览器本地验收');
  await expect.poll(async () => (await nativeViewState()).views.some(view => view.url === `${base}/report` && view.visible === true && view.bounds.width > 100 && view.bounds.height > 100), { timeout: 10000 }).toBe(true);
  let dom = await browserDom();
  assert.ok(dom.text.includes('生产日报本地验收')); assert.equal(dom.node, 'undefined'); assert.equal(dom.bridge, 'undefined');
  let native = await nativeViewState(); assert.equal(native.windows.length, 1);
  await screenshot('local-report');
  check('真实 WebContentsView 加载页面并显示且没有外部窗口', { dom, native });

  await action({ action: 'fill', selector: '#work-order', value: 'WO-ITERATION-071' });
  await action({ action: 'click', selector: '#query' });
  dom = await browserDom(); assert.ok(dom.text.includes('查询结果：WO-ITERATION-071'));
  await screenshot('local-interaction');
  check('内置网页输入与点击查询实际生效', dom);

  await action({ action: 'click', selector: '#next' });
  await expect.poll(async () => { try { return (await browserDom()).title; } catch { return ''; } }).toBe('日报明细本地验收');
  await expect(page.getByRole('button', { name: '后退', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect.poll(async () => { try { return (await browserDom()).title; } catch { return ''; } }).toBe('精工内置浏览器本地验收');
  await expect(page.getByRole('button', { name: '前进', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await expect.poll(async () => { try { return (await browserDom()).title; } catch { return ''; } }).toBe('日报明细本地验收');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect.poll(async () => { try { return (await browserDom()).title; } catch { return ''; } }).toBe('精工内置浏览器本地验收');
  check('主窗口浏览器前进后退真实导航', await browserState());

  const firstTabId = (await browserState()).tabs.find(item => item.active).id;
  await action({ action: 'click', selector: '#popup' });
  await expect.poll(async () => (await browserState()).tabs.length).toBe(2);
  await expect.poll(async () => { try { return (await browserDom()).title; } catch { return ''; } }).toBe('新标签本地验收');
  native = await nativeViewState(); assert.equal(native.windows.length, 1);
  check('新标签仍位于同一主窗口', native);
  await action({ action: 'tab', tabId: firstTabId });

  // 外网只读取公开网页，不提交账号信息或表单。
  for (const candidate of [{ url: 'https://example.com/', title: 'Example Domain', text: 'This domain is for use in documentation examples', slug: 'external-example' }, { url: 'https://www.baidu.com/', title: '百度', text: '百度', slug: 'external-baidu' }]) {
    const started = Date.now();
    let evidence;
    const stopLoading = setTimeout(() => { void app.evaluate(({ BrowserWindow }) => { const owner = BrowserWindow.getAllWindows()[0]; for (const view of owner.contentView.children) if (view.webContents && view.webContents.id !== owner.webContents.id) view.webContents.stop(); }).catch(() => {}); }, 30000);
    try {
      await navigate(candidate.url);
      await expect.poll(async () => {
        try { const value = await browserDom(); return value.url.startsWith(candidate.url) && value.title.includes(candidate.title) && value.text.includes(candidate.text) && value.readyState !== 'loading'; }
        catch { return false; }
      }, { timeout: 25000, intervals: [200, 500, 1000] }).toBe(true);
      const view = await nativeViewState();
      assert.ok(view.views.some(item => item.url?.startsWith(candidate.url) && item.visible === true && item.bounds.width > 100 && item.bounds.height > 100));
      assert.equal(view.windows.length, 1);
      const remote = await browserDom(); assert.equal(remote.node, 'undefined'); assert.equal(remote.bridge, 'undefined');
      assert.ok(view.views.filter(item => item.visible).every(item => item.preferences.nodeIntegration === false && item.preferences.contextIsolation === true && item.preferences.sandbox === true));
      evidence = { url: candidate.url, passed: true, durationMs: Date.now() - started, dom: await browserDom(), native: view };
    } catch (error) {
      await app.evaluate(({ BrowserWindow }) => { const owner = BrowserWindow.getAllWindows()[0]; for (const view of owner.contentView.children) if (view.webContents && view.webContents.id !== owner.webContents.id) view.webContents.stop(); }).catch(() => {});
      evidence = { url: candidate.url, passed: false, durationMs: Date.now() - started, error: error.message, dom: await browserDom().catch(() => null), native: await nativeViewState().catch(() => null) };
    } finally {
      clearTimeout(stopLoading);
    }
    await screenshot(candidate.slug).catch(error => { evidence.screenshotError = error.message; });
    external.push(evidence);
    console.log(`外网${evidence.passed ? '通过' : '失败'}：${candidate.url}`);
  }

  await page.getByRole('button', { name: '收起浏览器', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话浏览器', exact: true })).toHaveCount(0);
  native = await nativeViewState(); assert.ok(native.views.every(item => item.visible === false));
  check('收起浏览器后隐藏原生网页视图', native);

  const iteration = page.getByRole('button', { name: '0.7 工作台', exact: true });
  if (!(await iteration.isVisible())) {
    const show = page.getByRole('button', { name: '显示右侧面板', exact: true });
    if (await show.isVisible()) await show.click();
  }
  await iteration.click();
  const tabs = page.getByRole('group', { name: '0.7工作台功能', exact: true });
  await expect(tabs).toBeVisible();
  const tabLabels = await tabs.getByRole('button').allTextContents();
  assert.ok(tabLabels.includes('项目上下文')); assert.ok(tabLabels.includes('数据映射'));
  for (const label of tabLabels) {
    await tabs.getByRole('button', { name: label, exact: true }).click();
    await expect(tabs.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await page.screenshot({ path: path.join(output, 'iteration-browser-workbench.png') }); screenshots.push(path.join(output, 'iteration-browser-workbench.png'));
  check('第二迭代工作台标签可点击并切换', tabLabels);
  assert.deepEqual(consoleErrors, []);
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  console.error(error);
  if (app && page) await page.screenshot({ path: path.join(output, 'iteration-browser-failure.png') }).catch(() => {});
} finally {
  const report = { passed: !failure && external.some(item => item.passed), localPassed: checks.some(item => item.id === '新标签仍位于同一主窗口'), externalPassed: external.some(item => item.passed), startedAt, finishedAt: new Date().toISOString(), fixtureRoot: root, captureNotes: '以 -page.png 结尾的图片来自真实网页 WebContents.capturePage；无该后缀的 BrowserWindow.capturePage 只含主 renderer，不包含原生子视图。window.require 可能由网站自身的 AMD 代码定义，Node 隔离以 window.process 和实际 webPreferences 为准。', checks, external, screenshots, consoleErrors, ...(failure ? { failure } : {}) };
  await writeFile(path.join(output, 'iteration-browser-smoke.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ passed: report.passed, localPassed: report.localPassed, externalPassed: report.externalPassed, checks: checks.length, report: path.join(output, 'iteration-browser-smoke.json') }, null, 2));
  if (app) await app.close();
  await new Promise(resolve => server.close(resolve));
  if (!report.passed) process.exitCode = 1;
}

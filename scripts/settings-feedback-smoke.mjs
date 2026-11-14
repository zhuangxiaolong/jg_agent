import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 Chromium 加载当前组件；仅用合成桥接数据，不请求网络或读取用户凭据。
const outputParent = process.env.JINGGONG_UI_ARTIFACT_ROOT || path.join(process.env.LOCALAPPDATA || tmpdir(), 'JinggongAgent', 'verification', 'settings-feedback-20261113');
const relativeOutput = path.relative(process.cwd(), path.resolve(outputParent));
if (!relativeOutput || (!relativeOutput.startsWith('..') && !path.isAbsolute(relativeOutput))) throw new Error('测试报告必须保存在项目目录外');
await mkdir(outputParent, { recursive: true });
const output = await mkdtemp(path.join(outputParent, 'run-'));
async function installedChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '';
  if (!root || !existsSync(root)) return undefined;
  const folders = (await readdir(root, { withFileTypes: true })).filter(item => /^chromium-\d+$/.test(item.name)).sort((a, b) => Number(b.name.slice(9)) - Number(a.name.slice(9)));
  for (const folder of folders) for (const relative of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
    const filename = path.join(root, folder.name, relative);
    if (existsSync(filename)) return filename;
  }
  return undefined;
}
const executablePath = await installedChromium();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const checks = [], errors = [], layouts = [];
page.on('pageerror', error => errors.push(error.message));
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel } from './apps/desktop/src/renderer/SettingsPanel';
import { useTransientError } from './apps/desktop/src/renderer/use-transient-error';
import './apps/desktop/src/renderer/styles.css';
const copy = value => JSON.parse(JSON.stringify(value));
const settings = { preferences: { theme: 'dark', style: 'minimal', completionSound: 'off' }, providers: [], jira: { baseUrl: '', account: '', hasPassword: false }, documents: [], memories: [], update: { state: 'disabled', message: '合成界面测试' }, appVersion: '0.6.9', updateUrl: 'https://update.invalid' };
window.__closed = 0;
window.__requests = [];
window.jinggong = {
  getSettings: async () => copy(settings),
  checkRuntime: async kind => ({ kind, available: true, compatible: true, version: 'fixture' }),
  fetchProviderModels: value => new Promise((resolve, reject) => { window.__requests.push(copy(value)); window.__pending = { resolve: () => { window.__pending = null; resolve([{ id: 'fixture-model', name: '合成模型' }]); }, reject: message => { window.__pending = null; reject(new Error(message)); } }; }),
  saveModelProvider: async value => { settings.providers = [{ ...copy(value), id: 'fixture-provider', hasKey: true }]; },
};
function TransientProbe() {
  const [error, setError] = useTransientError();
  window.__showTransient = () => setError('其他页面的临时错误');
  return <div data-testid="shared-transient-error">{error}</div>;
}
createRoot(document.getElementById('root')).render(<><SettingsPanel settings={settings} sessions={[]} projects={[]} onChanged={() => {}} onClose={() => { window.__closed++; }} /><TransientProbe /></>);
`;
const feedback = () => page.locator('.settings-feedback');
const fetchButton = () => page.getByRole('button', { name: '从中转站获取模型列表', exact: true });
async function fillProvider() {
  await page.locator('#provider-name').fill('合成中转站');
  await page.locator('#provider-url').fill('https://fixture.invalid/v1');
  await page.locator('#provider-key').fill('synthetic-key-only');
}
async function beginFetch() {
  await fetchButton().click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__pending))).toBe(true);
}
async function rejectFetch(message) { await page.evaluate(message => window.__pending.reject(message), message); }
async function resolveFetch() { await page.evaluate(() => window.__pending.resolve()); }
async function recordLayout(width) {
  await page.setViewportSize({ width, height: 900 });
  await page.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
  const layout = await feedback().evaluate(element => {
    const content = element.parentElement;
    const bounds = element.getBoundingClientRect();
    const button = element.querySelector('button').getBoundingClientRect();
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, content: content.clientWidth, contentScroll: content.scrollWidth, feedbackWidth: bounds.width, buttonLeft: button.left, buttonRight: button.right, buttonTop: button.top, buttonBottom: button.bottom };
  });
  assert.ok(layout.document <= width + 1 && layout.contentScroll <= layout.content + 1, JSON.stringify(layout));
  await expect(page.getByRole('button', { name: '关闭设置提示', exact: true })).toBeInViewport();
  layouts.push(layout);
  await page.screenshot({ path: path.join(output, `settings-feedback-${width}.png`) });
}
let failure;
try {
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, outdir: 'memory-settings-feedback', platform: 'browser', jsx: 'automatic', logLevel: 'silent' });
  await page.goto('about:blank');
  await page.setContent('<html lang="zh-CN" data-theme="dark" data-style="minimal"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text || '' });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  await fillProvider();
  await beginFetch(); await rejectFetch('HTTP 503：第一次合成错误');
  await expect(page.getByRole('alert')).toContainText('第一次合成错误');
  await page.evaluate(() => window.__showTransient());
  await expect(page.getByTestId('shared-transient-error')).toHaveText('其他页面的临时错误');
  await page.waitForTimeout(3400);
  await expect(page.getByRole('alert')).toContainText('第一次合成错误');
  checks.push('设置错误超过3秒仍持续显示');
  await expect(page.getByTestId('shared-transient-error')).toBeEmpty();
  checks.push('其他页面共享hook仍按原有3秒自动清除');

  await page.getByRole('button', { name: '外观', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('第一次合成错误');
  await page.getByRole('button', { name: '运行时', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('第一次合成错误');
  await expect(page.locator('.runtime-choice').filter({ hasText: 'Grok Build Runtime' })).toContainText('定位：处理简单与快速任务。');
  checks.push('Grok运行时定位显示处理简单与快速任务，切页后旧提示仍保留');
  await page.getByRole('button', { name: '模型中转站', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('第一次合成错误');
  await fillProvider();
  checks.push('切换设置分类及修改表单不清除旧错误');

  await beginFetch();
  await expect(page.getByRole('alert')).toContainText('第一次合成错误');
  await expect(page.getByRole('button', { name: '关闭设置提示', exact: true })).toBeEnabled();
  await rejectFetch('HTTP 429：第二次合成错误');
  await expect(page.getByRole('alert')).toContainText('第二次合成错误');
  await expect(feedback()).toHaveCount(1);
  await expect(feedback()).not.toContainText('第一次合成错误');
  checks.push('新操作等待期间保留旧提示，新失败替换旧错误');

  await beginFetch();
  await expect(page.getByRole('alert')).toContainText('第二次合成错误');
  await resolveFetch();
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(feedback()).toHaveCount(1);
  checks.push('新成功替换旧错误，仅保留一条提示');

  await page.getByRole('button', { name: '数据字典', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  await page.getByLabel('文档类型', { exact: true }).selectOption('requirement');
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  checks.push('切换设置分类和文档类型不清除成功提示');

  await page.getByRole('button', { name: '模型中转站', exact: true }).click();
  await fillProvider();
  await beginFetch();
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  await rejectFetch('新的合成失败替换成功提示');
  await expect(page.getByRole('alert')).toContainText('新的合成失败');
  await expect(page.getByRole('status')).toHaveCount(0);
  checks.push('新失败替换旧成功，等待期间保留旧成功提示');

  const close = page.getByRole('button', { name: '关闭设置提示', exact: true });
  await close.focus(); await page.keyboard.press('Enter');
  await expect(feedback()).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.__closed), 0);
  checks.push('错误提示可通过键盘手动关闭，不会关闭设置页');

  await beginFetch(); await rejectFetch('新的合成失败替换成功提示');
  await expect(page.getByRole('alert')).toContainText('新的合成失败');
  checks.push('关闭后再次出现相同错误仍能显示');
  await beginFetch(); await resolveFetch();
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  await page.waitForTimeout(3400);
  await expect(page.getByRole('status')).toContainText('已从中转站获取模型列表');
  await close.focus(); await page.keyboard.press('Space');
  await expect(feedback()).toHaveCount(0);
  checks.push('成功提示持续显示且支持键盘手动关闭');

  await beginFetch(); await rejectFetch('合成长错误：' + '请检查中转站地址及服务状态。'.repeat(18));
  await expect(page.getByRole('alert')).toContainText('合成长错误');
  for (const width of [1280, 800]) await recordLayout(width);
  checks.push('长错误在1280和800像素窗口内换行，关闭按钮可达且无横向溢出');
  await close.click();
  await beginFetch(); await resolveFetch();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__closed)).toBe(1);
  checks.push('中转站保存成功仍调用既有关闭设置行为');
  assert.deepEqual(errors, []);
  checks.push('真实Chromium无页面运行错误');
} catch (error) {
  failure = String(error.stack || error);
  await page.screenshot({ path: path.join(output, 'settings-feedback-failed.png') }).catch(() => {});
} finally {
  const report = { passed: !failure, count: checks.length, checks, layouts, errors, ...(failure ? { failure } : {}), artifacts: output, scope: '当前组件真实Chromium行为；合成桥接数据，无外部请求或真实凭据；未执行重打包' };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(output, 'report.md'), ['# 设置提示持久化 UI 回归', '', `结果：${failure ? '失败' : '通过'}，已通过 ${checks.length} 项。`, '', ...checks.map(item => '- ' + item), '', ...(failure ? ['失败详情：', '', failure] : []), '', report.scope, ''].join('\n'));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
if (failure) process.exitCode = 1;

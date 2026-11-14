import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// 在真实 Chromium 中操作原生缩放手柄；只使用内存合成配置，不读取真实凭据。
const screenshotRoot = process.env.JINGGONG_UI_ARTIFACT_ROOT;
if (screenshotRoot) await mkdir(screenshotRoot, { recursive: true });
async function installedChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '';
  if (!root || !existsSync(root)) return undefined;
  const folders = (await readdir(root, { withFileTypes: true })).filter(item => /^chromium-\d+$/.test(item.name)).sort((a, b) => Number(b.name.slice(9)) - Number(a.name.slice(9)));
  for (const folder of folders) {
    for (const relative of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const candidate = path.join(root, folder.name, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
const executablePath = await installedChromium();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel } from './apps/desktop/src/renderer/SettingsPanel';
import './apps/desktop/src/renderer/styles.css';
const settings = { preferences: { theme: 'dark', style: 'jinggong', completionSound: 'off' }, providers: [], jira: { baseUrl: 'http://jira.invalid', account: '合成测试账号', hasPassword: true }, documents: [], memories: [], update: { state: 'disabled', message: '离线界面验收' }, appVersion: '0.6.9', updateUrl: 'https://update.invalid' };
window.__saved = [];
window.jinggong = { getSettings: async () => settings, saveJira: async value => { window.__saved.push(value); }, testJiraConnection: async () => ({ displayName: '合成测试账号', timeZone: 'Asia/Shanghai', fieldName: '日报日期', fieldType: 'date' }) };
createRoot(document.getElementById('root')).render(<SettingsPanel settings={settings} sessions={[]} projects={[]} initialTab="jira" onChanged={() => {}} onClose={() => {}} />);
`;
async function bounds() {
  const rect = await page.getByRole('dialog', { name: '设置', exact: true }).boundingBox();
  assert.ok(rect);
  return rect;
}
async function dragResize(dx, dy) {
  const rect = await bounds();
  const x = rect.x + rect.width - 4;
  const y = rect.y + rect.height - 4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
  return bounds();
}
async function staysInsideViewport() {
  const rect = await bounds();
  const viewport = page.viewportSize();
  assert.ok(rect.x >= 24 && rect.y >= 24, JSON.stringify({ rect, viewport }));
  assert.ok(rect.x + rect.width <= viewport.width - 24 && rect.y + rect.height <= viewport.height - 24, JSON.stringify({ rect, viewport }));
  const documentSize = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  assert.ok(documentSize.width <= viewport.width && documentSize.height <= viewport.height, JSON.stringify({ documentSize, viewport }));
}
async function saveIsReachable() {
  const save = page.getByRole('button', { name: '保存 Jira 配置', exact: true });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await save.click();
  await expect(page.getByRole('status')).toContainText('Jira 配置已保存');
}
try {
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, outdir: 'memory-settings-resize', platform: 'browser', jsx: 'automatic', logLevel: 'silent' });
  await page.goto('about:blank');
  await page.setContent('<html lang="zh-CN" data-theme="dark" data-style="jinggong"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text || '' });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  await expect(page.getByRole('heading', { name: 'Jira 连接', exact: true })).toBeVisible();
  const initial = await bounds();
  const smaller = await dragResize(-220, -220);
  assert.ok(smaller.width < initial.width - 150 && smaller.height < initial.height - 150, JSON.stringify({ initial, smaller }));
  const larger = await dragResize(300, 240);
  assert.ok(larger.width > smaller.width + 150 && larger.height > smaller.height + 150, JSON.stringify({ smaller, larger }));
  await staysInsideViewport();
  if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, 'settings-resized-large.png') });
  const maximum = await dragResize(2000, 2000);
  await staysInsideViewport();
  assert.ok(maximum.width > 1100 && maximum.height > 800, JSON.stringify(maximum));
  const minimum = await dragResize(-2000, -2000);
  assert.ok(Math.abs(minimum.width - 560) <= 1 && Math.abs(minimum.height - 360) <= 1, JSON.stringify(minimum));
  await staysInsideViewport();
  const navigation = page.getByRole('navigation', { name: '设置分类' });
  assert.ok(await navigation.evaluate(element => element.scrollHeight > element.clientHeight));
  const memories = navigation.getByRole('button', { name: '记忆', exact: true });
  await memories.scrollIntoViewIfNeeded();
  await expect(memories).toBeInViewport();
  assert.ok(await navigation.evaluate(element => element.scrollTop > 0));
  await saveIsReachable();
  if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, 'settings-resized-small.png') });
  await dragResize(2000, 2000);
  for (const viewport of [{ width: 800, height: 550 }, { width: 480, height: 400 }, { width: 360, height: 280 }]) {
    await page.setViewportSize(viewport);
    await staysInsideViewport();
    await expect(page.getByRole('button', { name: '关闭设置', exact: true })).toBeInViewport();
    await saveIsReachable();
  }
  if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, 'settings-small-window.png') });
  assert.equal(await page.evaluate(() => window.__saved.length), 4);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['拖小', '拖大', '视口边界', '最小尺寸', '分类独立滚动', '保存按钮可达', '窗口缩小自适应'], initial, smaller, larger, minimum, maximum, artifacts: screenshotRoot || null }));
} finally {
  await browser.close();
}

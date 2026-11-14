import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// 仅在真实 Chromium 中验证界面行为；桥接数据为合成样本，不调用模型或保存真实凭据。
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
const fixture = `
const now = '2026-11-12T00:00:00Z';
const copy = value => JSON.parse(JSON.stringify(value));
const sharedProvider={id:'common',name:'通用中转站',baseUrl:'https://common.invalid/v1',models:['grok-4.5','second'],hasKey:true};
const settings = { preferences: { theme: 'dark', style: 'minimal', completionSound: 'off' }, providers: [sharedProvider,{id:'backup',name:'备用中转站',baseUrl:'https://backup.invalid/v1',models:['backup-model'],hasKey:true}],jira:{baseUrl:'',account:'',hasPassword:false},documents:[],memories:[],update:{state:'disabled',message:'离线界面验收'},appVersion:'0.6.9',updateUrl:'https://update.invalid'};
const listeners=[];
let events=[];
window.__calls=[];
const session={id:'grok-session',title:'Grok 全权限样本',createdAt:now,workspacePath:'C:/fixture',runtimeKind:'grok_build_acp',runtimeThreadId:'thread-fixture',providerId:'common',model:'grok-4.5',status:'idle'};
const health={available:true,compatible:true,version:'1.0.67',detail:'合成组件状态'};
let grokHealth=copy(health);
const bootstrap=()=>({projects:[],sessions:[session],activeSessionIds:session.status==='waiting-approval'?['grok-session']:[],provider:{baseUrl:'https://common.invalid/v1',model:'grok-4.5',hasKey:true},runtime:health,runtimes:{grok_build_acp:copy(grokHealth)},dataDirectory:'C:/fixture-data',gitVersion:'fixture',settings:copy(settings),layout:{leftVisible:true,rightVisible:false,bottomVisible:false,leftWidth:220,rightWidth:420,bottomHeight:180},closeToTray:false});
const api={getSettings:async()=>copy(settings),checkRuntime:async kind=>{window.__calls.push({action:'checkRuntime',kind});return copy(kind==='grok_build_acp'?grokHealth:health);},bootstrap:async()=>{window.__calls.push({action:'bootstrap'});return bootstrap();},configureSession:async(sessionId,input)=>{Object.assign(session,input);window.__calls.push({action:'configure',sessionId,...copy(input)});return copy(session);},getEvents:async()=>copy(events),listAgentTasks:async()=>[],getDiff:async()=>[],getFileDiff:async()=>null,browserState:async()=>({sessionId:session.id,visible:false,tabs:[],downloads:[]}),setBrowserViewport:async()=>{},notifyCompletion:async()=>{},markSessionRead:async()=>{},onEvent:fn=>{listeners.push(fn);return()=>{};},onBrowserState:()=>()=>{},onUpdateStatus:()=>()=>{},onSessionTitleChanged:()=>()=>{},onAgentTaskEvent:()=>()=>{},respondRuntimeApproval:async(sessionId,requestId,decision)=>{window.__calls.push({action:'approval',sessionId,requestId,decision});const resolved={...events[0],id:'resolved',approval:{...events[0].approval,state:decision==='allow_once'?'allowed':'rejected'}};events.push(resolved);listeners.forEach(fn=>fn(resolved));}};
window.jinggong=api;
window.__settings=settings;
window.__prepareApp=()=>{events=[{id:'grok-user',sessionId:'grok-session',type:'user',text:'合成全权限会话，仅验证界面',createdAt:now}];};
window.__prepareSwitch=()=>{session.runtimeKind='claude_agent_sdk';session.model='second';delete session.runtimeThreadId;session.status='idle';events=[];};
window.__prepareRecovery=()=>{window.__prepareSwitch();grokHealth={available:false,compatible:false,version:'',detail:'未检测到合成 Grok 组件'};events=[{id:'user-fixture',sessionId:session.id,type:'user',text:'组件恢复测试',createdAt:now}];};
window.__installGrok=()=>{grokHealth=copy(health);};
window.__emit=event=>{events.push(event);listeners.forEach(fn=>fn(event));};
`;

async function mount(mode) {
  const source = `import React from 'react';import {createRoot} from 'react-dom/client';import {SettingsPanel} from './apps/desktop/src/renderer/SettingsPanel';import {App} from './apps/desktop/src/renderer/App';import './apps/desktop/src/renderer/styles.css';${fixture}\n${mode === 'app' ? 'window.__prepareApp();createRoot(document.getElementById("root")).render(<App/>);' : mode === 'switch' ? 'window.__prepareSwitch();createRoot(document.getElementById("root")).render(<App/>);' : mode === 'recovery' ? 'window.__prepareRecovery();createRoot(document.getElementById("root")).render(<App/>);' : 'createRoot(document.getElementById("root")).render(<SettingsPanel settings={settings} sessions={[]} projects={[]} initialTab="runtime" onChanged={()=>{}} onClose={()=>{}}/>);'}`;
  const bundle = await build({ stdin: { contents: source, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, outdir: 'memory-grok-ui', platform: 'browser', jsx: 'automatic', logLevel: 'silent' });
  const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
  await page.goto('about:blank');
  await page.setContent('<html lang="zh-CN" data-theme="dark" data-style="minimal"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
}
async function fit() {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(size.document <= size.viewport + 1, JSON.stringify(size));
}
try {
  await mount('settings');
  const runtimeSettings = page.getByRole('region', { name: 'Runtime 设置', exact: true });
  await expect(page.getByRole('heading', { name: 'Runtime 组件状态', exact: true })).toBeVisible();
  await expect(runtimeSettings.locator('.runtime-choice')).toHaveCount(4);
  await expect(runtimeSettings.getByText('Grok Build Runtime', { exact: true })).toBeVisible();
  for (const name of ['Grok Build Runtime', 'Grok 模型协议']) await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  for (const name of ['启用 Grok Runtime', 'Grok 可执行文件路径', '代理 URL', '已配置的模型中转站', 'Grok 模型 1 协议']) await expect(page.getByLabel(name, { exact: true })).toHaveCount(0);
  for (const name of ['保存 Grok Runtime 设置', '保存 Grok 模型协议', '验证连接']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect(runtimeSettings.locator('input, select, textarea, .grok-settings')).toHaveCount(0);
  await page.getByRole('button', { name: '检查 Grok Build Runtime', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__calls.filter(item => item.action === 'checkRuntime' && item.kind === 'grok_build_acp').length)).toBe(2);
  for (const width of [1280, 800]) { await page.setViewportSize({ width, height: 900 }); await fit(); }
  if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, 'grok-settings.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount('app');
  await expect(page.getByLabel('会话执行权限')).toContainText('完整访问：文件读写与本机命令直接执行，遵循当前 Windows 用户权限。');
  await expect(page.getByRole('region', { name: 'Grok 工具审批', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('grok_build_acp');
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  await expect(page.getByLabel('会话中转站', { exact: true })).toBeEnabled();
  assert.deepEqual(await page.getByLabel('会话中转站', { exact: true }).locator('option').allTextContents(), ['通用中转站', '备用中转站']);
  await expect(page.getByLabel('会话模型', { exact: true })).toBeEnabled();
  await expect(page.getByText('空闲时可更换中转站和模型；应用后保留聊天记录，下一轮使用新配置重新连接。', { exact: true })).toBeVisible();
  await page.getByLabel('会话模型', { exact: true }).selectOption('second');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeDisabled();
  assert.equal((await page.evaluate(() => window.__calls.filter(item => item.action === 'configure').at(-1))).model, 'second');
  await page.getByLabel('会话中转站', { exact: true }).selectOption('backup');
  await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('backup-model');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeDisabled();
  assert.equal((await page.evaluate(() => window.__calls.filter(item => item.action === 'configure').at(-1))).providerId, 'backup');
  await page.getByLabel('会话中转站', { exact: true }).selectOption('common');
  await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('grok-4.5');
  await page.getByRole('button', { name: '应用设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '应用设置', exact: true })).toBeDisabled();
  assert.equal((await page.evaluate(() => window.__calls.filter(item => item.action === 'configure').at(-1))).providerId, 'common');
  await expect(page.getByText('合成全权限会话，仅验证界面', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.__calls = []; });
  await page.getByRole('button', { name: '关闭会话设置', exact: true }).click();
  if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, 'grok-full-permissions.png') });
  await page.getByLabel('当前会话运行时', { exact: true }).selectOption('codex');
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('grok_build_acp');
  await expect(page.getByRole('alert')).toContainText('此会话已建立 Runtime 绑定');
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(item => item.action === 'configure')), []);
  await expect(page.getByRole('region', { name: 'Grok 工具审批', exact: true })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(item => item.action === 'approval')), []);
  await page.evaluate(() => {
    window.__emit({ id: 'grok-running', sessionId: 'grok-session', type: 'status', text: 'running', createdAt: '2026-11-13T00:00:00Z' });
    window.__emit({ id: 'legacy-pending', sessionId: 'grok-session', type: 'approval', text: '旧版待审批事件', createdAt: '2026-11-12T00:00:00Z', approval: { requestId: 'legacy-request', title: '旧版读取 input.txt', toolName: 'read_file', input: '{"path":"input.txt"}', state: 'pending' } });
  });
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  await expect(page.getByLabel('会话中转站', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('会话模型', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('推理强度', { exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Grok 工具审批', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '允许一次', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(item => item.action === 'approval')), []);
  await page.evaluate(() => window.__emit({ id: 'grok-interrupted', sessionId: 'grok-session', type: 'status', text: 'interrupted', createdAt: '2026-11-13T00:00:01Z' }));
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭会话设置', exact: true }).click();
  await fit();
  await mount('switch');
  await page.getByLabel('当前会话运行时', { exact: true }).selectOption('grok_build_acp');
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('grok_build_acp');
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(item => item.action === 'configure')), [{ action: 'configure', sessionId: 'grok-session', runtimeKind: 'grok_build_acp', providerId: 'common', model: 'second' }]);
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  assert.deepEqual(await page.getByLabel('会话中转站', { exact: true }).locator('option').allTextContents(), ['通用中转站', '备用中转站']);
  await expect(page.getByLabel('会话中转站', { exact: true })).toHaveValue('common');
  await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('second');
  await expect(page.getByLabel('会话模型', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '管理中转站与凭据', exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.__settings.grok), undefined);
  assert.equal(await page.evaluate(() => window.jinggong.grok), undefined);
  if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, 'grok-session-model.png') });
  await mount('recovery');
  const grokOption = page.getByLabel('当前会话运行时', { exact: true }).locator('option[value="grok_build_acp"]');
  await expect(grokOption).toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: '全局设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: '运行时', exact: true }).click();
  const grokStatus = page.locator('.runtime-choice').filter({ hasText: 'Grok Build Runtime' });
  await expect(grokStatus).toContainText('未检测到合成 Grok 组件');
  await page.evaluate(() => window.__installGrok());
  await page.getByRole('button', { name: '检查 Grok Build Runtime', exact: true }).click();
  await expect(grokStatus).toContainText('可用 · 1.0.67');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(grokOption).not.toHaveAttribute('disabled', '');
  await page.getByLabel('当前会话运行时', { exact: true }).selectOption('grok_build_acp');
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('grok_build_acp');
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  await expect(page.getByLabel('会话中转站', { exact: true })).toHaveValue('common');
  await expect(page.getByLabel('会话模型', { exact: true })).toHaveValue('second');
  assert.equal(await page.evaluate(() => window.__calls.filter(item => item.action === 'bootstrap').length), 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['运行时仅保留四种组件状态和刷新','Grok配置及模型协议表单/输入/保存按钮均已移除','800/1280宽度无横向溢出','已绑定Grok空闲可换模型与中转站及切回，历史保留；Runtime类型锁和运行中禁改保持','没有Grok全局配置和专用API也能切换Runtime并沿用共享模型','全权限提示可见且正常会话无工具审批界面或审批调用','活动运行收到旧版pending历史仍无审批界面/按钮/调用','启动缺失组件在设置刷新后立即恢复会话Runtime选择且不重载bootstrap'], ...(screenshotRoot ? { screenshots: screenshotRoot } : {}) }, null, 2));
} finally { await browser.close(); }

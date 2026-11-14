import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

// 真实 Chromium 界面回归；桥接、持久化和运行事件均为合成数据，不调用真实模型。
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

const fixture = `
const now = '2026-11-13T00:00:00Z';
const copy = value => JSON.parse(JSON.stringify(value));
const provider = {id:'common',name:'合成中转站',baseUrl:'https://relay.invalid/v1',models:['gpt-test'],hasKey:true};
const settings = {runtimeKind:'grok_build_acp',preferences:{theme:'dark',style:'minimal',completionSound:'off'},providers:[provider],jira:{baseUrl:'',account:'',hasPassword:false},documents:[],memories:[],update:{state:'disabled',message:'合成离线回归'},appVersion:'0.6.9',updateUrl:'https://update.invalid'};
const health = {available:true,compatible:true,version:'1.0.67',detail:'合成运行时状态'};
let state = window.__initialFixture || {sessions:[],events:{},calls:[],sequence:0};
const listeners = new Set();
const sessionById = id => {const item=state.sessions.find(session=>session.id===id);if(!item)throw new Error('未知合成会话');return item;};
const emit = event => {state.events[event.sessionId] ||= [];state.events[event.sessionId].push(event);listeners.forEach(fn=>fn(copy(event)));};
const bootstrap = () => ({projects:[],sessions:copy(state.sessions),activeSessionIds:state.sessions.filter(item=>['running','waiting-approval'].includes(item.status)).map(item=>item.id),provider:{baseUrl:provider.baseUrl,model:'gpt-test',hasKey:true},runtime:health,runtimes:{codex:health,jinggong:health,claude_agent_sdk:health,grok_build_acp:health},dataDirectory:'C:/synthetic-data',gitVersion:'synthetic',settings:copy(settings),layout:{leftVisible:true,rightVisible:false,bottomVisible:false,leftWidth:220,rightWidth:420,bottomHeight:180},closeToTray:false});
const api = {
  bootstrap:async()=>{state.calls.push({action:'bootstrap'});return bootstrap();},
  getSettings:async()=>copy(settings),
  createSession:async input=>{state.calls.push({action:'create',...copy(input)});const id='session-'+(++state.sequence);const item={id,title:'新会话 '+state.sequence,createdAt:now,workspacePath:'C:/synthetic-workspaces/'+id,runtimeKind:input.runtimeKind,providerId:provider.id,model:'gpt-test',reasoningEffort:state.modelDefaults?.reasoningEffort,status:'idle'};state.sessions.unshift(item);return copy(item);},
  configureSession:async(id,input)=>{const item=sessionById(id);state.calls.push({action:'configure',sessionId:id,...copy(input),hasReasoning:Object.hasOwn(input,'reasoningEffort')});Object.assign(item,input);state.modelDefaults={providerId:item.providerId,model:item.model,reasoningEffort:item.reasoningEffort};return copy(item);},
  deleteSession:async id=>{state.calls.push({action:'delete',sessionId:id});state.sessions=state.sessions.filter(item=>item.id!==id);},
  getEvents:async id=>copy(state.events[id]||[]),
  listAgentTasks:async()=>[],getDiff:async()=>[],getFileDiff:async()=>null,
  browserState:async id=>({sessionId:id,visible:false,tabs:[],downloads:[]}),setBrowserViewport:async()=>{},
  notifyCompletion:async()=>{},markSessionRead:async()=>{},
  onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onBrowserState:()=>()=>{},onUpdateStatus:()=>()=>{},onSessionTitleChanged:()=>()=>{},onAgentTaskEvent:()=>()=>{}
};
window.jinggong=api;
window.__state=()=>copy(state);
window.__retainSession=id=>{state.events[id] ||= [{id:'history-'+id,sessionId:id,type:'user',text:'合成历史，仅用于会话隔离回归',createdAt:now}];};
window.__bindSession=id=>{sessionById(id).runtimeThreadId='synthetic-thread-'+id;};
window.__status=(id,status)=>{sessionById(id).status=status;emit({id:'status-'+(++state.sequence),sessionId:id,type:'status',text:status,createdAt:now});};
createRoot(document.getElementById('root')).render(<App/>);
`;
const bundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './apps/desktop/src/renderer/App';import './apps/desktop/src/renderer/styles.css';${fixture}`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, outdir: 'memory-session-reasoning', platform: 'browser', jsx: 'automatic', logLevel: 'silent' });
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
const executablePath = await installedChromium();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
const checks = [];
page.on('pageerror', error => errors.push(error.message));
// 合成桥接不应向外部网络发起模型请求。
await page.route(/^https?:/, route => route.abort('blockedbyclient'));

async function mount(state) {
  await page.goto('about:blank');
  await page.setContent('<html lang="zh-CN" data-theme="dark" data-style="minimal"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>');
  if (state) await page.evaluate(value => { window.__initialFixture = value; }, state);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByRole('button', { name: '新建会话', exact: true }).first()).toBeEnabled();
}
async function openSettings() {
  await page.getByRole('button', { name: '打开当前会话设置', exact: true }).click();
  await expect(page.getByRole('region', { name: '会话设置', exact: true })).toBeVisible();
}
const reasoning = () => page.getByLabel('推理强度', { exact: true });
const apply = () => page.getByRole('button', { name: '应用设置', exact: true });
async function choose(value, label) {
  await expect(reasoning()).toBeEnabled();
  await reasoning().selectOption(value);
  await expect(apply()).toBeEnabled();
  await apply().click();
  await expect(apply()).toBeDisabled();
  await expect(page.getByLabel('当前会话推理强度：' + label, { exact: true })).toHaveText('推理 ' + label);
}
async function selectedId() { return page.evaluate(() => document.querySelector('.session-item.selected .session-name')?.textContent); }

try {
  await mount();
  await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByLabel('当前会话运行时', { exact: true })).toHaveValue('grok_build_acp');
  await expect(page.getByLabel('当前会话本地项目', { exact: true })).toHaveValue('');
  await openSettings();
  await expect(reasoning()).toHaveValue('');
  // 修复前在这里失败：全新的空闲 Grok 会话被无条件禁用。
  await expect(reasoning()).toBeEnabled();
  checks.push('真实点击新建独立 Grok 会话后推理强度可选择');
  await choose('high', '高');
  let state = await page.evaluate(() => window.__state());
  const firstId = state.sessions[0].id;
  assert.equal(state.sessions[0].reasoningEffort, 'high');
  assert.deepEqual(state.calls.find(item => item.action === 'create'), { action: 'create', runtimeKind: 'grok_build_acp' });
  assert.equal(state.calls.filter(item => item.action === 'configure').at(-1).reasoningEffort, 'high');
  checks.push('选择高并应用后桥接收到 high，刷新后选值和摘要一致');
  if (screenshotRoot) await page.screenshot({ path: path.join(screenshotRoot, 'new-session-reasoning-high.png') });

  // 重新装载 App，使用上一轮持久化合成快照验证初始化读回。
  await mount(state);
  await openSettings();
  await expect(reasoning()).toHaveValue('high');
  await expect(page.getByLabel('当前会话推理强度：高', { exact: true })).toBeVisible();
  await choose('', '模型默认');
  state = await page.evaluate(() => window.__state());
  assert.equal(state.sessions.find(item => item.id === firstId).reasoningEffort, undefined);
  assert.equal(state.calls.filter(item => item.action === 'configure').at(-1).hasReasoning, true);
  checks.push('重新装载保留 high，恢复模型默认后明确清除已保存强度');
  await choose('medium', '中');
  await page.evaluate(id => window.__retainSession(id), firstId);
  await page.getByRole('button', { name: '关闭会话设置', exact: true }).click();
  await page.locator('.top-nav').getByRole('button', { name: '新建会话', exact: true }).click();
  await expect.poll(selectedId).toBe('新会话 2');
  await openSettings();
  await expect(reasoning()).toHaveValue('medium');
  await choose('low', '低');
  state = await page.evaluate(() => window.__state());
  const secondId = state.sessions.find(item => item.id !== firstId).id;
  await page.evaluate(id => window.__retainSession(id), secondId);
  await page.getByRole('button', { name: '关闭会话设置', exact: true }).click();
  await page.locator('.session-item').filter({ hasText: '新会话 1' }).click();
  await openSettings();
  await expect(reasoning()).toHaveValue('medium');
  await expect(page.getByLabel('当前会话推理强度：中', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭会话设置', exact: true }).click();
  await page.locator('.session-item').filter({ hasText: '新会话 2' }).click();
  await openSettings();
  await expect(reasoning()).toHaveValue('low');
  checks.push('连续新建会话继承上次保存的 medium，切换旧会话保留各自 medium/low，不相互覆盖');

  await page.evaluate(id => window.__bindSession(id), secondId);
  state = await page.evaluate(() => window.__state());
  await mount(state);
  await openSettings();
  await expect(page.getByLabel('会话模型', { exact: true })).toBeEnabled();
  await choose('high', '高');
  state = await page.evaluate(() => window.__state());
  assert.equal(state.sessions.find(item => item.id === secondId).runtimeThreadId, 'synthetic-thread-' + secondId);
  checks.push('已绑定但空闲的 Grok 会话可改推理强度，保留原线程绑定');
  await page.evaluate(id => window.__status(id, 'running'), secondId);
  await expect(reasoning()).toBeDisabled();
  await expect(apply()).toBeDisabled();
  await page.evaluate(id => window.__status(id, 'completed'), secondId);
  await expect(reasoning()).toBeEnabled();
  checks.push('活动运行期间禁止修改，任务结束恢复选择');

  for (const kind of ['codex', 'jinggong', 'claude_agent_sdk']) {
    state = await page.evaluate(() => window.__state());
    state.sessions = [{ ...state.sessions[0], id: kind + '-session', runtimeKind: kind, runtimeThreadId: undefined, reasoningEffort: undefined, status: 'idle' }];
    await mount(state);
    await openSettings();
    await choose('high', '高');
    assert.equal((await page.evaluate(() => window.__state())).sessions[0].reasoningEffort, 'high');
  }
  checks.push('Codex/Jinggong/Claude 会话原有推理强度选择与保存保持可用');
  await page.setViewportSize({ width: 800, height: 900 });
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(size.document <= size.viewport + 1, JSON.stringify(size));
  assert.deepEqual(errors, []);
  checks.push('800 像素宽度无横向溢出，整个回归无浏览器异常');
  console.log(JSON.stringify({ passed: true, checks, scope: '真实 Chromium 与 React 界面；合成桥接/会话持久化/运行事件；未调用真实中转站或模型', ...(screenshotRoot ? { screenshots: screenshotRoot } : {}) }, null, 2));
} finally { await browser.close(); }

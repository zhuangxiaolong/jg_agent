import { BrowserWindow, WebContentsView, ipcMain, type WebFrameMain, type WebContents } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserAction } from '../../../../packages/domain/src';

const actionSchema = z.object({ action: z.enum(['open', 'snapshot', 'click', 'fill', 'select', 'press', 'evaluate', 'screenshot', 'back', 'forward', 'reload', 'tab']), url: z.string().max(4000).optional(), ref: z.string().max(100).optional(), selector: z.string().max(2000).optional(), frame: z.string().max(100).optional(), value: z.string().max(50000).optional(), script: z.string().max(100000).optional(), key: z.string().max(100).optional(), tabId: z.string().max(100).optional() }).strict();
function pageUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('浏览器地址须为 HTTP 或 HTTPS'); return url.toString(); }
interface Tab { id: string; view: WebContentsView; contents: WebContents }
interface BrowserState { window: BrowserWindow; tabs: Tab[]; active: string; downloads: string[]; sessionId: string }

/** 网页运行于独立 WebContents，无本机 Node 和应用 IPC；AI 通过同一可见页面操作。 */
export class BrowserManager {
  private readonly states = new Map<string, BrowserState>();
  constructor(private readonly owner: BrowserWindow, private readonly root: string, private readonly dist: string) {
    ipcMain.handle('browser:toolbar', async (event, action: unknown) => {
      const state = [...this.states.values()].find(item => item.window.webContents === event.sender && event.senderFrame === item.window.webContents.mainFrame);
      if (!state) throw new Error('浏览器页面不能调用工具栏接口');
      if (action === 'state') return this.status(state);
      return this.action(state.sessionId, actionSchema.parse(action));
    });
  }
  private state(sessionId: string): BrowserState {
    const existing = this.states.get(sessionId); if (existing && !existing.window.isDestroyed()) return existing;
    const win = new BrowserWindow({ parent: this.owner, width: 1280, height: 860, minWidth: 700, minHeight: 500, title: '精工Agent · 浏览器', backgroundColor: '#16181d', autoHideMenuBar: true, webPreferences: { preload: path.join(this.dist, 'browser-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const state: BrowserState = { window: win, tabs: [], active: '', downloads: [], sessionId };
    this.states.set(sessionId, state);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('resize', () => this.layout(state));
    win.on('closed', () => { for (const tab of state.tabs) if (!tab.contents.isDestroyed()) tab.contents.close(); this.states.delete(sessionId); });
    void win.loadFile(path.join(this.dist, 'renderer/browser.html'));
    this.newTab(state); return state;
  }
  private newTab(state: BrowserState, contents?: WebContents): Tab {
    const view = new WebContentsView(contents ? { webContents: contents } : { webPreferences: { partition: 'persist:jinggong-browser', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    const tab = { id: randomUUID(), view, contents: view.webContents }; state.tabs.push(tab);
    state.window.contentView.addChildView(view); state.active = tab.id;
    view.webContents.setWindowOpenHandler(details => {
      try { if (details.url && details.url !== 'about:blank') pageUrl(details.url); } catch { return { action: 'deny' }; }
      return { action: 'allow', createWindow: options => this.newTab(state, (options as { webContents?: WebContents }).webContents).contents };
    });
    view.webContents.on('will-navigate', (event, url) => { try { pageUrl(url); } catch { event.preventDefault(); } });
    view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    if (!(view.webContents.session as any).__jinggongDownloads) {
      (view.webContents.session as any).__jinggongDownloads = true;
      view.webContents.session.on('will-download', (_event, item, contents) => {
        const target = [...this.states.values()].find(state => state.tabs.some(tab => tab.contents === contents));
        if (!target) { item.cancel(); return; }
        const folder = path.join(this.root, 'exports/browser'); mkdirSync(folder, { recursive: true });
        const filename = path.join(folder, `${randomUUID()}-${path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`);
        item.setSavePath(filename); item.once('done', (_event, status) => { if (status === 'completed') target.downloads.push(filename); });
      });
    }
    this.layout(state); return tab;
  }
  private layout(state: BrowserState): void {
    const [width, height] = state.window.getContentSize();
    for (const tab of state.tabs) { tab.view.setVisible(tab.id === state.active); tab.view.setBounds({ x: 0, y: 70, width, height: Math.max(0, height - 70) }); }
  }
  private status(state: BrowserState) { return { tabs: state.tabs.map(tab => ({ id: tab.id, title: tab.contents.getTitle() || '新标签页', url: tab.contents.getURL(), active: tab.id === state.active })), downloads: state.downloads.slice(-20) }; }
  async open(sessionId: string, url?: string): Promise<void> { await this.action(sessionId, { action: 'open', ...(url ? { url } : {}) }); }
  async action(sessionId: string, input: unknown): Promise<{ text: string; imageUrl?: string }> {
    const action = actionSchema.parse(input), state = this.state(sessionId);
    if (action.tabId) { if (!state.tabs.some(tab => tab.id === action.tabId)) throw new Error('浏览器标签不存在'); state.active = action.tabId; this.layout(state); }
    const tab = state.tabs.find(tab => tab.id === state.active)!;
    const contents = tab.contents;
    if (action.action === 'open') { state.window.show(); state.window.focus(); if (action.url) await contents.loadURL(pageUrl(action.url)); }
    else if (action.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action.action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action.action === 'reload') contents.reload();
    else if (action.action === 'screenshot') return { text: JSON.stringify(this.status(state)), imageUrl: (await contents.capturePage()).toDataURL() };
    else if (action.action !== 'snapshot' && action.action !== 'tab') {
      const frames = contents.mainFrame.framesInSubtree;
      const frame = action.frame ? frames.find(item => `${item.processId}:${item.routingId}` === action.frame) : contents.mainFrame;
      if (!frame) throw new Error('页面框架已变化，请重新读取页面');
      if (action.action === 'evaluate') { if (!action.script?.trim()) throw new Error('请提供页面脚本'); const value = await frame.executeJavaScript(action.script, true); return { text: JSON.stringify({ result: value, ...this.status(state) }).slice(0, 50000) }; }
      const result = await frame.executeJavaScript(`(async () => {
        const args = ${JSON.stringify(action)};
        const element = args.ref ? document.querySelector('[data-jinggong-ref="' + CSS.escape(args.ref) + '"]') : args.selector ? document.querySelector(args.selector) : document.activeElement;
        if (!element || !(element instanceof HTMLElement)) throw Error('未找到页面元素，请重新读取页面');
        element.scrollIntoView({ block: 'center' }); element.focus();
        if (args.action === 'click') element.click();
        if (args.action === 'fill') {
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, args.value || ''); }
          else if (element.isContentEditable) element.textContent = args.value || '';
          else throw Error('该元素不支持填写');
          element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (args.action === 'select') { if (!(element instanceof HTMLSelectElement)) throw Error('该元素不是下拉框'); element.value = args.value || ''; element.dispatchEvent(new Event('change', { bubbles: true })); }
        return { done: true };
      })()`, true) as { done?: boolean };
      if (action.action === 'press') {
        const key = action.key || 'Return'; contents.sendInputEvent({ type: 'keyDown', keyCode: key }); contents.sendInputEvent({ type: 'keyUp', keyCode: key });
      }
      if (!result?.done) throw new Error('浏览器操作未完成');
    }
    const snapshots = [];
    for (const frame of contents.mainFrame.framesInSubtree.slice(0, 16)) {
      try { snapshots.push(await this.snapshot(frame)); } catch { /* 页面跳转时已销毁的框架在下一次快照重新获取。 */ }
    }
    return { text: JSON.stringify({ ...this.status(state), frames: snapshots }).slice(0, 60000) };
  }
  private async snapshot(frame: WebFrameMain) {
    const result = await frame.executeJavaScript(`(() => {
      let index = 0;
      const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(e => e.getClientRects().length).slice(0, 300).map(e => {
        const ref = 'e' + (++index); e.setAttribute('data-jinggong-ref', ref);
        return { ref, tag: e.tagName.toLowerCase(), type: e.type || '', text: (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || '').slice(0, 200), value: e.type === 'password' ? '[密码输入框]' : (e.value || '').slice(0, 200), options: e instanceof HTMLSelectElement ? [...e.options].slice(0,100).map(o => ({ value: o.value, text: o.text })) : undefined };
      });
      return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 16000), elements };
    })()`) as Record<string, unknown>;
    return { frame: `${frame.processId}:${frame.routingId}`, ...result };
  }
  closeSession(sessionId: string): void { this.states.get(sessionId)?.window.close(); }
  close(): void { for (const state of this.states.values()) state.window.destroy(); ipcMain.removeHandler('browser:toolbar'); }
}

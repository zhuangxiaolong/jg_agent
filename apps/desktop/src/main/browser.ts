import { BrowserWindow, WebContentsView, type WebFrameMain, type WebContents } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserPanelState, BrowserViewport } from '../../../../packages/domain/src';
import { browserViewportBounds, browserViewportSchema } from './browser-viewport';

const actionSchema = z.object({ action: z.enum(['open', 'snapshot', 'click', 'fill', 'select', 'press', 'evaluate', 'screenshot', 'back', 'forward', 'reload', 'tab']), url: z.string().max(4000).optional(), ref: z.string().max(100).optional(), selector: z.string().max(2000).optional(), frame: z.string().max(100).optional(), value: z.string().max(50000).optional(), script: z.string().max(100000).optional(), key: z.string().max(100).optional(), tabId: z.string().max(100).optional() }).strict();
function pageUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('浏览器地址须为 HTTP 或 HTTPS'); return url.toString(); }
interface Tab { id: string; view: WebContentsView; contents: WebContents }
interface BrowserState { tabs: Tab[]; active: string; downloads: string[]; sessionId: string; visible: boolean }

/** 网页运行于独立 WebContents，无本机 Node 和应用 IPC；AI 通过同一可见页面操作。 */
export class BrowserManager {
  private readonly states = new Map<string, BrowserState>();
  private viewport?: BrowserViewport;
  private readonly onResize = () => this.layout();
  private readonly onNavigate = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
    if (mainFrame) { this.viewport = undefined; this.layout(); }
  };
  constructor(private readonly owner: BrowserWindow, private readonly root: string) {
    owner.on('resize', this.onResize);
    owner.webContents.on('did-start-navigation', this.onNavigate);
  }
  private state(sessionId: string): BrowserState {
    const existing = this.states.get(sessionId); if (existing) return existing;
    const state: BrowserState = { tabs: [], active: '', downloads: [], sessionId, visible: false };
    this.states.set(sessionId, state);
    this.newTab(state); return state;
  }
  private newTab(state: BrowserState, contents?: WebContents): Tab {
    const view = new WebContentsView(contents ? { webContents: contents } : { webPreferences: { partition: 'persist:jinggong-browser', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
    const tab = { id: randomUUID(), view, contents: view.webContents }; state.tabs.push(tab);
    view.setVisible(false);
    this.owner.contentView.addChildView(view); state.active = tab.id;
    view.webContents.setWindowOpenHandler(details => {
      try { if (details.url && details.url !== 'about:blank') pageUrl(details.url); } catch { return { action: 'deny' }; }
      return { action: 'allow', createWindow: options => this.newTab(state, (options as { webContents?: WebContents }).webContents).contents };
    });
    view.webContents.on('will-navigate', (event, url) => { try { pageUrl(url); } catch { event.preventDefault(); } });
    const publish = () => this.publish(state);
    view.webContents.on('did-start-loading', publish);
    view.webContents.on('did-stop-loading', publish);
    view.webContents.on('did-navigate', publish);
    view.webContents.on('did-navigate-in-page', publish);
    view.webContents.on('page-title-updated', publish);
    view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    if (!(view.webContents.session as any).__jinggongDownloads) {
      (view.webContents.session as any).__jinggongDownloads = true;
      view.webContents.session.on('will-download', (_event, item, contents) => {
        const target = [...this.states.values()].find(state => state.tabs.some(tab => tab.contents === contents));
        if (!target) { item.cancel(); return; }
        const folder = path.join(this.root, 'exports/browser'); mkdirSync(folder, { recursive: true });
        const filename = path.join(folder, `${randomUUID()}-${path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`);
        item.setSavePath(filename); item.once('done', (_event, status) => { if (status === 'completed') { target.downloads.push(filename); this.publish(target); } });
      });
    }
    this.layout(); this.publish(state); return tab;
  }
  private layout(): void {
    if (this.owner.isDestroyed()) return;
    const viewport = this.viewport;
    const bounds = viewport?.bounds ? browserViewportBounds(viewport.bounds, this.owner.getContentSize(), this.owner.webContents.getZoomFactor()) : undefined;
    for (const state of this.states.values()) for (const tab of state.tabs) {
      const visible = !!(state.visible && viewport?.visible && state.sessionId === viewport.sessionId && tab.id === state.active && bounds?.width && bounds.height);
      if (visible && bounds) tab.view.setBounds(bounds);
      tab.view.setVisible(visible);
    }
  }
  private status(state: BrowserState): BrowserPanelState {
    return { sessionId: state.sessionId, visible: state.visible, tabs: state.tabs.filter(tab => !tab.contents.isDestroyed()).map(tab => ({ id: tab.id, title: tab.contents.getTitle() || '新标签页', url: tab.contents.getURL(), active: tab.id === state.active, canGoBack: tab.contents.navigationHistory.canGoBack(), canGoForward: tab.contents.navigationHistory.canGoForward(), loading: tab.contents.isLoading() })), downloads: state.downloads.slice(-20) };
  }
  private publish(state: BrowserState): void {
    if (!this.owner.isDestroyed() && !this.owner.webContents.isDestroyed() && this.states.get(state.sessionId) === state) this.owner.webContents.send('browser:state', this.status(state));
  }
  getState(sessionId: string): BrowserPanelState {
    const state = this.states.get(sessionId);
    return state ? this.status(state) : { sessionId, visible: false, tabs: [], downloads: [] };
  }
  setViewport(input: unknown): void {
    const viewport = browserViewportSchema.parse(input);
    if (!viewport.visible && this.viewport?.sessionId !== viewport.sessionId) return;
    this.viewport = viewport;
    this.layout();
  }
  hide(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) { state.visible = false; this.layout(); this.publish(state); }
  }
  async open(sessionId: string, url?: string): Promise<void> { await this.action(sessionId, { action: 'open', ...(url ? { url } : {}) }); }
  async action(sessionId: string, input: unknown): Promise<{ text: string; imageUrl?: string }> {
    const action = actionSchema.parse(input), state = this.state(sessionId);
    if (action.tabId) { if (!state.tabs.some(tab => tab.id === action.tabId)) throw new Error('浏览器标签不存在'); state.active = action.tabId; this.layout(); this.publish(state); }
    const tab = state.tabs.find(tab => tab.id === state.active)!;
    const contents = tab.contents;
    if (action.action === 'open') { state.visible = true; this.layout(); this.publish(state); if (action.url) await contents.loadURL(pageUrl(action.url)); }
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
  closeSession(sessionId: string): void {
    const state = this.states.get(sessionId); if (!state) return;
    this.states.delete(sessionId);
    if (this.viewport?.sessionId === sessionId) this.viewport = undefined;
    for (const tab of state.tabs) {
      if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(tab.view);
      if (!tab.contents.isDestroyed()) tab.contents.close();
    }
  }
  close(): void {
    this.owner.removeListener('resize', this.onResize);
    if (!this.owner.webContents.isDestroyed()) this.owner.webContents.removeListener('did-start-navigation', this.onNavigate);
    for (const id of [...this.states.keys()]) this.closeSession(id);
  }
}

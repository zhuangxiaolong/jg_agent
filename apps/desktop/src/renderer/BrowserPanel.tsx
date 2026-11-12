import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserAction, BrowserPanelState, DesktopApi } from '../../../../packages/domain/src';
import { Icon } from './ui';
import './browser-panel.css';

export function BrowserPanel({ api, state, suspended, onClose, onError }: {
  api: DesktopApi; state: BrowserPanelState; suspended: boolean; onClose: () => void; onError: (error: unknown) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const addressFocused = useRef(false);
  const activeTab = state.tabs.find(tab => tab.active);
  const hasPage = !!activeTab?.url && activeTab.url !== 'about:blank';
  const [address, setAddress] = useState(activeTab?.url || '');
  const [failure, setFailure] = useState('');
  useEffect(() => { if (!addressFocused.current) setAddress(activeTab?.url || ''); }, [activeTab?.id, activeTab?.url]);

  // 原生网页只覆盖占位区域；设置、菜单等上层界面出现时立即隐藏。
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let animation = 0, disposed = false, last = '';
    const update = () => {
      animation = 0;
      if (disposed) return;
      const box = element.getBoundingClientRect();
      const overlay = Array.from(document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="menu"], .modal-backdrop')).some(node => node.getClientRects().length > 0);
      const visible = hasPage && !suspended && !document.hidden && !overlay && box.width > 0 && box.height > 0;
      const input = { sessionId: state.sessionId, visible, ...(visible ? { bounds: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) } } : {}) };
      const signature = JSON.stringify(input);
      if (signature === last) return;
      last = signature;
      void api.setBrowserViewport(input).catch(error => { if (!disposed) { last = ''; onError(error); } });
    };
    const schedule = () => { if (!animation) animation = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    const mutations = new MutationObserver(schedule);
    observer.observe(element);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'role', 'hidden'] });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    update();
    return () => {
      disposed = true; cancelAnimationFrame(animation); observer.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); document.removeEventListener('visibilitychange', schedule);
      void api.setBrowserViewport({ sessionId: state.sessionId, visible: false }).catch(() => {});
    };
  }, [api, state.sessionId, suspended, hasPage]);

  async function perform(action: BrowserAction) {
    setFailure('');
    try { await api.browserAction(state.sessionId, action); }
    catch (error) { setFailure(error instanceof Error ? error.message : String(error)); }
  }
  function navigate(event: FormEvent) {
    event.preventDefault();
    const value = address.trim();
    if (!value) return;
    void perform({ action: 'open', url: /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}` });
  }
  return <section id="browser-panel" className="browser-panel" role="region" aria-label="会话浏览器">
    <div className="browser-panel-header"><span><Icon name="box" /><strong>浏览器</strong><small>与当前会话共享</small></span><button type="button" className="icon-button" aria-label="收起浏览器" title="收起浏览器，保留页面" onClick={onClose}><Icon name="close" /></button></div>
    <div className="browser-toolbar">
      <button type="button" className="icon-button browser-history" aria-label="后退" title="后退" disabled={!activeTab?.canGoBack} onClick={() => { void perform({ action: 'back' }); }}>←</button>
      <button type="button" className="icon-button browser-history" aria-label="前进" title="前进" disabled={!activeTab?.canGoForward} onClick={() => { void perform({ action: 'forward' }); }}>→</button>
      <button type="button" className={`icon-button ${activeTab?.loading ? 'spinning' : ''}`} aria-label="刷新网页" title="刷新网页" disabled={!activeTab?.url} onClick={() => { void perform({ action: 'reload' }); }}><Icon name="refresh" /></button>
      <form onSubmit={navigate}><input aria-label="浏览器地址" placeholder="输入报表平台或网站地址" value={address} onChange={event => setAddress(event.target.value)} onFocus={() => { addressFocused.current = true; }} onBlur={() => { addressFocused.current = false; }} spellCheck={false} /><button type="submit" title="打开网页" aria-label="打开网页" disabled={!address.trim()}><Icon name="chevron" /></button></form>
    </div>
    <div className="browser-tab-row"><select aria-label="浏览器标签" value={activeTab?.id || ''} onChange={event => { void perform({ action: 'tab', tabId: event.target.value }); }}>{state.tabs.map(tab => <option key={tab.id} value={tab.id}>{tab.title || '新标签页'}</option>)}</select><span>{activeTab?.loading ? '正在加载…' : '登录后 AI 可继续操作'}</span></div>
    {failure && <div className="browser-message browser-error" role="alert">{failure}</div>}
    <div className="browser-viewport" ref={viewport}>{!hasPage && <div className="browser-empty"><Icon name="box" /><strong>在这里打开网页</strong><p>输入网址，或让 AI 打开报表平台。<br />浏览器页面会保留在当前会话中。</p></div>}</div>
    {!!state.downloads.length && <div className="browser-download" title={state.downloads.at(-1)}><Icon name="download" /><span>最近下载：{state.downloads.at(-1)}</span></div>}
  </section>;
}

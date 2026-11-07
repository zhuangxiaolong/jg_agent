const api = (window as any).browserToolbar;
const address = document.getElementById('address') as HTMLInputElement, tabs = document.getElementById('tabs') as HTMLSelectElement, notice = document.getElementById('notice')!;
async function perform(action: unknown) { try { await api.invoke(action); notice.textContent = '与会话共用此浏览器，登录后 AI 可继续操作。'; } catch (error) { notice.textContent = String(error); } }
document.getElementById('navigate')!.addEventListener('submit', event => { event.preventDefault(); const value = address.value.trim(); void perform({ action: 'open', url: /^https?:\/\//i.test(value) ? value : `https://${value}` }); });
for (const action of ['back', 'forward', 'reload']) document.getElementById(action)!.addEventListener('click', () => void perform({ action }));
tabs.addEventListener('change', () => void perform({ action: 'tab', tabId: tabs.value }));
setInterval(async () => {
  try {
    const state = await api.invoke('state');
    if (document.activeElement !== address) address.value = state.tabs.find((tab: any) => tab.active)?.url || '';
    if (document.activeElement !== tabs) { tabs.replaceChildren(...state.tabs.map((tab: any) => { const option = document.createElement('option'); option.value = tab.id; option.textContent = tab.title; option.selected = tab.active; return option; })); }
    if (state.downloads.length) notice.textContent = `最近下载：${state.downloads.at(-1)}`;
  } catch { /* 关闭窗口时停止轮询结果处理。 */ }
}, 700);

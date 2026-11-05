type IconName = 'plus' | 'folder' | 'chat' | 'settings' | 'arrow' | 'branch' | 'refresh' | 'close' | 'check' | 'chevron' | 'file' | 'box' | 'shield' | 'download' | 'stop' | 'terminal' | 'alert' | 'layers' | 'edit' | 'panel-left' | 'panel-right' | 'panel-bottom';
const paths: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14', folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z',
  settings: 'm9 3-1 3-3 1-2 3 2 3 1 3 3 1 1 3h4l1-3 3-1 1-3 2-3-2-3-1-3-3-1-1-3Z M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  arrow: 'M12 19V5m-6 6 6-6 6 6', branch: 'M6 3v12a4 4 0 0 0 4 4h4M18 6v3a4 4 0 0 1-4 4H6 M8 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M20 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0 M18 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M5 8a8 8 0 0 1 14-3l1 3 M19 16a8 8 0 0 1-14 3l-1-3', close: 'm6 6 12 12M18 6 6 18',
  check: 'm5 12 4 4L19 6', chevron: 'm9 5 7 7-7 7', file: 'M14 2H5v20h14V7Zm0 0v6h6M8 13h8M8 17h5',
  box: 'm12 3 9 5v9l-9 5-9-5V8Zm0 10 9-5M12 13 3 8M12 13v9', shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', stop: 'M6 6h12v12H6Z', terminal: 'm5 7 5 5-5 5M13 17h6',
  alert: 'm12 3 10 18H2ZM12 9v5M12 17h.01', layers: 'm12 3 10 5-10 5L2 8Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  edit: 'm16 3 5 5-12 12-6 1 1-6Zm-2 2 5 5',
  'panel-left': 'M3 3h18v18H3ZM9 3v18',
  'panel-right': 'M3 3h18v18H3ZM15 3v18',
  'panel-bottom': 'M3 3h18v18H3ZM3 15h18',
};
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function Mark({ small = false }: { small?: boolean }) {
  return <img className={small ? 'brand-mark small' : 'brand-mark'} src="assets/logo-mark.png" alt="" />;
}

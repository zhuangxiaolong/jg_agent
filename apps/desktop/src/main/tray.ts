import { app, BrowserWindow, Menu, Tray, nativeImage, dialog } from 'electron';

/** 关闭窗口只隐藏到托盘；真正退出仍由应用统一收尾 Runtime 与数据库。 */
export function createDesktopTray(window: BrowserWindow, iconPath: string, requestExit: () => Promise<void>): Tray {
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) throw new Error('桌面托盘图标无法读取');
  const tray = new Tray(icon.resize({ width: 20, height: 20 }));
  const show = () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  };
  tray.setToolTip('精工 Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开精工 Agent', click: show },
    { type: 'separator' },
    { label: '退出精工 Agent', click: () => { void requestExit().catch(() => dialog.showErrorBox('退出失败', '请等待当前操作结束后重试。')); } },
  ]));
  tray.on('click', show);
  tray.on('double-click', show);
  app.on('second-instance', show);
  app.on('activate', show);
  return tray;
}

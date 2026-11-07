import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('browserToolbar', Object.freeze({ invoke: (action: unknown) => ipcRenderer.invoke('browser:toolbar', action) }));

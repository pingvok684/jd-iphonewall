// Most medzi oknom a aplikáciou (len pár bezpečných príkazov pre sprievodcu nastavením)
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('jdApp', {
  check: () => ipcRenderer.invoke('jd:check'),
  open: (url) => ipcRenderer.invoke('jd:open', url),
  showIpa: () => ipcRenderer.invoke('jd:showIpa'),
  xcodeSetup: () => ipcRenderer.invoke('jd:xcodeSetup'),
  done: () => ipcRenderer.invoke('jd:done'),
  restart: () => ipcRenderer.invoke('jd:restart'),
  info: () => ipcRenderer.invoke('jd:info'),
  status: () => ipcRenderer.invoke('jd:status'),
  openLogs: () => ipcRenderer.invoke('jd:openLogs'),
});

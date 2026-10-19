const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action, args) => ipcRenderer.invoke('deck:action', action, args);
contextBridge.exposeInMainWorld('deck', {
  snapshot: () => invoke('snapshot'),
  importCurrent: () => invoke('importCurrent'), importFile: () => invoke('importFile'),
  startLogin: (label, method) => invoke('startLogin', { label, method }),
  cancelLogin: () => invoke('cancelLogin'), openLogin: () => invoke('openLogin'),
  sync: id => invoke('sync', { id }),
  switch: (id, restart) => invoke('switch', { id, restart }),
  remove: id => invoke('remove', { id }), rename: (id, label) => invoke('rename', { id, label }),
  settings: patch => invoke('settings', patch), pick: kind => invoke('pick', { kind }),
  restore: () => invoke('restore'),
  workflowThreads: () => invoke('workflowThreads'), workflowCreate: input => invoke('workflowCreate', input),
  workflowStart: id => invoke('workflowStart', { id }), workflowPause: id => invoke('workflowPause', { id }),
  workflowRemove: id => invoke('workflowRemove', { id }), workflowApprove: (id, requestId, accept) => invoke('workflowApprove', { id, requestId, accept }),
  onChanged: callback => { const listener = () => callback(); ipcRenderer.on('deck:changed', listener); return () => ipcRenderer.removeListener('deck:changed', listener); }
});

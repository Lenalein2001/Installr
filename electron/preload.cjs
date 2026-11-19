const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getAdminState: () => ipcRenderer.invoke('getAdminState'),
  restartAsAdmin: () => ipcRenderer.invoke('restartAsAdmin'),
  checkWinget: () => ipcRenderer.invoke('checkWinget'),
  openAppInstaller: () => ipcRenderer.invoke('openAppInstaller'),
  repairWingetAlias: () => ipcRenderer.invoke('repairWingetAlias'),
  getAppsInfo: (force, resolve) => ipcRenderer.invoke('getAppsInfo', force, resolve),
  installApps: (apps, options) => ipcRenderer.invoke('installApps', apps, options),
  getQueueState: () => ipcRenderer.invoke('getQueueState'),
  skipCurrentInstall: (token) => ipcRenderer.invoke('skipCurrentInstall', token),
  cancelRemainingInstalls: (batchId) => ipcRenderer.invoke('cancelRemainingInstalls', batchId),
  onInstallProgress: (callback) => {
    const handler = (_event, data) => callback(data)
    ipcRenderer.on('installProgress', handler)
    return () => ipcRenderer.off('installProgress', handler)
  },
})

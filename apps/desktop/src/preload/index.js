// 沙箱 preload 只依赖 Electron，不导出 ipcRenderer 或任意 channel 调用。
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (operation, payload = {}) =>
  ipcRenderer.invoke('mica:client-context', operation, payload)

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('micaClient', {
    context: () => invoke('context'),
    readData: (pluginId) => invoke('read-data', { pluginId }),
    writeData: (pluginId, value, options) =>
      invoke('write-data', {
        pluginId,
        value,
        ...(options && Object.hasOwn(options, 'expectedVersion')
          ? { expectedVersion: options.expectedVersion }
          : {})
      }),
    probe: (address) => invoke('probe', { address }),
    open: (url) => invoke('open', { url }),
    local: () => invoke('local')
  })
}

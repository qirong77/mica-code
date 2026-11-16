// 沙箱 preload 只依赖 Electron，不导出 ipcRenderer 或任意 channel 调用。
const { contextBridge, ipcRenderer } = require('electron')
const invoke = (operation, payload = {}) =>
  ipcRenderer.invoke('mica:client-context', operation, payload)
const update = (action) => ipcRenderer.invoke('mica:app-update', action)

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
    // 在**新窗口**里打开一个文件/文件夹（编辑器窗口）。浏览器宿主没有窗口，页面自己判空。
    openEditorWindow: (path) => ipcRenderer.invoke('mica:editor-window', { path }),
    local: () => invoke('local'),
    appUpdate: {
      status: () => update('status'),
      check: () => update('check'),
      download: () => update('download'),
      install: () => update('install'),
      onStatus: (callback) => {
        if (typeof callback !== 'function') return () => {}
        const listener = (_event, status) => callback(status)
        ipcRenderer.on('mica:update-status', listener)
        return () => ipcRenderer.removeListener('mica:update-status', listener)
      }
    }
  })
}

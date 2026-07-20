import { contextBridge, ipcRenderer } from 'electron'
import os from 'os'

const terminalApi = {
  create: (payload) => ipcRenderer.invoke('terminal:create', payload),
  write: (id, data) => ipcRenderer.invoke('terminal:write', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  clear: (id) => ipcRenderer.invoke('terminal:clear', { id }),
  getCwd: (id) => ipcRenderer.invoke('terminal:get-cwd', { id }),
  resolveFileLinks: (id, paths) => ipcRenderer.invoke('terminal:resolve-file-links', { id, paths }),
  openExternal: (url) => ipcRenderer.invoke('terminal:open-external', { url }),
  openFile: (id, path, line, column) =>
    ipcRenderer.invoke('terminal:open-file', { id, path, line, column }),
  dispose: (id) => ipcRenderer.invoke('terminal:dispose', { id }),
  disposeAll: () => ipcRenderer.invoke('terminal:dispose-all'),
  onData: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  }
}

const workspaceApi = {
  get: () => ipcRenderer.invoke('workspace:get'),
  save: (workspace) => ipcRenderer.invoke('workspace:save', workspace),
  selectDirectory: (payload) => ipcRenderer.invoke('dialog:select-directory', payload)
}

const notifyApi = {
  list: () => ipcRenderer.invoke('notify:list'),
  markRead: (id) => ipcRenderer.invoke('notify:mark-read', { id }),
  onChanged: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('notify:changed', listener)
    return () => ipcRenderer.removeListener('notify:changed', listener)
  }
}

const appApi = {
  getWindowState: () => ipcRenderer.invoke('app:get-window-state'),
  onWindowState: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('app:window-state', listener)
    return () => ipcRenderer.removeListener('app:window-state', listener)
  }
}

const filesApi = {
  list: (path) => ipcRenderer.invoke('files:list', { path }),
  read: (path) => ipcRenderer.invoke('files:read', { path }),
  write: (path, content, expectedVersion) =>
    ipcRenderer.invoke('files:write', { path, content, expectedVersion }),
  find: (root, query) => ipcRenderer.invoke('files:find', { root, query }),
  search: (root, query) => ipcRenderer.invoke('files:search', { root, query })
}

const gitApi = {
  summary: (cwd) => ipcRenderer.invoke('git:summary', { cwd }),
  file: (cwd, filePath) => ipcRenderer.invoke('git:file', { cwd, filePath })
}

contextBridge.exposeInMainWorld('mica', {
  terminal: terminalApi,
  workspace: workspaceApi,
  notify: notifyApi,
  app: appApi,
  files: filesApi,
  git: gitApi,
  platform: process.platform,
  windowsBuildNumber:
    process.platform === 'win32' ? Number.parseInt(os.release().split('.')[2], 10) || null : null
})

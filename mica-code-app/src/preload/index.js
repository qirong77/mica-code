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
  search: (root, query) => ipcRenderer.invoke('files:search', { root, query }),
  create: (directory, name, type) => ipcRenderer.invoke('files:create', { directory, name, type }),
  rename: (path, name) => ipcRenderer.invoke('files:rename', { path, name }),
  move: (path, directory) => ipcRenderer.invoke('files:move', { path, directory }),
  duplicate: (path) => ipcRenderer.invoke('files:duplicate', { path }),
  delete: (path) => ipcRenderer.invoke('files:delete', { path }),
  copyPath: (path) => ipcRenderer.invoke('files:copy-path', { path }),
  copyRelativePath: (root, path) => ipcRenderer.invoke('files:copy-relative-path', { root, path }),
  reveal: (path) => ipcRenderer.invoke('files:reveal', { path })
}

const gitApi = {
  status: (cwd) => ipcRenderer.invoke('git:status', { cwd }),
  summary: (cwd) => ipcRenderer.invoke('git:summary', { cwd }),
  file: (cwd, filePath) => ipcRenderer.invoke('git:file', { cwd, filePath }),
  refs: (cwd) => ipcRenderer.invoke('git:refs', { cwd }),
  checkout: (cwd, ref) => ipcRenderer.invoke('git:checkout', { cwd, ref }),
  createBranch: (cwd, name, startRef = null) =>
    ipcRenderer.invoke('git:create-branch', { cwd, name, startRef })
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

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

const chatApi = {
  start: (payload) => ipcRenderer.invoke('chat:start', payload),
  abort: (id) => ipcRenderer.invoke('chat:abort', { id }),
  recallQueued: (id, clientMessageId) =>
    ipcRenderer.invoke('chat:recall-queued', { id, clientMessageId }),
  history: (sessionId) => ipcRenderer.invoke('chat:history', { sessionId }),
  meta: (sessionId, cwd) => ipcRenderer.invoke('chat:meta', { sessionId, cwd }),
  models: () => ipcRenderer.invoke('chat:models'),
  roles: () => ipcRenderer.invoke('chat:roles'),
  compact: (sessionId, mode = 'model') => ipcRenderer.invoke('chat:compact', { sessionId, mode }),
  checkCwd: (cwd) => ipcRenderer.invoke('chat:check-cwd', { cwd }),
  updateCwd: (sessionId, cwd) => ipcRenderer.invoke('chat:update-cwd', { sessionId, cwd }),
  fork: (sessionId) => ipcRenderer.invoke('chat:fork', { sessionId }),
  savePastedImage: () => ipcRenderer.invoke('chat:save-pasted-image'),
  dispose: (id) => ipcRenderer.invoke('chat:dispose', { id }),
  isRunning: (id) => ipcRenderer.invoke('chat:is-running', { id }),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('chat:event', listener)
    return () => ipcRenderer.removeListener('chat:event', listener)
  },
  onExit: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('chat:exit', listener)
    return () => ipcRenderer.removeListener('chat:exit', listener)
  },
  onQueueState: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('chat:queue-state', listener)
    return () => ipcRenderer.removeListener('chat:queue-state', listener)
  },
  onQueueError: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('chat:queue-error', listener)
    return () => ipcRenderer.removeListener('chat:queue-error', listener)
  },
  commit: (payload) => ipcRenderer.invoke('chat:commit', payload),
  onCommitEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('chat:commit-event', listener)
    return () => ipcRenderer.removeListener('chat:commit-event', listener)
  },
  onCommitExit: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('chat:commit-exit', listener)
    return () => ipcRenderer.removeListener('chat:commit-exit', listener)
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
  reveal: (path) => ipcRenderer.invoke('files:reveal', { path }),
  orderGet: () => ipcRenderer.invoke('files:order-get'),
  orderSet: (directory, names) => ipcRenderer.invoke('files:order-set', { directory, names })
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

const statsApi = {
  read: () => ipcRenderer.invoke('stats:read'),
  sessionDetail: (sessionId) => ipcRenderer.invoke('stats:session-detail', { sessionId }),
  listSessions: () => ipcRenderer.invoke('stats:list-sessions'),
  sessionTitle: (sessionId) => ipcRenderer.invoke('stats:session-title', { sessionId }),
  renameSession: (sessionId, title) =>
    ipcRenderer.invoke('stats:rename-session', { sessionId, title }),
  listPins: () => ipcRenderer.invoke('stats:list-pins'),
  setPin: (sessionId, pinned) => ipcRenderer.invoke('stats:set-pin', { sessionId, pinned }),
  listSort: () => ipcRenderer.invoke('stats:list-sort'),
  setSort: (section, ids) => ipcRenderer.invoke('stats:set-sort', { section, ids })
}

const settingsApi = {
  open: () => ipcRenderer.invoke('settings:open')
}

contextBridge.exposeInMainWorld('mica', {
  terminal: terminalApi,
  chat: chatApi,
  workspace: workspaceApi,
  notify: notifyApi,
  app: appApi,
  files: filesApi,
  git: gitApi,
  stats: statsApi,
  settings: settingsApi,
  platform: process.platform,
  homeDir: process.env.HOME || '',
  windowsBuildNumber:
    process.platform === 'win32' ? Number.parseInt(os.release().split('.')[2], 10) || null : null
})

/**
 * 页面的 `window.mica` 实现：调用走 `POST /api/invoke`，推送走 `GET /api/events` 的
 * SSE。运行时可被浏览器直接访问（局域网 http 部署），Electron 容器装载的也是同一个
 * 地址，因此两种运行方式共用这一条通道，业务组件不需要感知运行环境。
 *
 * 少数调用按「页面所在的机器 ≠ 运行时所在的机器」降级：
 * - 剪贴板 / 打开外链由浏览器自己做（运行时拿不到用户的剪贴板，也打不开用户的浏览器）
 * - 窗口聚焦/可见状态由 `document.visibilityState` + focus/blur 推导
 * - 系统文件夹选择器换成应用内目录选择器（见 App.jsx 的 CwdModal）
 * - 配置页 iframe 的 127.0.0.1 重写成服务端地址
 */

const EVENT_CHANNELS = [
  'terminal:data',
  'terminal:exit',
  'chat:event',
  'chat:exit',
  'chat:queue-state',
  'chat:queue-error',
  'chat:commit-exit',
  'notify:changed',
  'app:window-state'
]

const listeners = new Map()

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(callback)
  return () => set.delete(callback)
}

function emit(channel, payload) {
  const set = listeners.get(channel)
  if (!set) return
  for (const callback of [...set]) {
    try {
      callback(payload)
    } catch (error) {
      console.error(`[mica] ${channel} listener failed`, error)
    }
  }
}

async function invoke(channel, payload) {
  const response = await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, payload })
  })
  if (!response.ok) throw new Error(`请求失败 (HTTP ${response.status})`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(body?.error || `调用 ${channel} 失败`)
  return body.result
}

/** `navigator.clipboard` 只在 https / localhost 下可用，局域网 http 访问时回退到 execCommand */
export async function copyText(text) {
  const value = String(text ?? '')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 落到 execCommand 兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

function connectEvents() {
  let source = null
  let reconnectTimer = null

  const open = () => {
    source = new EventSource('/api/events')
    source.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data)
        if (frame?.channel) emit(frame.channel, frame.payload)
      } catch {
        // 心跳等非 JSON 帧忽略
      }
    }
    source.onerror = () => {
      // EventSource 自带重连，但连接彻底关闭（服务端重启）时需要重建
      if (source && source.readyState === EventSource.CLOSED) {
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(open, 1500)
      }
    }
  }

  open()
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function createWebApi(env) {
  const appState = { focused: typeof document === 'undefined' || !document.hidden, visible: true }

  const publishWindowState = () => {
    appState.visible = typeof document === 'undefined' || !document.hidden
    emit('app:window-state', { focused: appState.focused, visible: appState.visible })
  }

  if (typeof window !== 'undefined') {
    document.addEventListener('visibilitychange', publishWindowState)
    window.addEventListener('focus', () => {
      appState.focused = true
      publishWindowState()
    })
    window.addEventListener('blur', () => {
      appState.focused = false
      publishWindowState()
    })
  }

  connectEvents()

  return {
    isWeb: true,
    platform: env.platform,
    homeDir: env.homeDir,
    runShellLogConfig: env.runShellLogConfig,
    windowsBuildNumber: env.windowsBuildNumber,

    terminal: {
      create: (payload) => invoke('terminal:create', payload),
      write: (id, data) => invoke('terminal:write', { id, data }),
      resize: (id, cols, rows) => invoke('terminal:resize', { id, cols, rows }),
      clear: (id) => invoke('terminal:clear', { id }),
      getCwd: (id) => invoke('terminal:get-cwd', { id }),
      resolveFileLinks: (id, paths) => invoke('terminal:resolve-file-links', { id, paths }),
      // 浏览器自己打开链接；服务端只负责把文件交给它所在机器上的 VS Code
      openExternal: async (url) => {
        if (typeof url !== 'string' || !/^https?:/i.test(url)) throw new Error('Invalid URL')
        window.open(url, '_blank', 'noopener,noreferrer')
        return true
      },
      openFile: async (id, path, line, column) => {
        // 终端里的文件链接在网页端直接开在右侧编辑器里（Electron 走本机 VS Code）
        window.dispatchEvent(
          new CustomEvent('mica:open-file', { detail: { path, line, column, terminalId: id } })
        )
        return true
      },
      dispose: (id) => invoke('terminal:dispose', { id }),
      disposeAll: () => invoke('terminal:dispose-all'),
      onData: (callback) => subscribe('terminal:data', callback),
      onExit: (callback) => subscribe('terminal:exit', callback)
    },

    chat: {
      start: (payload) => invoke('chat:start', payload),
      abort: (id) => invoke('chat:abort', { id }),
      recallQueued: (id, clientMessageId) => invoke('chat:recall-queued', { id, clientMessageId }),
      history: (sessionId) => invoke('chat:history', { sessionId }),
      inputHistory: {
        read: () => invoke('chat:input-history:read'),
        append: (text) => invoke('chat:input-history:append', { text })
      },
      meta: (sessionId, cwd) => invoke('chat:meta', { sessionId, cwd }),
      models: () => invoke('chat:models'),
      roles: () => invoke('chat:roles'),
      compact: (sessionId, mode = 'model') => invoke('chat:compact', { sessionId, mode }),
      checkCwd: (cwd) => invoke('chat:check-cwd', { cwd }),
      updateCwd: (sessionId, cwd) => invoke('chat:update-cwd', { sessionId, cwd }),
      fork: (sessionId) => invoke('chat:fork', { sessionId }),
      // 浏览器里图片来自粘贴事件（服务端读不到用户的剪贴板），bytes 由页面自己读
      savePastedImage: async ({ file, dataUrl } = {}) => {
        const payload = dataUrl || (file ? await readFileAsDataUrl(file) : '')
        if (!payload) return { ok: false }
        const response = await fetch('/api/paste-image', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dataUrl: payload })
        })
        return response.json()
      },
      dispose: (id) => invoke('chat:dispose', { id }),
      isRunning: (id) => invoke('chat:is-running', { id }),
      onEvent: (callback) => subscribe('chat:event', callback),
      onExit: (callback) => subscribe('chat:exit', callback),
      onQueueState: (callback) => subscribe('chat:queue-state', callback),
      onQueueError: (callback) => subscribe('chat:queue-error', callback),
      commit: (payload) => invoke('chat:commit', payload),
      onCommitExit: (callback) => subscribe('chat:commit-exit', callback)
    },

    workspace: {
      get: () => invoke('workspace:get'),
      save: (workspace) => invoke('workspace:save', workspace),
      // 服务端没有原生选择器；网页端改用应用内目录选择器（App.jsx 的 CwdModal）
      selectDirectory: async () => ({ canceled: true })
    },

    notify: {
      list: () => invoke('notify:list'),
      markRead: (id) => invoke('notify:mark-read', { id }),
      onChanged: (callback) => subscribe('notify:changed', callback)
    },

    app: {
      getWindowState: async () => ({ ...appState }),
      onWindowState: (callback) => subscribe('app:window-state', callback)
    },

    files: {
      list: (path) => invoke('files:list', { path }),
      read: (path) => invoke('files:read', { path }),
      write: (path, content, expectedVersion) =>
        invoke('files:write', { path, content, expectedVersion }),
      find: (root, query) => invoke('files:find', { root, query }),
      search: (root, query) => invoke('files:search', { root, query }),
      create: (directory, name, type) => invoke('files:create', { directory, name, type }),
      rename: (path, name) => invoke('files:rename', { path, name }),
      move: (path, directory) => invoke('files:move', { path, directory }),
      duplicate: (path) => invoke('files:duplicate', { path }),
      delete: (path) => invoke('files:delete', { path }),
      // 复制到剪贴板必须发生在用户机器上，服务端只能返回目标文本
      copyPath: async (path) => {
        await copyText(path)
        return true
      },
      copyRelativePath: async (root, path) => {
        const relative = await invoke('files:copy-relative-path', { root, path })
        await copyText(relative)
        return relative
      },
      reveal: (path) => invoke('files:reveal', { path }),
      orderGet: () => invoke('files:order-get'),
      orderSet: (directory, names) => invoke('files:order-set', { directory, names })
    },

    git: {
      status: (cwd) => invoke('git:status', { cwd }),
      summary: (cwd) => invoke('git:summary', { cwd }),
      file: (cwd, filePath) => invoke('git:file', { cwd, filePath }),
      refs: (cwd) => invoke('git:refs', { cwd }),
      checkout: (cwd, ref) => invoke('git:checkout', { cwd, ref }),
      createBranch: (cwd, name, startRef = null) =>
        invoke('git:create-branch', { cwd, name, startRef })
    },

    stats: {
      read: () => invoke('stats:read'),
      sessionDetail: (sessionId) => invoke('stats:session-detail', { sessionId }),
      listSessions: () => invoke('stats:list-sessions'),
      sessionTitle: (sessionId) => invoke('stats:session-title', { sessionId }),
      renameSession: (sessionId, title) => invoke('stats:rename-session', { sessionId, title }),
      listPins: () => invoke('stats:list-pins'),
      setPin: (sessionId, pinned) => invoke('stats:set-pin', { sessionId, pinned }),
      listSort: () => invoke('stats:list-sort'),
      setSort: (section, ids) => invoke('stats:set-sort', { section, ids })
    },

    settings: {
      // 配置页由服务端所在机器拉起；iframe 必须指向服务端地址而不是 127.0.0.1
      open: async () => {
        const info = await invoke('settings:open')
        if (!info?.url) return info
        try {
          const url = new URL(info.url)
          url.hostname = window.location.hostname
          return { ...info, url: url.toString().replace(/\/$/, '') }
        } catch {
          return info
        }
      }
    }
  }
}

/**
 * 确保 `window.mica` 可用：先取回运行时环境信息（platform / homeDir 等）再安装。
 * 取不到（运行时没起来）时抛出，由 main.jsx 渲染可读的失败提示。
 */
export async function ensureMicaApi() {
  if (typeof window === 'undefined') return null
  if (window.mica) return window.mica

  const response = await fetch('/api/env', { cache: 'no-store' })
  if (!response.ok) throw new Error('无法连接 Mica Code 服务端')
  const env = await response.json()

  window.mica = createWebApi(env)
  return window.mica
}

export { EVENT_CHANNELS }

/**
 * 页面的 `window.mica` 实现：调用走 `POST /api/invoke`，推送走 `GET /api/events` 的
 * SSE。运行时可被浏览器直接访问（局域网 http 部署），Electron 容器装载的也是同一个
 * 地址，因此两种运行方式共用这一条通道，业务组件不需要感知运行环境。
 *
 * 少数调用按「页面所在的机器 ≠ 运行时所在的机器」降级：
 * - 剪贴板 / 打开外链由浏览器自己做（运行时拿不到用户的剪贴板，也打不开用户的浏览器）
 * - 窗口聚焦/可见状态由 `document.visibilityState` + focus/blur 推导
 * - 系统文件夹选择器换成应用内目录选择器（见 App.jsx 的 CwdModal）
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
  'ui-state:changed',
  'schedule:changed',
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
      // 改写一条已发送的用户消息并重跑（Codex 协议扩展 mica/turn/editMessage）
      editMessage: (payload) => invoke('chat:edit-message', payload),
      // 终止一个后台 shell 任务 / 读取它的输出（Codex 协议扩展 mica/backgroundTasks/*）
      killBackgroundTask: (id, taskId, forceAfterMs) =>
        invoke('chat:kill-background-task', { id, taskId, forceAfterMs }),
      backgroundTaskOutput: (id, taskId, tailBytes) =>
        invoke('chat:background-task-output', { id, taskId, tailBytes }),
      // 读取 / 停止一个 subagent 任务（Codex 协议扩展 mica/subagentTasks/*）
      subagentDetail: (id, taskId) => invoke('chat:subagent-detail', { id, taskId }),
      killSubagent: (id, taskId) => invoke('chat:kill-subagent', { id, taskId }),
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
      isRunning: (id, sessionId) => invoke('chat:is-running', { id, sessionId }),
      onEvent: (callback) => subscribe('chat:event', callback),
      onExit: (callback) => subscribe('chat:exit', callback),
      onQueueState: (callback) => subscribe('chat:queue-state', callback),
      onQueueError: (callback) => subscribe('chat:queue-error', callback),
      commit: (payload) => invoke('chat:commit', payload),
      onCommitExit: (callback) => subscribe('chat:commit-exit', callback)
    },

    workspace: {
      // 服务端没有原生选择器；网页端改用应用内目录选择器（App.jsx 的 CwdModal）
      selectDirectory: async () => ({ canceled: true })
    },

    // 界面状态的唯一事实来源在运行时（草稿 / 工作区 / 面板布局），页面返回的就是
    // 所有窗口共享的那一份；`ui-state:changed` 会把变更推给每一个已连接页面。
    uiState: {
      get: () => invoke('ui-state:get'),
      patch: (patch) => invoke('ui-state:patch', patch),
      onChanged: (callback) => subscribe('ui-state:changed', callback)
    },

    notify: {
      list: () => invoke('notify:list'),
      markRead: (id) => invoke('notify:mark-read', { id }),
      onChanged: (callback) => subscribe('notify:changed', callback)
    },

    // 定时任务（每隔 N 分钟往某个会话发一次消息）：任务本身活在运行时里，页面只是
    // 读写视图，变更经 `schedule:changed` 广播给所有窗口。
    schedule: {
      list: () => invoke('schedule:list'),
      create: (payload) => invoke('schedule:create', payload),
      update: (id, patch) => invoke('schedule:update', { id, patch }),
      remove: (id) => invoke('schedule:delete', { id }),
      runNow: (id) => invoke('schedule:run-now', { id }),
      onChanged: (callback) => subscribe('schedule:changed', callback)
    },

    app: {
      getWindowState: async () => ({ ...appState }),
      onWindowState: (callback) => subscribe('app:window-state', callback),
      // 「切换 Mica 服务器」：目标探活由运行时代查（页面跨源 fetch 受 CORS 限制读不到
      // 结果）；打开新窗口/新标签页由页面自己做，见 renderer 的 servers.js
      servers: {
        probe: (url) => invoke('app:servers:probe', { url })
      }
    },

    files: {
      list: (path) => invoke('files:list', { path }),
      read: (path) => invoke('files:read', { path }),
      write: (path, content, expectedVersion) =>
        invoke('files:write', { path, content, expectedVersion }),
      // `@` 补全候选：与 CLI 的 file-mention 插件共用 mica-file-mentions
      mention: (root, query) => invoke('files:mention', { root, query }),
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
      // 聊天里点路径的默认动作：目录用 Finder 打开，文件在文件管理器里定位
      openPath: (path) => invoke('files:open-path', { path }),
      orderGet: () => invoke('files:order-get'),
      orderSet: (directory, names) => invoke('files:order-set', { directory, names })
    },

    skills: {
      // 输入框 `/` 的 skill 候选：按会话所在目录现扫（项目级 + 用户级）
      list: (cwd) => invoke('skills:list', { cwd })
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
      deleteSession: (sessionId) => invoke('stats:delete-session', { sessionId }),
      listPins: () => invoke('stats:list-pins'),
      listSort: () => invoke('stats:list-sort'),
      setSort: (section, ids) => invoke('stats:set-sort', { section, ids }),
      listProjects: () => invoke('stats:list-projects'),
      createProjectGroup: (name, parentId = null) =>
        invoke('stats:create-project-group', { name, parentId }),
      renameProjectGroup: (groupId, name) =>
        invoke('stats:rename-project-group', { groupId, name }),
      moveProjectGroup: (groupId, parentId = null) =>
        invoke('stats:move-project-group', { groupId, parentId }),
      deleteProjectGroup: (groupId) => invoke('stats:delete-project-group', { groupId }),
      // 侧栏唯一的「换位置」入口：pinned / project / recent 三选一
      moveSession: (sessionId, section, groupId = null) =>
        invoke('stats:move-session', { sessionId, section, groupId })
    },

    configWeb: {
      // 配置页的数据面：动作名 + 参数交给运行时（见 src/host/configWeb.js），
      // 页面组件在 SettingsView 里直接渲染，不经 iframe
      invoke: (action, input) => invoke('config-web:invoke', { action, input })
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

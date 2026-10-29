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

import { isSharePath } from '@packages/mica-web-shared'

const EVENT_CHANNELS = [
  'terminal:data',
  'terminal:exit',
  'chat:event',
  'chat:exit',
  'chat:queue-state',
  'chat:queue-error',
  'chat:run-started',
  'chat:commit-exit',
  'notify:changed',
  'ui-state:changed',
  'loops:changed',
  'browser:changed',
  'terminal:changed',
  'app:window-state'
]

/** 请求被服务端拒掉（Host/Origin 校验不过）。main.jsx 据此渲染可读的提示页。 */
export class AccessDeniedError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message)
    this.name = 'AccessDeniedError'
    this.status = status
  }
}

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
  if (response.status === 401) throw new AccessDeniedError('服务端拒绝了这次请求', { status: 401 })
  if (response.status === 403)
    throw new AccessDeniedError('跨源请求被拒绝（请用运行时打印的地址打开页面）', { status: 403 })
  if (!response.ok) throw new Error(`请求失败 (HTTP ${response.status})`)
  const body = await response.json()
  if (!body || body.ok !== true) {
    const message = body?.error || `调用 ${channel} 失败`
    throw new Error(message)
  }
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
    // 页面是在 `/share` 下打开的：不画左侧会话列表，根路径是分享链接列表（见 main.jsx
    // 与 App.jsx 的 shareView 分支）。这只是呈现，不是权限。判断只有一份——路径约定在
    // @packages/mica-web-shared 的 app-paths 里，与运行时路由同源。
    shareView: isSharePath(window.location.pathname),
    sharePath: env.sharePath,
    shareEnabled: env.shareEnabled !== false,
    platform: env.platform,
    homeDir: env.homeDir,
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
      // 冻结排队消息（撤回往返窗口内不让迭代边界注入），`held: false` 释放
      holdQueued: (id, clientMessageId, held = true) =>
        invoke('chat:hold-queued', { id, clientMessageId, held }),
      // 改写一条已发送的用户消息并重跑（Codex 协议扩展 mica/turn/editMessage）
      editMessage: (payload) => invoke('chat:edit-message', payload),
      // 用户正在输入框里敲字（扩展 mica/input/activity）：让插件知道「这个人回来了」，
      // 会话空闲够久时它可以先把历史压小。渲染层已节流，收不到回包也不影响界面。
      inputActivity: (id) => invoke('chat:input-activity', { id }),
      // 终止一个后台 shell 任务 / 读取它的输出（Codex 协议扩展 mica/backgroundTasks/*）
      killBackgroundTask: (id, taskId, forceAfterMs) =>
        invoke('chat:kill-background-task', { id, taskId, forceAfterMs }),
      backgroundTaskOutput: (id, taskId, tailBytes) =>
        invoke('chat:background-task-output', { id, taskId, tailBytes }),
      // 读取 / 停止一个 subagent 任务（Codex 协议扩展 mica/subagentTasks/*）
      subagentDetail: (id, taskId) => invoke('chat:subagent-detail', { id, taskId }),
      killSubagent: (id, taskId) => invoke('chat:kill-subagent', { id, taskId }),
      // By The Way（CLI 的 `/btw`，扩展 mica/btw/ask）：只收下问题，回答随后作为
      // `btw_thread` 快照事件到达（mica/btw/updated）。所以它可以在 turn 运行中调用。
      // sessionId/cwd 让 host 在没有常驻进程时按需起一个（resume 这条会话）。
      btwAsk: (id, question, options = {}) =>
        invoke('chat:btw-ask', {
          id,
          question: question || '',
          threadId: options.threadId || null,
          queue: options.queue === true,
          sessionId: options.sessionId || null,
          cwd: options.cwd || null
        }),
      // 抽屉的 tab 条 / 重开页面后的恢复：线程活在 host 里，只有它知道有哪些。
      btwThreads: (id, sessionId) =>
        invoke('chat:btw-threads', { id, sessionId: sessionId || null }),
      btwClose: (id, threadId) => invoke('chat:btw-close', { id, threadId }),
      // 停止正在回答的那一问 / 撤回排队中的问题：纯命令，不启动 turn。
      btwInterrupt: (id, threadId, { sessionId, cwd } = {}) =>
        invoke('chat:btw-interrupt', { id, threadId, sessionId, cwd }),
      btwRecall: (id, threadId, { sessionId, cwd } = {}) =>
        invoke('chat:btw-recall', { id, threadId, sessionId, cwd }),
      // By The Way 的本地快速压缩（与主对话的「快速压缩」同源）。
      btwCompact: (id, threadId, { sessionId, cwd } = {}) =>
        invoke('chat:btw-compact', { id, threadId, sessionId, cwd }),
      history: (sessionId) => invoke('chat:history', { sessionId }),
      inputHistory: {
        read: () => invoke('chat:input-history:read'),
        append: (text) => invoke('chat:input-history:append', { text })
      },
      meta: (sessionId, cwd) => invoke('chat:meta', { sessionId, cwd }),
      models: () => invoke('chat:models'),
      roles: () => invoke('chat:roles'),
      // 会话级能力（skills / tools / MCP servers）：读取目录与开关、提交选择。
      // 选择落在会话快照里，同一会话的其他窗口通过 onCapabilitiesUpdated 同步。
      capabilities: (id, { sessionId, cwd } = {}) =>
        invoke('chat:capabilities', { id, sessionId: sessionId || null, cwd: cwd || null }),
      pluginSettings: (id, { sessionId, cwd } = {}) =>
        invoke('chat:plugin-settings', { id, sessionId: sessionId || null, cwd: cwd || null }),
      // 对话右侧的插件面板（清单 `desktop.panel`）：视图与动作都由插件给，宿主只转发。
      // 走 chat 是因为插件活在会话的常驻 host 里——面板要有状态，就得在同一个进程。
      pluginPanels: {
        view: (id, { pluginId, sessionId, cwd } = {}) =>
          invoke('chat:plugin-panel-view', {
            id,
            pluginId,
            sessionId: sessionId || null,
            cwd: cwd || null
          }),
        action: (id, { pluginId, action, key, values, sessionId, cwd } = {}) =>
          invoke('chat:plugin-panel-action', {
            id,
            pluginId,
            action,
            ...(key ? { key } : {}),
            ...(values ? { values } : {}),
            sessionId: sessionId || null,
            cwd: cwd || null
          })
      },
      // 会话右键菜单里的插件动作（清单 `desktop.sessionMenu`）：结果里的 `copyText`
      // 由页面写进剪贴板，插件进程不碰剪贴板。
      // `id` 是这条会话已经打开的页签（有就复用它的常驻 host）；不传时由运行时自己找
      // 一条在服务这个会话的 host，找不到再按需起一个。
      sessionMenuRun: ({ id, pluginId, action, sessionId, cwd } = {}) =>
        invoke('chat:session-menu-run', {
          id: id || null,
          pluginId,
          action,
          sessionId: sessionId || null,
          cwd: cwd || null
        }),
      setPluginSettings: (id, { sessionId, cwd, pluginId, values } = {}) =>
        invoke('chat:set-plugin-settings', {
          id,
          sessionId: sessionId || null,
          cwd: cwd || null,
          pluginId,
          values
        }),
      setCapabilities: (id, selection, { sessionId, cwd } = {}) =>
        invoke('chat:set-capabilities', {
          id,
          selection,
          sessionId: sessionId || null,
          cwd: cwd || null
        }),
      onCapabilitiesUpdated: (callback) => subscribe('chat:capabilities-updated', callback),
      // 会话笔记（用户与模型共同维护的 markdown）。存在会话快照里，压缩不动它。
      notes: (id, { sessionId, cwd } = {}) =>
        invoke('chat:notes', { id, sessionId: sessionId || null, cwd: cwd || null }),
      setNotes: (id, content, { sessionId, cwd } = {}) =>
        invoke('chat:set-notes', {
          id,
          content,
          sessionId: sessionId || null,
          cwd: cwd || null
        }),
      onNotesUpdated: (callback) => subscribe('chat:notes-updated', callback),
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
      // host 主动发起的一轮（定时任务等）的起始信息：渲染层据此补上用户气泡
      onRunStarted: (callback) => subscribe('chat:run-started', callback),
      commit: (payload) => invoke('chat:commit', payload),
      onCommitExit: (callback) => subscribe('chat:commit-exit', callback),
      // Rename goes through the chat host so a running turn's own save keeps the
      // title (it persists the host's in-memory title, not the file we read).
      renameSession: (sessionId, title) => invoke('chat:rename-session', { sessionId, title })
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

    // 定时循环任务（CLI `/loop` 的桌面端等价物，每隔 N 分钟把同一段任务重发一次）：
    // 循环本身活在运行时里、按 nodeId 归属，页面只是读写视图，变更经 `loops:changed`
    // 广播给所有窗口。`start` 会立刻跑第一轮（与 CLI「启动即执行第一次」一致）。
    loops: {
      list: () => invoke('loops:list'),
      start: (payload) => invoke('loops:start', payload),
      stop: (nodeId) => invoke('loops:stop', { nodeId }),
      setStatus: (nodeId, status) => invoke('loops:set-status', { nodeId, status }),
      setInterval: (nodeId, intervalMs) => invoke('loops:set-interval', { nodeId, intervalMs }),
      setTask: (nodeId, task) => invoke('loops:set-task', { nodeId, task }),
      fireNow: (nodeId) => invoke('loops:fire-now', { nodeId }),
      onChanged: (callback) => subscribe('loops:changed', callback)
    },

    app: {
      getWindowState: async () => ({ ...appState }),
      onWindowState: (callback) => subscribe('app:window-state', callback)
    },

    // 插件的前端模块（`plugins/<id>/desktop.jsx`）能用到的宿主能力，见 renderer 的
    // plugin-host.js。宿主不认识任何具体插件：探活一个地址（页面跨源 fetch 读不到结果）、
    // 读写插件自己的数据文件（页面没有文件系统）、执行一个清单里声明过的动作（页面跑不了
    // 插件自己的代码）。
    pluginHost: {
      probe: (address) => invoke('plugin-host:probe', { address }),
      readData: (pluginId) => invoke('plugin-host:read-data', { pluginId }),
      writeData: (pluginId, value) => invoke('plugin-host:write-data', { pluginId, value }),
      runAction: (pluginId, action) => invoke('plugin-host:run-action', { pluginId, action }),
      // 运行时的远程访问策略（要不要口令、口令是什么、别人从哪个地址进来）
      access: () => invoke('plugin-host:access-get'),
      setAccess: (patch) => invoke('plugin-host:access-set', patch ?? {})
    },

    // 粘贴文件时把系统剪贴板里的路径交回页面：页面只有文件名（Chromium 不暴露路径），
    // 路径由运行时读同一台机器的剪贴板（见 host/clipboard-files.js）
    clipboard: {
      filePaths: (names) => invoke('clipboard:file-paths', { names })
    },

    files: {
      list: (path) => invoke('files:list', { path }),
      read: (path) => invoke('files:read', { path }),
      // 路径点击要先知道目标是文件还是目录（页面侧没有文件系统）
      stat: (path) => invoke('files:stat', { path }),
      write: (path, content, expectedVersion) =>
        invoke('files:write', { path, content, expectedVersion }),
      // `@` 补全候选：与 CLI 的 file-mention 插件共用 mica-file-mentions
      mention: (root, query) => invoke('files:mention', { root, query }),
      // 「快速打开」（Ctrl+P）：同一份扫描，按名称找工作区文件
      find: (root, query) => invoke('files:find', { root, query }),
      // options：{ matchCase, wholeWord, regex, include, exclude }，对应搜索面板上的开关
      search: (root, query, options = {}) => invoke('files:search', { root, query, ...options }),
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

    mcp: {
      // 同一个 `/` 浮层里的 MCP server 候选（只读 config.json，不发起连接）
      listCandidates: () => invoke('mcp:candidates')
    },

    git: {
      status: (cwd) => invoke('git:status', { cwd }),
      summary: (cwd) => invoke('git:summary', { cwd }),
      // 当前工作区相对比较基线的变更：GIT TREE 面板用它。不传 base 时自动挑基线
      // （origin/HEAD → master/main），`direct` 表示与基线直接比（默认取 merge-base）。
      branchSummary: (cwd, options = null) =>
        invoke('git:branch-summary', { cwd, ...(options || {}) }),
      // snapshot + summary.compareRef pins the original commit; staged is HEAD → index,
      // worktree is index → disk. Legacy head/branch/ref modes are also supported.
      file: (cwd, filePath, base = null) => invoke('git:file', { cwd, filePath, base }),
      refs: (cwd) => invoke('git:refs', { cwd }),
      resolveRef: (cwd, ref) => invoke('git:resolve-ref', { cwd, ref }),
      checkout: (cwd, ref) => invoke('git:checkout', { cwd, ref }),
      createBranch: (cwd, name, startRef = null) =>
        invoke('git:create-branch', { cwd, name, startRef }),
      // 源代码管理面板行内悬浮出来的三个操作；discard 不可逆，调用方要先确认。
      stage: (cwd, filePath) => invoke('git:stage', { cwd, filePath }),
      unstage: (cwd, filePath) => invoke('git:unstage', { cwd, filePath }),
      discard: (cwd, filePath) => invoke('git:discard', { cwd, filePath })
    },

    stats: {
      read: () => invoke('stats:read'),
      sessionDetail: (sessionId) => invoke('stats:session-detail', { sessionId }),
      listSessions: () => invoke('stats:list-sessions'),
      // 会话行上的插件标记（标签色点等）：宿主不认识具体插件，只转交这份通用结构。
      listAnnotations: () => invoke('stats:list-annotations'),
      setAnnotation: ({ pluginId, sessionId, optionId, on }) =>
        invoke('stats:set-annotation', { pluginId, sessionId, optionId, on }),
      // 会话内容搜索：只在渲染层已经拿到的元数据之外的部分（对话正文）走这一趟，
      // 时间范围把要读的会话限制在最近若干天（见 host/stats.js 的 searchSessions）。
      searchSessions: (query, sinceMs = 0) => invoke('stats:search-sessions', { query, sinceMs }),
      sessionTitle: (sessionId) => invoke('stats:session-title', { sessionId }),
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
    },

    browserControl: {
      // 受控浏览器（Electron 主进程里的窗口）在页面上的把手：够图标渲染与开关窗口用，
      // 真正的操作面是给 agent 用的 HTTP 接口，见 src/main/browser/browser-docs.js
      list: () => invoke('browser-control:list'),
      show: (id, focus = true) => invoke('browser-control:show', { id, focus }),
      hide: (id) => invoke('browser-control:hide', { id }),
      close: (id) => invoke('browser-control:close', { id }),
      create: (input = {}) => invoke('browser-control:create', input),
      onChanged: (callback) => subscribe('browser:changed', callback)
    },

    terminalControl: {
      // 终端控制同理：主进程里是真的 PTY + 后台窗口，页面只负责开关窗口。
      // agent 的操作面是运行时上的 /remote/terminal，见 src/main/terminal/terminal-docs.js
      list: () => invoke('terminal-control:list'),
      show: (id, focus = true) => invoke('terminal-control:show', { id, focus }),
      hide: (id) => invoke('terminal-control:hide', { id }),
      close: (id) => invoke('terminal-control:close', { id }),
      create: (input = {}) => invoke('terminal-control:create', input),
      onChanged: (callback) => subscribe('terminal:changed', callback)
    },

    access: {
      // 本机可达地址（分享链接就落在同一个 origin 的 /share 下），用来拼分享链接
      info: () => invoke('access:info')
    },

    share: {
      // 分享链接列表：运行时记着「哪些会话被分享过」，/share 那个页面展示它
      list: () => invoke('share:list'),
      add: (sessionId) => invoke('share:add', { sessionId }),
      remove: (sessionId) => invoke('share:remove', { sessionId })
    }
  }
}

/**
 * 确保 `window.mica` 可用：取回运行时环境信息（platform / homeDir）后安装。
 * 取不到（运行时没起来）时抛出，由 main.jsx 渲染可读的失败提示。
 */
export async function ensureMicaApi() {
  if (typeof window === 'undefined') return null
  if (window.mica) return window.mica

  const response = await fetch('/api/env', { cache: 'no-store' })
  if (response.status === 403)
    throw new AccessDeniedError('跨源请求被拒绝（请用运行时打印的地址打开页面）', { status: 403 })
  if (!response.ok) throw new Error('无法连接 Mica Code 服务端')
  const env = await response.json()

  window.mica = createWebApi(env)
  return window.mica
}

export { EVENT_CHANNELS }

import { isElectronShell } from './shell-env'
import { createClientContextApi } from './client-context'

/**
 * 插件的前端模块能用的宿主能力。
 *
 * 插件卡片跑在页面里，但它需要的东西有一半在运行时那边：探活某个地址、读写自己的数据
 * 文件（页面没有文件系统）。这份 API 就是那层封口——插件只认它，不认 `window.mica`，
 * 宿主换实现时插件不用改。
 *
 * `open` 反过来是纯页面能力：打开另一个运行时就是一次 `location.assign`，外壳接管它
 * 并让当前窗口加载那个地址（见 src/main/index.js 的 will-navigate），浏览器里开新标签页。
 *
 * `action` 是「卡片要真的干一件事」：刷新一批数据、试连一次接口。页面里没有插件自己的
 * 代码，所以只能按清单里声明过的 key 请宿主去跑——执行它的是 `mica plugin-action`，
 * 与配置页点按钮同一条路，同样不需要打开会话。
 */

/** 当前页面所在的运行时：页面就是它托管的，所以 origin 即地址。 */
export function currentRuntimeAddress() {
  return String(window.location?.origin || '')
}

/**
 * 打开另一个运行时的地址。
 *
 * 外壳里交给主进程：`location.assign` 触发的导航会被 `will-navigate` 接管，改成判定目标
 * 后让当前窗口加载它（一个窗口，切换＝重载）；不是 Mica 运行时的地址交回系统浏览器。
 * 浏览器里开新标签页，被弹窗拦截时退回本标签页。依赖可注入，便于单测。
 */
export function openRuntimeTarget(url, { userAgent, open, assign } = {}) {
  const agent = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const navigate = assign ?? ((target) => window.location.assign(target))

  if (isElectronShell(agent)) {
    navigate(url)
    return 'window'
  }

  const spawnTab = open ?? ((target) => window.open(target, '_blank'))
  const spawned = spawnTab(url)
  if (spawned) {
    // 不用 window.open 的 `noopener` 特性串：它会让 window.open 恒返回 null，弹窗被
    // 拦截时就分辨不出来、退路也没了；直接在拿到的窗口上掐掉 opener 等价。
    try {
      spawned.opener = null
    } catch {
      // 某些浏览器不让写，忽略
    }
    return 'tab'
  }
  navigate(url)
  return 'same-tab'
}

/**
 * 交给插件 `desktop.jsx` 的那份 api。`pluginId` 由宿主注入，插件不必自己拼——它也
 * 拼不对：配置与独立文档都落在 `$MICA_HOME/plugin-data/<id>/` 下。
 */
export function createPluginHostApi(pluginId, session = null) {
  const host = window.mica?.pluginHost
  const chat = window.mica?.chat
  const stats = window.mica?.stats
  const target = session ? { sessionId: session.sessionId || null, cwd: session.cwd || null } : null
  // chat 的键是工作区 nodeId，不一定等于 sessionId。保持双向归属以认领不带
  // sessionId 的 queue-error；不创建/改写工作区，也不启动额外的会话宿主。
  const nodeSessions = new Map()
  const sessionNodes = new Map()
  const rememberNode = (nodeId, sessionId) => {
    if (!nodeId || !sessionId) return
    const previous = nodeSessions.get(nodeId)
    if (previous && previous !== sessionId && sessionNodes.get(previous) === nodeId)
      sessionNodes.delete(previous)
    nodeSessions.set(nodeId, sessionId)
    sessionNodes.set(sessionId, nodeId)
  }
  const eventSession = (payload) => {
    const sessionId =
      payload?.sessionId ||
      payload?.event?.sessionID ||
      nodeSessions.get(payload?.id) ||
      payload?.id
    rememberNode(payload?.id, sessionId)
    return sessionId
  }
  const resolveNode = async (sessionId) => {
    // 独立插件页也读同一份工作区，刷新后尚未收到任何事件时仍能附着主界面的 run。
    const snapshot = await window.mica?.uiState?.get?.()
    const nodes = snapshot?.workspace?.nodes
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (node?.id && node?.sessionId) rememberNode(node.id, node.sessionId)
        else if (node?.id) {
          const previous = nodeSessions.get(node.id)
          if (sessionNodes.get(previous) === node.id) sessionNodes.delete(previous)
          nodeSessions.delete(node.id)
        }
      }
    }
    const nodeId =
      (Array.isArray(nodes) ? nodes.find((node) => node?.sessionId === sessionId)?.id : null) ||
      sessionNodes.get(sessionId) ||
      sessionId
    rememberNode(nodeId, sessionId)
    return nodeId
  }
  const sessionStatus = async (sessionId) => {
    if (!sessionId) return null
    const nodeId = await resolveNode(sessionId)
    const state = await chat.isRunning(nodeId, sessionId)
    if (typeof state?.running !== 'boolean') throw new Error('会话状态响应无效')
    return { ...state, nodeId, sessionId }
  }
  const documentOptions = (key, options) => {
    // undefined/function 等在 JSON 传输里会被丢掉，不能让文档请求意外落到 data.json。
    if (typeof key !== 'string' || !key) throw new Error('插件文档 key 必须是非空字符串')
    return options && Object.hasOwn(options, 'expectedVersion')
      ? { key, expectedVersion: options.expectedVersion }
      : { key }
  }
  const launcherControl = (action, path) => {
    if (isElectronShell(navigator.userAgent)) return host.launcherControl(pluginId, action, path)
    if (action === 'status') return Promise.resolve({ native: false, registered: false })
    const intent = action === 'openPath' ? { type: 'openPath', path }
      : action === 'configure' ? { type: 'configurePlugin', pluginId }
      : action === 'close' ? { type: 'closePluginPage' } : null
    if (intent && window.__micaDesktopAction?.(intent)) return Promise.resolve({ ok: true })
    return Promise.reject(new Error('系统快捷键和独立浮窗需要 Mica 桌面应用'))
  }
  return {
    pluginId,
    /** Optional local metadata; failures never block the user's operation. */
    experience: (event, fields = {}) => {
      try { void Promise.resolve(host?.experience?.(pluginId, event, fields)).catch(() => {}) } catch { /* optional observation */ }
    },
    launcher: {
      request: (action, input = {}) => host.launcherRequest(pluginId, action, input),
      status: () => launcherControl('status'),
      retry: () => launcherControl('retry'),
      show: () => launcherControl('show'),
      close: () => launcherControl('close'),
      configure: () => launcherControl('configure'),
      openPath: (path) => launcherControl('openPath', path)
    },
    currentHost: () => currentRuntimeAddress(),
    /** 完整页面入口保留中转机的机器身份；currentHost 仍只回答 origin。 */
    currentTarget: () => String(window.location?.href || currentRuntimeAddress()),
    /** 原生客户端拥有的插件数据、探活与窗口切换；浏览器里为 null。 */
    client: createClientContextApi(pluginId),
    /** 这个地址上是不是一台 Mica 运行时：跨源探测页面做不了，由运行时代查。 */
    probe: (address) => host.probe(String(address ?? '')),
    /** 插件自己的数据及内容版本。写入时可带 expectedVersion，冲突后重读并重放修改。 */
    readData: () => host.readData(pluginId),
    writeData: (value, options) => host.writeData(pluginId, value, options),
    /** 独立本地文档，共享版本 CAS 语义，不占用小配置 data.json 的额度。 */
    documents: {
      read: async (key) => host.readData(pluginId, documentOptions(key)),
      write: async (key, value, options) =>
        host.writeData(pluginId, value, documentOptions(key, options))
    },
    /**
     * 运行时的远程访问策略：别的机器要进这台机器时要不要口令、口令是什么、别人从哪个
     * 地址进来（`addresses`）。这是宿主自己的能力，不是插件的私有数据——请求分派用的是
     * 同一份，所以界面显示和实际生效不会分叉。
     */
    access: {
      get: () => host.access(),
      set: (patch) => host.setAccess(patch)
    },
    /** 打开另一个运行时：外壳里当前窗口加载它，浏览器里开新标签页。 */
    open: (url) => openRuntimeTarget(url),
    /**
     * 这个插件自己画在会话行上的标记（`session-annotations.json` 的 `options`）。
     *
     * 宿主不认识「标签」：它只知道某个插件声明了一组「id + 名字 + 颜色」，页面要维护这组
     * 东西（新增、改名、换色、删除）时整份写回来。`counts` 是每个项挂在多少个会话上，
     * 删之前得知道自己会摘掉多少。写回是整份替换，宿主管互斥与归一化，也会顺手把删掉的
     * 项从会话归属里摘掉。
     */
    annotations: {
      read: () => host.readAnnotations(pluginId),
      writeOptions: (options) => host.writeAnnotations(pluginId, options)
    },
    /**
     * 执行清单里声明过的一个动作（`plugin.json` 的 `actions[].key`）。
     *
     * 结果是 `{ ok, message?, link?, error? }`：失败不抛异常，卡片上一行红字比一个没人接
     * 的 rejected promise 有用。没声明的 key 会被拒绝——页面上本来就没有那个按钮。
     */
    action: (key) => host.runAction(pluginId, String(key ?? '')),
    /** Session-bound actions shared by panels and bundled composer controls. */
    panelAction: (action, values = {}) => {
      if (!session) return Promise.reject(new Error('请先打开一条会话'))
      return chat.pluginPanels.action(session.id, { pluginId, action, values, ...target })
    },
    /** Upload a browser File without inserting its path into the draft. */
    uploadAttachment: (file) => chat.saveAttachment({ file }),
    /**
     * 页面正在看的那条会话。内核不知道插件拿它做什么——这里只提供「会话级」的三件事：
     * 身份、插件自己的会话状态、以及这一轮什么时候跑完。
     */
    session:
      session && target && chat?.sessionState
        ? {
            id: () => session.id,
            sessionId: () => target.sessionId,
            cwd: () => target.cwd,
            /** 插件自己的会话状态（会话快照的 `pluginState[pluginId]`）。 */
            state: {
              read: () => chat.sessionState(session.id, pluginId, target),
              write: (value) => chat.setSessionState(session.id, pluginId, value ?? null, target),
              /** 别的窗口 / 面板改写了这份状态。 */
              subscribe: (callback) =>
                chat.onSessionStateUpdated((payload) => {
                  if (!payload || payload.id !== session.id) return
                  if (payload.pluginId && payload.pluginId !== pluginId) return
                  callback(payload.value)
                })
            },
            /** 这一轮跑完了：模型在轮次里写的东西该重读了。 */
            onIdle: (callback) => subscribeSessionIdle(callback)
          }
        : null,
    /**
     * 跨会话的对话面：插件页自己挑一条会话、读它的历史、往里发一条用户消息。
     *
     * 发出去的就是调用方给的那段正文——宿主不拼接、不追加插件自己的上下文，也不替
     * 用户决定提示词。这里只有「列会话 / 读历史 / 发一句话 / 跟一轮的流」这几件事，
     * 不是给插件往对话里塞东西的入口。
     */
    sessions:
      chat && stats
        ? {
            /** 最近的会话（按更新时间倒序），只带页面挑会话需要的字段。 */
            list: async (options = {}) => {
              const result = await stats.listSessions({})
              if (!Array.isArray(result?.sessions)) throw new Error('会话列表响应无效')
              const requested = Number(options?.limit)
              const limit =
                Number.isFinite(requested) && requested > 0
                  ? Math.max(1, Math.floor(requested))
                  : 60
              const time = (row) => {
                const value = Date.parse(row.updatedAt)
                return Number.isFinite(value) ? value : 0
              }
              return result.sessions
                .filter((row) => typeof row?.id === 'string' && row.id)
                .slice()
                .sort((a, b) => time(b) - time(a))
                .slice(0, limit)
                .map((row) => ({
                  id: row.id,
                  title: row.title || '未命名会话',
                  cwd: row.cwd || null,
                  updatedAt: row.updatedAt || null
                }))
            },
            /** 这条会话的对话正文（用户与助手），思考与工具过程不进列表。 */
            history: async (sessionId) => {
              if (!sessionId) return []
              const rows = await chat.history(sessionId)
              if (!Array.isArray(rows)) throw new Error('会话历史响应无效')
              return rows
                .filter(
                  (row) => row && (row.role === 'user' || row.role === 'assistant') && !row.kind
                )
                .map((row) => ({ role: row.role, text: String(row.text || '') }))
                .filter((row) => row.text)
            },
            /** 往这条会话发一条消息；`prompt` 原样送出。 */
            send: async ({ sessionId, cwd, prompt, clientMessageId } = {}) => {
              if (!sessionId) throw new Error('请先选择一条会话')
              const text = String(prompt ?? '')
              if (!text.trim()) throw new Error('消息内容为空')
              const id = await resolveNode(sessionId)
              return chat.start({
                id,
                sessionId,
                cwd: cwd || null,
                prompt: text,
                ...(clientMessageId ? { clientMessageId } : {}),
                maxTurns: 9999
              })
            },
            abort: async (sessionId) =>
              sessionId ? chat.abort(await resolveNode(sessionId)) : null,
            /** 状态快照包含 prompt/events/queuedItems/remoteRunning；读取失败必须显式处理。 */
            isRunning: sessionStatus,
            /** 与 isRunning 同义；恢复时先订阅并暂存事件，再读 history/status 合并，避免丢帧。 */
            status: sessionStatus,
            /** 保留 text_rollback/reasoning_rollback/retrying 等全部事件与 sequence。 */
            onEvent: (callback) =>
              chat.onEvent((payload) =>
                callback(eventSession(payload), payload.event, { ...payload, nodeId: payload.id })
              ),
            /** 这一轮结束（跑完 / 中止 / 宿主退出）。 */
            onExit: (callback) =>
              chat.onExit((payload) =>
                callback({ ...payload, nodeId: payload.id, id: eventSession(payload) })
              ),
            /** start 返回 ok 只表示写入成功；异步拒绝必须撤回乐观消息并恢复草稿。 */
            onQueueError: (callback) =>
              chat.onQueueError((payload) =>
                callback({ ...payload, nodeId: payload.id, id: eventSession(payload) })
              ),
            onQueueState: (callback) =>
              chat.onQueueState((payload) =>
                callback({ ...payload, nodeId: payload.id, id: eventSession(payload) })
              ),
            /** 定时任务或其他页面发起的一轮；用来补用户行，而不是拼接提示词。 */
            onRunStarted: (callback) =>
              chat.onRunStarted((payload) =>
                callback({ ...payload, nodeId: payload.id, id: eventSession(payload) })
              )
          }
        : null
  }
}

const idleListeners = new Set()
let lastIdleAt = 0

/** 宿主在「当前会话一轮跑完」时通知卡片（模型刚写完的会话状态需要重读）。 */
export function notifySessionIdle() {
  // 侧栏与顶栏两处入口都会看到 running → idle，同一次收尾只该触发一轮重读。
  if (Date.now() - lastIdleAt < 500) return
  lastIdleAt = Date.now()
  for (const listener of [...idleListeners]) {
    try {
      listener()
    } catch {
      // 一个卡片的回调炸了不该影响别的卡片
    }
  }
}

function subscribeSessionIdle(listener) {
  idleListeners.add(listener)
  return () => {
    idleListeners.delete(listener)
  }
}

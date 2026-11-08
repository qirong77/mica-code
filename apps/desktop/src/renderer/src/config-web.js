/**
 * 配置页在桌面端的数据源：动作名 + 参数交给运行时（src/host/configWeb.js），由它落到
 * `packages/mica-config-ui` 的动作表。浏览器端有另一份实现走 HTTP，页面组件相同。
 */

/**
 * 「在 Mica 中打开」落在主区的文件视图里（编辑器归 App 管），配置页自己拿不到那个入口，
 * 所以由 App 挂载时注册一次。没注册时如实回失败，不假装打开过。
 */
let openPathInEditor = null

export function setConfigWebFileOpener(opener) {
  openPathInEditor = typeof opener === 'function' ? opener : null
}

export function createDesktopConfigWebClient() {
  const invoke = (action, input) => window.mica.configWeb.invoke(action, input)

  return {
    // 路径动作：与对话区路径链接同一个入口（`files:open-path` 会按类型区分文件 / 目录，
    // 路径不存在时带回 error）；「在 Mica 中打开」由 App 注册。
    revealPath: (path) => window.mica.files.openPath(path),
    openPathInEditor: async (path) => {
      if (!openPathInEditor) return { ok: false, error: '编辑器还没准备好' }
      // 先问一次文件在不在：不存在时留在设置页、把原因写在菜单里（例如插件今天还没写过
      // 日志），而不是收起设置、在主区开一个空编辑器。
      const info = await window.mica.files.stat(path)
      if (!info?.ok) return { ok: false, error: info?.error || `路径不存在：${path}` }
      await openPathInEditor(info.path)
      return { ok: true, kind: info.kind, path: info.path }
    },

    readConfigFile: () => invoke('readConfigFile'),
    writeConfigFile: (content) => invoke('writeConfigFile', { content }),
    testProvider: (input) => invoke('testProvider', input),

    readMcpDetails: () => invoke('readMcpDetails'),
    writeMcpServers: (content) => invoke('writeMcpServers', { content }),

    readCapabilityDefaults: () => invoke('readCapabilityDefaults'),
    writeCapabilityDefaults: (input) => invoke('writeCapabilityDefaults', input),

    readSkillsDetails: () => invoke('readSkillsDetails'),
    createSkill: (name, content = '') => invoke('createSkill', { name, content }),
    writeSkill: (name, content) => invoke('writeSkill', { name, content }),
    deleteSkill: (name) => invoke('deleteSkill', { name }),

    readRolesDetails: () => invoke('readRolesDetails'),
    createRole: (name, content = '') => invoke('createRole', { name, content }),
    writeRole: (name, content) => invoke('writeRole', { name, content }),
    deleteRole: (name) => invoke('deleteRole', { name }),

    readPluginsDetails: () => invoke('readPluginsDetails'),
    setPluginEnabled: (id, enabled) => invoke('setPluginEnabled', { id, enabled }),
    writePluginSettings: (id, values) => invoke('writePluginSettings', { id, values }),
    testPluginLlm: (id, values) => invoke('testPluginLlm', { id, values }),
    // 配置页上的插件动作（注册这类）：真正跑插件代码的是一次性 CLI 进程，这里只转发。
    runPluginAction: (id, action, values) => invoke('runPluginAction', { id, action, values }),
    // 插件详情页的运行条件（辅助功能 / 屏幕录制等）：探测在 Electron 主进程
    readDesktopChecks: () => invoke('readDesktopChecks'),
    openDesktopSettings: (pane) => invoke('openDesktopSettings', { pane }),
    // 请求系统登记当前这个构建（辅助功能）：与「打开设置」不同，它让系统把正在运行的
    // 进程加进列表，用户勾的才是这一份。
    requestDesktopAccess: (id) => invoke('requestDesktopAccess', { id }),
    // 系统的文件夹选择器（设置项要挑目录时用）：面板由主进程开，取消不是错误。
    pickDirectory: (options) => invoke('pickDirectory', options ?? {}),

    readBrowserControlDetails: () => invoke('readBrowserControlDetails'),
    readTerminalControlDetails: () => invoke('readTerminalControlDetails'),

    readPerformanceDetails: (options) => invoke('readPerformanceDetails', options),
    clearPerformanceLogs: () => invoke('clearPerformanceLogs'),
    // 渲染层堆快照：由主进程对目标窗口的 webContents 拍，落在日志目录。
    takeHeapSnapshot: (options) => invoke('takeHeapSnapshot', options ?? {}),

    readSessionsDetails: () => invoke('readSessionsDetails'),
    readSessionDetails: (id) => invoke('readSessionDetails', { id }),
    readSessionContent: (id) => invoke('readSessionContent', { id }),
    readSessionConversationPage: (id, offset, limit, tail = false) =>
      invoke('readSessionConversationPage', { id, offset, limit, tail }),
    readSessionItem: (id, sequence) => invoke('readSessionItem', { id, sequence }),
    readSessionContextAnalysis: (id) => invoke('readSessionContextAnalysis', { id }),
    // 最近一次请求真正发出的完整提示词（角色 + 项目说明 + skills + 插件段落）。
    readSessionSystemPrompt: (id) => invoke('readSessionSystemPrompt', { id }),
    writeSession: (id, content) => invoke('writeSession', { id, content })
  }
}

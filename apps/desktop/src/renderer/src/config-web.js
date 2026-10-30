/**
 * 配置页在桌面端的数据源：动作名 + 参数交给运行时（src/host/configWeb.js），由它落到
 * `packages/mica-config-ui` 的动作表。浏览器端有另一份实现走 HTTP，页面组件相同。
 */
export function createDesktopConfigWebClient() {
  const invoke = (action, input) => window.mica.configWeb.invoke(action, input)

  return {
    readConfigFile: () => invoke('readConfigFile'),
    writeConfigFile: (content) => invoke('writeConfigFile', { content }),

    readMcpDetails: () => invoke('readMcpDetails'),
    createMcpServer: (name, content = '') => invoke('createMcpServer', { name, content }),
    writeMcpServer: (name, content) => invoke('writeMcpServer', { name, content }),
    deleteMcpServer: (name) => invoke('deleteMcpServer', { name }),

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

    readBrowserControlDetails: () => invoke('readBrowserControlDetails'),
    readTerminalControlDetails: () => invoke('readTerminalControlDetails'),

    readPerformanceDetails: (options) => invoke('readPerformanceDetails', options),
    clearPerformanceLogs: () => invoke('clearPerformanceLogs'),

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

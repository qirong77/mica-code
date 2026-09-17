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

    readSkillsDetails: () => invoke('readSkillsDetails'),
    createSkill: (name, content = '') => invoke('createSkill', { name, content }),
    writeSkill: (name, content) => invoke('writeSkill', { name, content }),
    deleteSkill: (name) => invoke('deleteSkill', { name }),

    readRolesDetails: () => invoke('readRolesDetails'),
    createRole: (name, content = '') => invoke('createRole', { name, content }),
    writeRole: (name, content) => invoke('writeRole', { name, content }),
    deleteRole: (name) => invoke('deleteRole', { name }),

    readPluginsDetails: () => invoke('readPluginsDetails'),

    readSessionsDetails: () => invoke('readSessionsDetails'),
    readSessionDetails: (id) => invoke('readSessionDetails', { id }),
    readSessionContent: (id) => invoke('readSessionContent', { id }),
    readSessionConversationPage: (id, offset, limit, tail = false) =>
      invoke('readSessionConversationPage', { id, offset, limit, tail }),
    readSessionItem: (id, sequence) => invoke('readSessionItem', { id, sequence }),
    readSessionContextAnalysis: (id) => invoke('readSessionContextAnalysis', { id }),
    writeSession: (id, content) => invoke('writeSession', { id, content })
  }
}

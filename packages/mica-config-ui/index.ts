/**
 * 配置页（Mica Config Web）的共享实现：一份源码同时给两个宿主用。
 *
 * - 浏览器：`apps/config-web` 起 Bun HTTP 服务，页面走 `/api/*`（生产环境的内嵌产物由
 *   `bun run build:config-web` 生成）。
 * - 桌面端：`apps/desktop` 的运行时把同一套数据操作暴露成 IPC，renderer 直接渲染页面
 *   组件（不再起 config-web worker、也不用 iframe）。
 *
 * 本入口是 Node 侧：数据读取/写入动作与它们在磁盘上的实现。
 */
export {
  configWebActions,
  configWebActionNames,
  isConfigWebActionName,
  runConfigWebAction,
} from './src/server/actions.js';
export type { ConfigWebActionInput, ConfigWebActionName } from './src/server/actions.js';
export { buildConfigWebConversationDetails } from './src/server/conversation.js';
export type { ConfigWebConversationSource } from './src/server/conversation.js';
export {
  getConfigWebStatePath,
  getConversationWorkspacePath,
  getMicaHome,
  getPluginStatusPath,
  getPluginsRootPath,
  getSkillsRootPath,
} from './src/server/paths.js';
export type {
  ConfigWebContextAnalysis,
  ConfigWebContextEntry,
  ConfigWebContextTurn,
  ConfigWebConversationDetails,
  ConfigWebConversationItem,
  ConfigWebConversationItemType,
  ConfigWebConversationPage,
  ConfigWebFilePayload,
  ConfigWebMcpDetails,
  ConfigWebMcpServer,
  ConfigWebMcpTool,
  ConfigWebPlugin,
  ConfigWebPluginsDetails,
  ConfigWebRole,
  ConfigWebRolesDetails,
  ConfigWebSection,
  ConfigWebServerInfo,
  ConfigWebSession,
  ConfigWebSessionDetails,
  ConfigWebSessionOption,
  ConfigWebSessionsDetails,
  ConfigWebSessionUsage,
  ConfigWebSkill,
  ConfigWebSkillsDetails,
} from './src/shared/types.js';

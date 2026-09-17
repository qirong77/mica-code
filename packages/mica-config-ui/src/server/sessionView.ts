/**
 * 会话视图的纯构建逻辑（history → 可读对话项 / 上下文占用分解）。
 *
 * 这里只导出不碰文件系统、也不依赖任何 mica-* 运行时单例的函数，所以桌面端运行时也能直接
 * 用它（那边自己读 `$MICA_HOME/sessions`，见 apps/desktop 的 src/host/configWebData.js）。
 */
export { buildConfigWebConversationDetails, buildConfigWebConversationItems } from './conversation.js';
export type { ConfigWebConversationSource } from './conversation.js';
export { buildConfigWebContextAnalysis, estimateTextTokens } from './sessionAnalysis.js';

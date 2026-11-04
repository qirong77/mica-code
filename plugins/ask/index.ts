import type { PluginContext } from '@packages/mica-plugin/index.js';
import { AskPlugin } from './AskPlugin.js';

export { AskPlugin } from './AskPlugin.js';
export { AskUserTool, ASK_TOOL_NAME } from './AskTool.js';
export { ASK_GUIDANCE, buildAskGuidance } from './prompt.js';

/**
 * 插件入口：官方插件统一用 `default` 导出 setup，和用户插件目录里的 `index.js` 同一套约定。
 */
export default function setup(ctx: PluginContext): void {
  new AskPlugin().setup(ctx);
}

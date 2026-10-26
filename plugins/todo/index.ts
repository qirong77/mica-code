import type { PluginContext } from '@packages/mica-plugin/index.js';
import { TodoPlugin } from './TodoPlugin.js';

export { TodoPlugin } from './TodoPlugin.js';
export { parseTodoInput, formatTodoSummary, TodoWriteTool } from './TodoTool.js';
export type { TodoItem, TodoStatus } from './TodoTool.js';

/**
 * 插件入口：官方插件统一用 `default` 导出 setup，和用户插件目录里的 `index.js` 同一套约定，
 * 这样「官方插件」和「安装到 ~/.mica/plugins 的插件」在加载器眼里是同一个概念。
 */
export default function setup(ctx: PluginContext): void {
  new TodoPlugin().setup(ctx);
}

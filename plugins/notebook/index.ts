import type { PluginContext } from '@packages/mica-plugin/index.js';

/**
 * Notebook 的页面与 `/plugin/notebook/api` 都由宿主装配：页面是插件自己的桌面资源，
 * 模型接口是 `api.ts` 导出的 `createApi`。所以普通插件 setup 保持为空，没有第二条
 * 会话工具或 skill 注册路径。
 */
export default function setup(_ctx: PluginContext): void {}

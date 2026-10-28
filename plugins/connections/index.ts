import type { PluginContext } from '@packages/mica-plugin/index.js';

/**
 * 连接：连到另一台机器上的 Mica 运行时。
 *
 * 这个插件的能力全在桌面端：侧栏一行入口（清单 `desktop.entry`）由宿主渲染，点开的卡片
 * 是同目录的 `desktop.jsx`——它经宿主的 `plugin-host:*` 动作探活、读配置页数据文件，
 * 读写的结构定义在 `peers.ts`。
 *
 * 所以后端在这里是空的：不注册 tool、不注册命令、不往 system prompt 里加任何东西。
 * 连哪台机器是用户的决定（手上的地址、公司内网、家里那台机器），模型既不知道这些地址
 * 是否存在，也不该因为看见它们而改变对任务的理解；后端只要留一条启动日志，让
 * `plugin-status.json` 与插件日志能回答「它到底装上了没有」。
 */
export default function setup(ctx: PluginContext): void {
  ctx.logger.info('connections:ready', {});
}

import type { PluginContext } from '@packages/mica-plugin/index.js';

/** 独立于会话的本地笔记本，页面与文档读写通过插件宿主能力连接。 */
export default function setup(ctx: PluginContext): void {
  ctx.logger.info('notebook:ready', {});
}

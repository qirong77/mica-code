import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { SCHEDULE_DATA_FILE } from './store.js';

/**
 * `schedule`：这台机器上的一份本地排期。
 *
 * 它不属于任何聊天工具——数据就在 `$MICA_HOME/plugin-data/schedule/data.json`，两个入口改
 * 同一份：桌面端整页甘特图（拖条、建任务、写备注），和 `/plugin/schedule/api`（用户跟模型
 * 说一句「把联调推到下周」，模型按需读接口文档再调）。页面与接口都由宿主装配，普通插件
 * setup 只留一条就绪日志，没有会话工具或 skill 注册路径。
 */

export default function setup(ctx: PluginContext): void {
  const dataDir = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  ctx.logger.info('schedule:ready', { file: join(dataDir, SCHEDULE_DATA_FILE) });
}

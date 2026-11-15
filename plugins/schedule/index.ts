import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { ScheduleTool } from './ScheduleTool.js';
import { SCHEDULE_DATA_FILE } from './store.js';

/**
 * `schedule`：这台机器上的一份本地排期。
 *
 * 它不属于任何聊天工具——数据就在 `$MICA_HOME/plugin-data/schedule/data.json`，两个入口改
 * 同一份：桌面端整页甘特图（拖条、建任务、写备注），和 `schedule` 工具（用户跟模型说一句
 * 「把联调推到下周」）。读写规则直接写在工具描述里。
 */

export default function setup(ctx: PluginContext): void {
  const tools = ctx.tools;
  if (!tools) throw new Error('schedule 需要宿主提供 tools 能力');

  const dataDir = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId);
  const tool = tools.register(new ScheduleTool(join(dataDir, SCHEDULE_DATA_FILE)), {
    icon: '📅',
    // 排期是「用户的东西」：子代理临时被派去查东西时顺手改一条，用户根本不知道谁改的。
    primaryAgentOnly: true,
  });
  ctx.onDispose(() => tool.dispose());

  ctx.logger.info('schedule:ready', { dataDir });
}

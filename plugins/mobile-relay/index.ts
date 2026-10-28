import type { PluginContext } from '@packages/mica-plugin/PluginContext.js';
import { join } from 'node:path';
import { registerBridgeSupervisor } from './BridgeSupervisor.js';
import { MobileRelayTool } from './MobileRelayTool.js';

export default function setup(ctx: PluginContext): void {
  // 桥的启停跟着插件走：停用插件就杀掉那个常驻进程，不留任何还在外联的东西。
  // 数据目录跟插件的其余状态一致放在 `$MICA_HOME/plugin-data/<id>`（`paths.config` 就是
  // MICA_HOME；`paths.home` 是系统 home，写到那里会污染用户目录）。
  const lockDir = ctx.paths?.config ? join(ctx.paths.config, 'plugin-data', 'mobile-relay') : null;
  registerBridgeSupervisor(ctx, lockDir);

  const tools = ctx.tools;
  if (!tools) {
    ctx.health.report({
      level: 'warn',
      message: '缺少 tools 能力，mobile_relay 工具未注册（桥仍然在跑）',
      hint: '检查 plugin.json 的 requires 是否包含 tools',
    });
    return;
  }
  tools.register(new MobileRelayTool(ctx));
}

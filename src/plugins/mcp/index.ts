import { micaMcp } from '@packages/mica-mcp/index.js';
import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { reportRuntimeError } from '../../runtime/uiBridge.js';

export class McpPlugin extends micaPlugin.Plugin {
  constructor() {
    super({
      id: 'builtin.mcp',
      name: 'MCP',
    });
  }

  setup(ctx: PluginContext): void {
    const startDisposable = ctx.hooks.on(
      'runtime:start',
      async () => {
        try {
          await micaMcp.init();
        } catch (error) {
          reportRuntimeError(error, 'MCP 初始化失败');
        }
      },
      { pluginId: ctx.pluginId },
    );
    ctx.onDispose(() => startDisposable.dispose());

    const stopDisposable = ctx.hooks.on(
      'runtime:stop',
      async () => {
        await micaMcp.shutdown();
      },
      { pluginId: ctx.pluginId },
    );
    ctx.onDispose(() => stopDisposable.dispose());
  }
}

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
    let started = false;
    const shutdown = async () => {
      try {
        await micaMcp.shutdown();
      } catch (error) {
        reportRuntimeError(error, 'MCP 关闭失败');
      } finally {
        started = false;
      }
    };
    const startDisposable = ctx.hooks.on(
      'runtime:start',
      async () => {
        started = true;
        try {
          await micaMcp.init();
        } catch (error) {
          reportRuntimeError(error, 'MCP 初始化失败');
        }
      },
      { pluginId: ctx.pluginId },
    );

    const stopDisposable = ctx.hooks.on(
      'runtime:stop',
      async () => {
        await shutdown();
      },
      { pluginId: ctx.pluginId },
    );
    ctx.onDispose(async () => {
      startDisposable.dispose();
      stopDisposable.dispose();
      if (!started) return;
      await shutdown();
    });
  }
}

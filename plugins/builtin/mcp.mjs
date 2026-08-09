import { micaMcp } from '../../packages/mica-mcp/index.js';

export default function setup(ctx) {
  let started = false;
  let startController = null;
  let startPromise = null;

  const reportError = (event, title, error) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error(event, { error: message });
    ctx.ui?.showMessage?.(`${title}: ${message}`);
  };

  const shutdown = async () => {
    started = false;
    startController?.abort();
    await startPromise;
    try {
      await micaMcp.shutdown();
    } catch (error) {
      reportError('mcp:shutdown-failed', 'MCP 关闭失败', error);
    } finally {
      startController = null;
      startPromise = null;
    }
  };

  const startDisposable = ctx.hooks.on(
    'runtime:start',
    async () => {
      started = true;
      const controller = new AbortController();
      startController = controller;
      startPromise = (async () => {
        try {
          await micaMcp.init({ signal: controller.signal });
        } catch (error) {
          if (!controller.signal.aborted) reportError('mcp:init-failed', 'MCP 初始化失败', error);
        }
      })();
      await startPromise;
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

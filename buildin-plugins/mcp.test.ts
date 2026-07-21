import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';

const mocks = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  shutdown: vi.fn<() => Promise<void>>(),
}));

vi.mock('../packages/mica-mcp/index.js', () => ({
  micaMcp: {
    init: mocks.init,
    shutdown: mocks.shutdown,
  },
}));

import setupMcp from './mcp.mjs';

beforeEach(() => {
  mocks.init.mockReset().mockResolvedValue(undefined);
  mocks.shutdown.mockReset().mockResolvedValue(undefined);
});

describe('MCP file plugin', () => {
  it('starts and stops MCP with the runtime lifecycle', async () => {
    const { hooks, dispose } = setupPlugin();

    await hooks.emit('runtime:start', {});
    expect(mocks.init).toHaveBeenCalledOnce();

    await hooks.emit('runtime:stop', {});
    expect(mocks.shutdown).toHaveBeenCalledOnce();

    await dispose();
    await hooks.emit('runtime:start', {});
    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it('reports initialization failures and still shuts down during disposal', async () => {
    const error = new Error('connection failed');
    mocks.init.mockRejectedValueOnce(error);
    const { hooks, logger, showMessage, dispose } = setupPlugin();

    await hooks.emit('runtime:start', {});

    expect(logger.error).toHaveBeenCalledWith('mcp:init-failed', { error: 'connection failed' });
    expect(showMessage).toHaveBeenCalledWith('MCP 初始化失败: connection failed');
    await dispose();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it('reports shutdown failures without blocking disposal or shutting down twice', async () => {
    const error = new Error('close failed');
    mocks.shutdown.mockRejectedValueOnce(error);
    const { hooks, logger, showMessage, dispose } = setupPlugin();

    await hooks.emit('runtime:start', {});
    await hooks.emit('runtime:stop', {});

    expect(logger.error).toHaveBeenCalledWith('mcp:shutdown-failed', { error: 'close failed' });
    expect(showMessage).toHaveBeenCalledWith('MCP 关闭失败: close failed');
    await expect(dispose()).resolves.toBeUndefined();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it('does not require a UI error reporter', async () => {
    const error = new Error('connection failed');
    mocks.init.mockRejectedValueOnce(error);
    const { hooks, logger } = setupPlugin(false);

    await expect(hooks.emit('runtime:start', {})).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('mcp:init-failed', { error: 'connection failed' });
  });
});

function setupPlugin(withUi = true) {
  const hooks = new micaPlugin.HookRegistry();
  const disposers: Array<() => void | Promise<void>> = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const showMessage = vi.fn();
  const context: PluginContext = {
    pluginId: 'builtin.mcp',
    hooks,
    commands: new micaCommands.CommandRegistry(),
    services: new micaPlugin.ServiceContainer(),
    events: new micaRuntime.RuntimeEventBus(),
    logger,
    onDispose: (dispose) => disposers.push(dispose),
    ...(withUi ? { ui: { submit: vi.fn(), showMessage } } : {}),
  };

  setupMcp(context);
  return {
    hooks,
    logger,
    showMessage,
    async dispose() {
      for (const disposer of disposers.reverse()) await disposer();
    },
  };
}

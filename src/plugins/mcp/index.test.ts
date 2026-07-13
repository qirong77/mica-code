import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';

const mocks = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  shutdown: vi.fn<() => Promise<void>>(),
  reportRuntimeError: vi.fn(),
}));

vi.mock('@packages/mica-mcp/index.js', () => ({
  micaMcp: {
    init: mocks.init,
    shutdown: mocks.shutdown,
  },
}));

vi.mock('../../runtime/uiBridge.js', () => ({
  reportRuntimeError: mocks.reportRuntimeError,
}));

import { McpPlugin } from './index.js';

beforeEach(() => {
  mocks.init.mockReset().mockResolvedValue(undefined);
  mocks.shutdown.mockReset().mockResolvedValue(undefined);
  mocks.reportRuntimeError.mockReset();
});

describe('McpPlugin', () => {
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
    const { hooks, dispose } = setupPlugin();

    await hooks.emit('runtime:start', {});

    expect(mocks.reportRuntimeError).toHaveBeenCalledWith(error, 'MCP 初始化失败');
    await dispose();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it('reports shutdown failures without blocking disposal', async () => {
    const error = new Error('close failed');
    mocks.shutdown.mockRejectedValueOnce(error);
    const { hooks, dispose } = setupPlugin();

    await hooks.emit('runtime:start', {});
    await hooks.emit('runtime:stop', {});

    expect(mocks.reportRuntimeError).toHaveBeenCalledWith(error, 'MCP 关闭失败');
    await expect(dispose()).resolves.toBeUndefined();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });
});

function setupPlugin() {
  const hooks = new micaPlugin.HookRegistry();
  const disposers: Array<() => void | Promise<void>> = [];
  const context: PluginContext = {
    pluginId: 'builtin.mcp',
    hooks,
    commands: new micaCommands.CommandRegistry(),
    services: new micaPlugin.ServiceContainer(),
    events: new micaRuntime.RuntimeEventBus(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onDispose: (dispose) => disposers.push(dispose),
  };

  new McpPlugin().setup(context);
  return {
    hooks,
    async dispose() {
      for (const disposer of disposers.reverse()) await disposer();
    },
  };
}

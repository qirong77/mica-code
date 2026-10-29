import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import startConfigWebWorker from './configWebWorker.js';
import setupFilePlugins from '@packages/mica-builtin-commands/startup/file-plugins.js';
import setupProcessDiagnostics, {
  defaultProcessTitle,
} from '@packages/mica-builtin-commands/startup/process-diagnostics.js';
import { parsePluginManifest } from '@packages/mica-plugin/index.js';

describe('file-plugins startup plugin', () => {
  it('loads and registers non-duplicate file plugins', async () => {
    const duplicate = { id: 'user.duplicate', setup() {} };
    const available = { id: 'user.available', setup() {} };
    const register = vi.fn();
    const loadFilePlugins = vi.fn(async () => ({
      plugins: [duplicate, available],
      loaded: [
        { pluginId: duplicate.id, file: '/plugins/duplicate/index.js', manifest: manifestFor('duplicate') },
        { pluginId: available.id, file: '/plugins/available/index.js', manifest: manifestFor('available') },
      ],
      failed: [],
    }));

    const result = await setupFilePlugins({
      paths: { plugins: '/plugins' },
      plugins: {
        has: (pluginId: string) => pluginId === duplicate.id,
        register,
      },
      loadFilePlugins,
      logger: { warn: vi.fn() },
    });

    expect(loadFilePlugins).toHaveBeenCalledWith({
      pluginsDir: '/plugins',
      disabled: expect.any(Set),
      logger: expect.any(Object),
    });
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(available);
    expect(result.plugins).toEqual([duplicate, available]);
  });
});

describe('config-web-worker startup plugin', () => {
  it('does nothing outside worker mode', async () => {
    const startServer = vi.fn();

    await expect(startConfigWebWorker({ argv: ['/usr/bin/mica'], startServer })).resolves.toBe(false);
    expect(startServer).not.toHaveBeenCalled();
  });

  it('starts Config Web in worker mode', async () => {
    const startServer = vi.fn(async () => undefined);

    await expect(startConfigWebWorker({ argv: ['/usr/bin/mica', '--config-web-worker'], startServer })).resolves.toBe(
      true,
    );
    expect(startServer).toHaveBeenCalledWith();
  });
});

describe('process-diagnostics startup plugin', () => {
  it('reports process errors and removes listeners on dispose', () => {
    const runtimeProcess = Object.assign(new EventEmitter(), { title: 'node' });
    const reportError = vi.fn();
    const diagnostics = setupProcessDiagnostics({ process: runtimeProcess, reportError });
    const uncaught = new Error('uncaught');
    const rejection = new Error('rejection');

    runtimeProcess.emit('uncaughtException', uncaught);
    runtimeProcess.emit('unhandledRejection', rejection);

    expect(runtimeProcess.title).toBe(defaultProcessTitle());
    expect(reportError).toHaveBeenNthCalledWith(1, uncaught, '未捕获异常');
    expect(reportError).toHaveBeenNthCalledWith(2, rejection, '未处理的异步错误');

    diagnostics.dispose();
    diagnostics.dispose();
    runtimeProcess.emit('uncaughtException', new Error('after dispose'));
    expect(reportError).toHaveBeenCalledTimes(2);
  });
});

function manifestFor(id: string) {
  const result = parsePluginManifest({ id, name: id, version: '1.0.0' });
  if (!result.ok) throw new Error(result.error);
  return result.manifest;
}

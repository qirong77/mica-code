import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import startConfigWebWorker from './configWebWorker.js';
import setupFilePlugins, { writeFilePluginStatus } from '@packages/mica-builtin-commands/startup/file-plugins.js';
import setupProcessDiagnostics from '@packages/mica-builtin-commands/startup/process-diagnostics.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('file-plugins startup plugin', () => {
  it('loads and registers non-duplicate file plugins', async () => {
    const duplicate = { id: 'file.duplicate', setup() {} };
    const available = { id: 'file.available', setup() {} };
    const register = vi.fn();
    const loadFilePlugins = vi.fn(async () => ({
      plugins: [duplicate, available],
      loaded: [
        { pluginId: duplicate.id, file: '/plugins/duplicate.mjs' },
        { pluginId: available.id, file: '/plugins/available.mjs' },
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
      logger: expect.any(Object),
    });
    expect(register).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(available);
    expect(result.plugins).toEqual([duplicate, available]);
  });

  it('writes setup and import failures to the Config Web status file', () => {
    const config = createTempDirectory();
    const status = writeFilePluginStatus(
      { paths: { config, plugins: '/plugins' } },
      {
        loaded: [
          { pluginId: 'file.ready', file: '/plugins/ready.mjs' },
          { pluginId: 'file.broken', file: '/plugins/broken.mjs' },
        ],
        failed: [{ file: '/plugins/import-error.mjs', error: new Error('import failed') }],
      },
      {
        loaded: ['file.ready'],
        failed: [{ pluginId: 'file.broken', error: new Error('setup failed') }],
      },
    );

    const persisted = JSON.parse(readFileSync(join(config, 'plugin-status.json'), 'utf-8'));
    expect(persisted).toMatchObject({
      root: '/plugins',
      plugins: [
        { id: 'file.ready', status: 'loaded' },
        { id: 'file.broken', status: 'failed', error: 'setup failed' },
      ],
      loadFailed: [{ file: '/plugins/import-error.mjs', status: 'failed', error: 'import failed' }],
    });
    expect(status.updatedAt).toEqual(expect.any(String));
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

    await expect(
      startConfigWebWorker({ argv: ['/usr/bin/mica', '--config-web-worker'], startServer }),
    ).resolves.toBe(true);
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

    expect(runtimeProcess.title).toBe('mica');
    expect(reportError).toHaveBeenNthCalledWith(1, uncaught, '未捕获异常');
    expect(reportError).toHaveBeenNthCalledWith(2, rejection, '未处理的异步错误');

    diagnostics.dispose();
    diagnostics.dispose();
    runtimeProcess.emit('uncaughtException', new Error('after dispose'));
    expect(reportError).toHaveBeenCalledTimes(2);
  });
});

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-startup-plugin-'));
  tempDirectories.push(directory);
  return directory;
}

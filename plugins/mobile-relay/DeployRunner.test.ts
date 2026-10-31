import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
import { readDeployState, runSetup } from './DeployRunner.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'mica-deploy-lifecycle-'));
  dirs.push(dir);
  const child = Object.assign(new EventEmitter(), {
    pid: 987654,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  const disposers: Array<() => void | Promise<void>> = [];
  const ctx = {
    onDispose: (fn: () => void | Promise<void>) => {
      disposers.push(fn);
    },
    logger: { info: vi.fn() },
  } as unknown as PluginContext;
  const onState = vi.fn();
  const result = runSetup(ctx, dir, { host: 'root@relay.test' }, onState);
  return { dir, child, onState, result, dispose: () => disposers[0]!() };
}

describe('deploy lifecycle', () => {
  it('terminates the setup process group when the plugin is disposed', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { child, result, dispose } = harness();
    const disposing = dispose();
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    else expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await disposing;
    expect((await result).phase).toBe('failed');
  });

  it('escalates if setup ignores termination', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const { child, result, dispose } = harness();
    const disposing = dispose();
    await vi.advanceTimersByTimeAsync(3_000);
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    else expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await disposing;
    await result;
  });

  it('retains the startup error when close follows error, and ignores later output', async () => {
    const { dir, child, onState, result, dispose } = harness();
    child.emit('error', new Error('node not found'));
    await result;
    const calls = onState.mock.calls.length;
    child.emit('close', -2);
    child.stderr.emit('data', Buffer.from('late output'));
    expect(onState).toHaveBeenCalledTimes(calls);
    expect(readDeployState(dir).lines).toEqual(['启动失败：node not found']);
    await dispose();
    expect(child.kill).not.toHaveBeenCalled();
  });
});

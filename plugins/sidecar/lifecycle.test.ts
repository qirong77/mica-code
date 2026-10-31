import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidecarProcess } from './sidecarProcess.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: string) => {
      if (signal === 'SIGKILL') child.emit('close', null, signal);
      return true;
    }),
  });
  child.stdin.on('data', (data: Buffer) => {
    const request = JSON.parse(data.toString()) as { id?: number; method: string };
    if (request.id === undefined) return;
    const result = request.method === 'thread/start' ? { thread: { id: 'child-1' } } : {};
    child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  return child;
}

describe('SidecarProcess shutdown', () => {
  it('releases every waiting timer and abort listener immediately when cancelled', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const process_ = await SidecarProcess.start({});
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    for (let index = 0; index < 200; index++) {
      const current = new AbortController();
      const waiting = process_.waitForChange(60_000, current.signal);
      current.abort();
      expect(await waiting).toBe(false);
    }
    const waiting = process_.waitForChange(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect(await waiting).toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const closing = process_.close(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('waits for exit when the child still reports progress after stdin EOF', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const process_ = await SidecarProcess.start({});
    let settled = false;
    const closing = process_.close(10).then(() => {
      settled = true;
    });

    child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { turn: { id: 't1' } } })}\n`);
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(1_500);
    await closing;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(process_.closed).toBe(true);
  });

  it('ignores non-object JSON on stdout instead of throwing in the line listener', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const process_ = await SidecarProcess.start({});
    try {
      expect(() => child.stdout.write('null\n')).not.toThrow();
      expect(() => child.stdout.write('42\n')).not.toThrow();
    } finally {
      const closing = process_.close(0);
      await vi.advanceTimersByTimeAsync(1_500);
      await closing;
    }
  });

  it('handles a broken stdin pipe while the process is still exiting', async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const process_ = await SidecarProcess.start({});
    try {
      expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
    } finally {
      const closing = process_.close(0);
      await vi.advanceTimersByTimeAsync(1_500);
      await closing;
    }
  });
});

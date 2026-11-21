import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeBridge } from './native.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function fixture() {
  const processes: any[] = [];
  const messages: any[] = [];
  const onActivate = vi.fn();
  const bridge = createNativeBridge({
    directory: '/unused-test-directory',
    prepare: async () => '/unused-test-helper',
    onActivate,
    spawn: () => {
      const child: any = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('close', 0));
        return true;
      });
      let input = '';
      child.stdin.on('data', (chunk: Buffer) => {
        input += String(chunk);
        let end;
        while ((end = input.indexOf('\n')) >= 0) {
          messages.push(JSON.parse(input.slice(0, end)));
          input = input.slice(end + 1);
        }
      });
      processes.push(child);
      queueMicrotask(() =>
        child.stdout.write(`${JSON.stringify({ event: 'ready', changeCount: 3, accessibility: true })}\n`),
      );
      return child;
    },
  });
  cleanups.push(() => bridge.dispose());
  return { bridge, processes, messages, onActivate };
}

async function flushed() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('native clipboard transport', () => {
  it('shares initialization and correlates responses without exposing clipboard data to logs', async () => {
    const value = fixture();
    await Promise.all([value.bridge.start(), value.bridge.start()]);
    expect(value.processes).toHaveLength(1);
    const first = value.bridge.request('frontmost');
    const second = value.bridge.request('status');
    await flushed();
    expect(value.messages.map((message) => message.action)).toEqual(['frontmost', 'status']);
    const child = value.processes[0];
    child.stdout.write(`${JSON.stringify({ id: value.messages[1].id, ok: true, result: { accessibility: false } })}\n`);
    child.stdout.write(`${JSON.stringify({ id: value.messages[0].id, ok: true, result: { pid: 42 } })}\n`);
    expect(await first).toEqual({ pid: 42 });
    expect(await second).toEqual({ accessibility: false });
  });

  it('handles split NDJSON and menu activation separately from responses', async () => {
    const value = fixture();
    await value.bridge.start();
    const child = value.processes[0];
    child.stdout.write('{"event":"activate","altKey":tr');
    child.stdout.write('ue,"shiftKey":false}\n');
    await flushed();
    expect(value.onActivate).toHaveBeenCalledWith({ altKey: true, shiftKey: false });
  });

  it('rejects outstanding commands when the helper exits, then permits a clean restart', async () => {
    const value = fixture();
    const operation = value.bridge.request('write', { snapshot: {} });
    const assertion = expect(operation).rejects.toThrow('已退出');
    await flushed();
    value.processes[0].emit('close', 1);
    await assertion;
    await value.bridge.start();
    expect(value.processes).toHaveLength(2);
  });

  it('kills a stalled helper so a timed-out paste cannot execute later', async () => {
    const value = fixture();
    await value.bridge.start();
    vi.useFakeTimers();
    const operation = value.bridge.request('paste', { targetPid: 42 });
    const assertion = expect(operation).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(value.processes[0].kill).toHaveBeenCalled();
  });
});

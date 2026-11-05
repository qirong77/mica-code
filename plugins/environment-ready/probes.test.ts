import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeTarget, type FetchProbe } from './probes.js';
import type { Target } from './state.js';

const web: Target = { id: 'web', label: 'Web', kind: 'http', url: 'http://localhost:3000/health' };
const db: Target = { id: 'db', label: 'DB', kind: 'tcp', host: '127.0.0.1', port: 5432 };
const signal = () => new AbortController().signal;
const response = (status: number) => ({
  status,
  body: { cancel: vi.fn().mockResolvedValue(undefined) } as unknown as Response['body'],
});
class FakeSocket extends EventEmitter {
  destroy = vi.fn(() => this);
  setTimeout = vi.fn(() => this);
  connect = vi.fn(() => this);
}

afterEach(() => vi.useRealTimers());

describe('bounded local probes', () => {
  it.each([200, 204, 302, 401, 500])(
    'reports exact HTTP %s, transport reachability and 2xx separately',
    async (code) => {
      const reply = response(code);
      const fetch = vi.fn<FetchProbe>().mockResolvedValue(reply);
      const result = await probeTarget(web, signal(), { fetch, now: () => 1234 });
      expect(result).toMatchObject({
        checkedAt: 1234,
        reachable: true,
        healthy: code >= 200 && code < 300,
        statusCode: code,
      });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        'http://127.0.0.1:3000/health',
        expect.objectContaining({
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: {},
          referrerPolicy: 'no-referrer',
          signal: expect.any(AbortSignal),
        }),
      );
      expect(reply.body?.cancel).toHaveBeenCalledOnce();
      if (code === 302) expect(result.error).toBe('redirect');
    },
  );
  it('never follows a redirect or reads a response body', async () => {
    const fetch = vi.fn<FetchProbe>().mockResolvedValue(response(307));
    await probeTarget(web, signal(), { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1].redirect).toBe('manual');
  });
  it('bounds HTTP time even if the injected fetch ignores cancellation and releases a late response', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof response>) => void;
    const fetch = vi.fn<FetchProbe>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = probeTarget(web, signal(), { fetch, now: () => 1000, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ checkedAt: 1000, reachable: false, healthy: null, error: 'timeout' });
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    const late = response(200);
    resolve(late);
    await Promise.resolve();
    expect(late.body?.cancel).toHaveBeenCalledOnce();
  });
  it('aborts in-flight HTTP, does not start already-aborted work and sanitizes transport errors', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<FetchProbe>(() => new Promise(() => {}));
    const pending = probeTarget(web, controller.signal, { fetch });
    controller.abort();
    expect(await pending).toMatchObject({ reachable: false, error: 'aborted' });
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    await probeTarget(web, controller.signal, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const failed = await probeTarget(web, signal(), {
      fetch: async () => {
        throw new Error('secret URL/path/token');
      },
    });
    expect(failed).toMatchObject({
      reachable: false,
      healthy: null,
      error: 'connection',
      checkedAt: expect.any(Number),
    });
    expect(JSON.stringify(failed)).not.toContain('secret');
  });
  it.each(['connect', 'timeout', 'error', 'abort'])(
    'destroys TCP sockets on %s and ignores late events',
    async (event) => {
      const socket = new FakeSocket();
      const controller = new AbortController();
      const pending = probeTarget(db, controller.signal, {
        socket: () => socket as unknown as Socket,
        now: () => 4567,
        timeoutMs: 50,
      });
      expect(socket.setTimeout).toHaveBeenCalledWith(50);
      expect(socket.connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 5432 });
      if (event === 'abort') controller.abort();
      else socket.emit(event, new Error('private error'));
      const result = await pending;
      expect(result).toMatchObject({ checkedAt: 4567, reachable: event === 'connect', healthy: null });
      if (event !== 'connect')
        expect(result.error).toBe(event === 'error' ? 'connection' : event === 'abort' ? 'aborted' : 'timeout');
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      socket.emit('error', new Error('late'));
      socket.emit('connect');
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    },
  );
  it('validates again at the network boundary', async () => {
    const fetch = vi.fn<FetchProbe>();
    await expect(probeTarget({ ...web, url: 'https://external.test' }, signal(), { fetch })).rejects.toThrow('首版');
    expect(fetch).not.toHaveBeenCalled();
  });
});

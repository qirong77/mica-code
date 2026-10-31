import { EventEmitter } from 'node:events';
import { createHash, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

// 执行真实桥脚本的循环与命令路径，网络与计时器留在进程内，不连接外部服务。
function bridgeHarness() {
  const source = readFileSync(new URL('./agent/bridge.mjs', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '')
    .replace(
      'void main()',
      `globalThis.bridge = {
      tick, runCommand, resultsForPoll, rememberResult,
      cache: () => resultHashes,
      poll: (fn) => { relayPoll = fn },
      results: (items) => { pendingResults = items },
      env: (value) => { envPayload = value },
      settings: (fn) => { readSettings = fn },
      key: () => CHANNEL_KEY
    }`,
    );
  const schedule = vi.fn();
  const delays: number[] = [];
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { value: 42 } })));
  const context = {
    process: { env: { RELAY_URL: 'https://relay.test', RELAY_TOKEN: 'a'.repeat(32) }, on: vi.fn() },
    Buffer,
    AbortSignal,
    TextDecoder,
    createHash,
    hkdfSync,
    statSync: () => {
      throw new Error('not found');
    },
    homedir: () => '/isolated',
    hostname: () => 'test-host',
    join: (...parts: string[]) => parts.join('/'),
    fetch: fetcher,
    console,
    setTimeout: (fn: () => void, ms: number) => {
      delays.push(ms);
      queueMicrotask(fn);
      return 1;
    },
    clearTimeout: vi.fn(),
    setImmediate: schedule,
    bridge: {} as {
      tick(): Promise<void>;
      resultsForPoll(items: unknown[]): Array<Record<string, unknown>>;
      rememberResult(cache: unknown, item: unknown): void;
      cache(): unknown;
      runCommand(command: unknown): Promise<Record<string, unknown>>;
      poll(fn: (body: Record<string, unknown>) => Promise<unknown>): void;
      results(items: unknown[]): void;
      env(value: unknown): void;
      settings(fn: () => unknown): void;
      key(): Buffer;
    },
  };
  runInNewContext(source, context);
  return { bridge: context.bridge, schedule, fetcher, delays };
}

describe('bridge transport', () => {
  it('backs off repeated failures within a bounded delay and resets after recovery', async () => {
    const { bridge, delays } = bridgeHarness();
    const poll = vi.fn().mockRejectedValue(new Error('offline'));
    bridge.poll(poll);
    for (let index = 0; index < 30; index++) await bridge.tick();
    expect(delays[0]).toBeGreaterThanOrEqual(4000);
    expect(delays[0]).toBeLessThanOrEqual(6000);
    expect(delays[2]).toBeGreaterThanOrEqual(16000);
    expect(delays.slice(4).every((value) => value >= 48000 && value <= 60000)).toBe(true);
    poll.mockResolvedValueOnce({ intervalMs: 0 });
    await bridge.tick();
    await bridge.tick();
    expect(delays.at(-1)).toBeGreaterThanOrEqual(4000);
    expect(delays.at(-1)).toBeLessThanOrEqual(6000);
  });

  it('rekeys and drops old-machine results when settings change in a running bridge', async () => {
    const { bridge } = bridgeHarness();
    const poll = vi.fn(async (_body: Record<string, unknown>) => ({ intervalMs: 0, wanted: true }));
    bridge.poll(poll);
    bridge.results([{ id: 'old-machine', ok: true, result: 'private old result' }]);
    bridge.settings(() => ({ relayUrl: 'https://other.test', token: 'b'.repeat(32) }));
    await bridge.tick();
    expect(poll.mock.calls[0]?.[0]).toMatchObject({ results: [], events: [], watch: null });
    expect(bridge.key()).toEqual(
      Buffer.from(
        hkdfSync('sha256', Buffer.from('b'.repeat(32)), Buffer.from('mica-relay-v1'), Buffer.from('poll-channel'), 32),
      ),
    );
  });
  it('lets the main loop start the next poll after a command, without spawning another loop', async () => {
    const { bridge, schedule } = bridgeHarness();
    const poll = vi.fn(async (_body: Record<string, unknown>) => ({
      intervalMs: 0,
      commands: [{ id: 'one', channel: 'terminal:get-cwd' }],
    }));
    bridge.poll(poll);
    await bridge.tick();
    expect(schedule).not.toHaveBeenCalled();
    await bridge.tick();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(poll.mock.calls[1]?.[0]).toMatchObject({ results: [{ id: 'one', ok: true, result: { value: 42 } }] });
  });

  it('retries finished command results and environment data after a failed poll', async () => {
    const { bridge, fetcher } = bridgeHarness();
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue({ intervalMs: 0, wanted: true });
    bridge.poll(poll);
    bridge.results([{ id: 'already-executed', ok: true, result: 'done' }]);
    bridge.env({ platform: 'darwin' });
    await bridge.tick();
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0]).toMatchObject({
      results: [{ id: 'already-executed', ok: true, result: 'done' }],
      env: { platform: 'darwin' },
    });
    await bridge.tick();
    expect(poll.mock.calls[2]?.[0]).toMatchObject({ results: [] });
    expect(poll.mock.calls[2]?.[0]).not.toHaveProperty('env');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends complete results again after the relay cache has evicted an old query', async () => {
    const { bridge } = bridgeHarness();
    const poll = vi.fn(async (_body: Record<string, unknown>) => ({ intervalMs: 0, wanted: true }));
    bridge.poll(poll);
    for (let index = 0; index <= 200; index++) {
      bridge.results([await bridge.runCommand({ id: String(index), channel: 'terminal:get-cwd', payload: { index } })]);
      await bridge.tick();
    }
    const recent = await bridge.runCommand({ id: 'recent', channel: 'terminal:get-cwd', payload: { index: 200 } });
    bridge.results([recent]);
    await bridge.tick();
    expect(poll.mock.calls.at(-1)?.[0]).toMatchObject({ results: [{ id: 'recent', unchanged: true }] });
    const old = await bridge.runCommand({ id: 'old', channel: 'terminal:get-cwd', payload: { index: 0 } });
    bridge.results([old]);
    await bridge.tick();
    expect(poll.mock.calls.at(-1)?.[0]).toMatchObject({ results: [{ id: 'old', result: { value: 42 } }] });
  });

  it('deduplicates same-query results in send order even when the second request finishes first', async () => {
    const { bridge, fetcher } = bridgeHarness();
    let finishSlow!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSlow = resolve;
        }),
    );
    const commands = ['slow', 'fast'].map((id) => ({ id, channel: 'terminal:get-cwd' }));
    const poll = vi.fn(async (_body: Record<string, unknown>) => ({
      intervalMs: 0,
      wanted: true,
      commands: [] as unknown[],
    }));
    poll.mockResolvedValueOnce({ intervalMs: 0, wanted: true, commands });
    bridge.poll(poll);
    const executing = bridge.tick();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    finishSlow(new Response(JSON.stringify({ ok: true, result: { value: 42 } })));
    await executing;
    await bridge.tick();

    expect(poll.mock.calls[1]?.[0]).toMatchObject({
      results: [
        { id: 'slow', result: { value: 42 } },
        { id: 'fast', unchanged: true },
      ],
    });
  });

  it('keeps full results for a retry after a compressed poll fails', async () => {
    const { bridge } = bridgeHarness();
    const poll = vi.fn(async (_body: Record<string, unknown>) => ({ intervalMs: 0, wanted: true }));
    bridge.poll(poll);
    const command = { channel: 'terminal:get-cwd', payload: {} };
    bridge.results([await bridge.runCommand({ ...command, id: 'first' })]);
    await bridge.tick();
    bridge.results([await bridge.runCommand({ ...command, id: 'second' })]);
    poll.mockRejectedValueOnce(new Error('lost response'));
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0]).toMatchObject({ results: [{ id: 'second', unchanged: true }] });

    await bridge.tick();

    expect(poll.mock.calls[2]?.[0]).toMatchObject({ results: [{ id: 'second', result: { value: 42 } }] });
  });

  it('reports a relay cache miss instead of successfully returning null', () => {
    const source = readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('function resolveResult(');
    const end = source.indexOf('\n/*', start);
    const resolveResult = runInNewContext(`${source.slice(start, end)}; resolveResult`, {
      cacheKey: (channel: unknown, payload: unknown) => JSON.stringify([channel, payload]),
      RESULT_CACHE_LIMIT: 200,
    }) as (state: { resultCache: Map<string, unknown> }, item: unknown) => unknown;
    const state = { resultCache: new Map<string, unknown>() };
    expect(resolveResult(state, { ok: true, unchanged: true, hash: 'unknown', channel: 'test' })).toMatchObject({
      ok: false,
    });
    expect(state.resultCache.size).toBe(0);
  });
});

describe('bridge and relay cache pressure', () => {
  it('bounds retained result bytes and keeps deduplication consistent after eviction', () => {
    const { bridge } = bridgeHarness();
    const source = readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('function resolveResult(');
    const end = source.indexOf('\n/*', start);
    const resolveResult = runInNewContext(`${source.slice(start, end)}; resolveResult`, {
      cacheKey: (channel: unknown, payload: unknown) => `${channel}\u0000${JSON.stringify(payload ?? {})}`,
      RESULT_CACHE_LIMIT: 200,
      RESULT_CACHE_BYTES: 4 * 1024 * 1024,
      Buffer,
    }) as (
      state: { resultCache: Map<string, { value: unknown }>; resultCacheBytes: number },
      item: unknown,
    ) => { ok: boolean; result: unknown };
    const state = { resultCache: new Map<string, { value: unknown }>(), resultCacheBytes: 0 };
    const result = 'x'.repeat(256 * 1024);
    let largest = 0;
    for (let index = 0; index < 80; index++) {
      // Repeated keys interspersed with new keys check that both ends evict in the same order.
      const key = index % 4 === 0 ? Math.floor(index / 4) : index;
      const item = { id: String(index), channel: 'files:read', payload: { key }, ok: true, hash: 'same', result };
      const [sent] = bridge.resultsForPoll([item]);
      expect(resolveResult(state, sent)).toEqual({ ok: true, result });
      bridge.rememberResult(bridge.cache(), sent);
      const retained = [...state.resultCache.values()].reduce(
        (sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value)),
        0,
      );
      largest = Math.max(largest, retained);
    }
    console.info(
      JSON.stringify({
        sample: 'relay-result-cache',
        inputs: 80,
        valueBytes: result.length,
        peakRetainedValueBytes: largest,
      }),
    );
    expect(largest).toBeLessThanOrEqual(4 * 1024 * 1024);
    const oldest = { channel: 'files:read', payload: { key: 0 }, ok: true, hash: 'same', result };
    expect(bridge.resultsForPoll([oldest])[0]).not.toHaveProperty('unchanged');
    // Count UTF-8 bytes, including multibyte results. A single oversized result
    // must still arrive intact and remain a full result on the next request.
    const oversized = { ...oldest, payload: { key: 'huge' }, hash: 'huge', result: '界'.repeat(1_500_000) };
    for (let repeat = 0; repeat < 2; repeat++) {
      const [sent] = bridge.resultsForPoll([oversized]);
      expect(sent).not.toHaveProperty('unchanged');
      expect(resolveResult(state, sent)).toEqual({ ok: true, result: oversized.result });
      bridge.rememberResult(bridge.cache(), sent);
      expect(state.resultCacheBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });
});

afterEach(() => vi.useRealTimers());

describe('bridge request deadlines', () => {
  function transportHarness() {
    const source = readFileSync(new URL('./agent/bridge.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('function postBinary(');
    const end = source.indexOf('async function relayPoll(', start);
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const request = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      destroy: vi.fn((error: Error) => {
        request.emit('error', error);
        request.emit('close');
      }),
    });
    const send = (_options: unknown, receive: (response: EventEmitter) => void) => {
      receive(response);
      return request;
    };
    const post = runInNewContext(`${source.slice(start, end)}; postBinary`, {
      URL,
      Buffer,
      httpRequest: send,
      httpsRequest: send,
      settings: { verifyTls: true },
      setTimeout,
      clearTimeout,
    }) as (url: string, body: Buffer) => Promise<unknown>;
    return { post, response, request };
  }

  it('ends a continuously dripping response at the total deadline and releases its timer', async () => {
    vi.useFakeTimers();
    const { post, response, request } = transportHarness();
    const result = post('https://relay.test/poll', Buffer.from('body')).catch((error: Error) => error);
    for (let index = 0; index < 3; index++) {
      response.emit('data', Buffer.from('still active'));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(await result).toHaveProperty('message', expect.stringContaining('deadline'));
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops retaining an oversized response and clears the deadline on request closure', async () => {
    vi.useFakeTimers();
    const { post, response, request } = transportHarness();
    const result = post('https://relay.test/poll', Buffer.from('body')).catch((error: Error) => error);
    response.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    expect(await result).toHaveProperty('message', expect.stringContaining('too large'));
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { EventEmitter } from 'node:events';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
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
      pending: () => pendingResults,
      active: () => activeCommands.size,
      limit: MAX_ACTIVE_COMMANDS,
      pushing: () => pushRunning,
      cache: () => resultHashes,
      poll: (fn) => { relayPoll = fn },
      push: (fn) => { relayPush = fn },
      results: (items) => { pendingResults = items },
      env: (value) => { envPayload = value },
      settings: (fn) => { readSettings = fn },
      key: () => CHANNEL_KEY,
      pushEvent: (frame) => pushEvent(frame),
      wanted: (value) => { wanted = value }
    }`,
    );
  const schedule = vi.fn();
  const delays: number[] = [];
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { value: 42 } })));
  const context = {
    process: { env: { RELAY_URL: 'https://relay.test', RELAY_TOKEN: 'a'.repeat(32) }, on: vi.fn() },
    Buffer,
    AbortController,
    AbortSignal,
    TextDecoder,
    createHash,
    hkdfSync,
    randomBytes,
    createRequestLogger: () => ({ record() {}, close: async () => {} }),
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
      pending(): Array<Record<string, unknown>>;
      active(): number;
      limit: number;
      pushing(): boolean;
      resultsForPoll(items: unknown[]): Array<Record<string, unknown>>;
      rememberResult(cache: unknown, item: unknown): void;
      cache(): unknown;
      runCommand(command: unknown): Promise<Record<string, unknown>>;
      poll(fn: (body: Record<string, unknown>) => Promise<unknown>): void;
      push(fn: (body: Record<string, unknown>) => Promise<unknown>): void;
      results(items: unknown[]): void;
      env(value: unknown): void;
      settings(fn: () => unknown): void;
      key(): Buffer;
      pushEvent(frame: unknown): void;
      wanted(value: boolean): void;
    },
  };
  runInNewContext(source, context);
  context.bridge.push(async () => ({ status: 200, body: Buffer.alloc(0) }));
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
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(1));
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

  it('sends a fast result before the slow query finishes and deduplicates in actual send order', async () => {
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
    await bridge.tick();
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(1));
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0]).toMatchObject({
      results: [{ id: 'fast', result: { value: 42 } }],
    });
    expect(bridge.active()).toBe(1);
    finishSlow(new Response(JSON.stringify({ ok: true, result: { value: 42 } })));
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(1));
    await bridge.tick();
    expect(poll.mock.calls[2]?.[0]).toMatchObject({
      results: [{ id: 'slow', unchanged: true }],
    });
  });

  it('receives terminal input and abort commands while a slow command is still running', async () => {
    const { bridge, fetcher } = bridgeHarness();
    let finishSlow!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSlow = resolve;
        }),
    );
    const poll = vi
      .fn()
      .mockResolvedValue({ intervalMs: 0, wanted: true })
      .mockResolvedValueOnce({ intervalMs: 0, wanted: true, commands: [{ id: 'slow', channel: 'files:read' }] })
      .mockResolvedValueOnce({
        intervalMs: 0,
        wanted: true,
        commands: [
          { id: 'write', channel: 'terminal:write', payload: { data: 'x' } },
          { id: 'abort', channel: 'chat:abort' },
        ],
      });
    bridge.poll(poll);
    await bridge.tick();
    await bridge.tick();
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(2));
    expect(
      fetcher.mock.calls
        .slice(1)
        .map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).channel),
    ).toEqual(['terminal:write', 'chat:abort']);
    await bridge.tick();
    expect(poll.mock.calls[2]?.[0].results.map((item: { id: string }) => item.id)).toEqual(['write', 'abort']);
    expect(bridge.active()).toBe(1);
    finishSlow(new Response(JSON.stringify({ ok: true, result: 'done' })));
    await vi.waitFor(() => expect(bridge.active()).toBe(0));
  });

  it('bounds active commands, reports busy for overflow, and releases capacity after failure', async () => {
    const { bridge, fetcher } = bridgeHarness();
    const fail: Array<(error: Error) => void> = [];
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((_resolve, reject) => {
          fail.push(reject);
        }),
    );
    const commands = Array.from({ length: bridge.limit + 3 }, (_, id) => ({ id: String(id), channel: 'files:read' }));
    const poll = vi
      .fn()
      .mockResolvedValue({ intervalMs: 0, wanted: true })
      .mockResolvedValueOnce({ intervalMs: 0, wanted: true, commands });
    bridge.poll(poll);
    await bridge.tick();
    expect(bridge.active()).toBe(bridge.limit);
    expect(fetcher).toHaveBeenCalledTimes(bridge.limit);
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0].results).toEqual(
      commands.slice(bridge.limit).map(({ id }) => ({
        id,
        ok: false,
        status: 429,
        error: expect.stringContaining('busy'),
      })),
    );
    for (const reject of fail) reject(new Error('local offline'));
    await vi.waitFor(() => expect(bridge.active()).toBe(0));
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: 'recovered' })));
    poll.mockResolvedValueOnce({ intervalMs: 0, wanted: true, commands: [{ id: 'next', channel: 'terminal:write' }] });
    await bridge.tick();
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(1));
    await bridge.tick();
    expect(poll.mock.calls.at(-1)?.[0]).toMatchObject({ results: [{ id: 'next', ok: true, result: 'recovered' }] });
  });

  it('discards old-generation completions without releasing their concurrency slots early', async () => {
    const { bridge, fetcher } = bridgeHarness();
    let finishOld!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = resolve;
        }),
    );
    const poll = vi
      .fn()
      .mockResolvedValue({ intervalMs: 0, wanted: true })
      .mockResolvedValueOnce({ intervalMs: 0, wanted: true, commands: [{ id: 'old', channel: 'files:read' }] });
    bridge.poll(poll);
    await bridge.tick();
    bridge.settings(() => ({ relayUrl: 'https://other.test', token: 'b'.repeat(32) }));
    await bridge.tick();
    expect(bridge.active()).toBe(1);
    finishOld(new Response(JSON.stringify({ ok: true, result: 'private' })));
    await vi.waitFor(() => expect(bridge.active()).toBe(0));
    expect(bridge.pending()).toHaveLength(0);
    await bridge.tick();
    expect(poll.mock.calls.at(-1)?.[0]).toMatchObject({ results: [] });
  });

  it('retries in-flight poll results before newer completions after the poll fails', async () => {
    const { bridge, fetcher } = bridgeHarness();
    let finishSlow!: (value: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSlow = resolve;
        }),
    );
    let failPoll!: (error: Error) => void;
    const poll = vi
      .fn()
      .mockResolvedValue({ intervalMs: 0, wanted: true })
      .mockResolvedValueOnce({
        intervalMs: 0,
        wanted: true,
        commands: [
          { id: 'slow', channel: 'terminal:get-cwd' },
          { id: 'fast', channel: 'terminal:get-cwd' },
        ],
      })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failPoll = reject;
          }),
      );
    bridge.poll(poll);
    await bridge.tick();
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(1));
    const sending = bridge.tick();
    finishSlow(new Response(JSON.stringify({ ok: true, result: { value: 42 } })));
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(1));
    failPoll(new Error('lost poll response'));
    await sending;
    await bridge.tick();
    expect(poll.mock.calls[2]?.[0]).toMatchObject({
      results: [
        { id: 'fast', result: { value: 42 } },
        { id: 'slow', unchanged: true },
      ],
    });
    expect(bridge.active()).toBe(0);
  });

  it('reschedules wake notifications when another command completes during a push', async () => {
    const { bridge, fetcher } = bridgeHarness();
    let finishSecond!: (value: Response) => void;
    fetcher
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, result: 'first' })))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishSecond = resolve;
          }),
      );
    let finishPush!: (value: unknown) => void;
    const push = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPush = resolve;
          }),
      )
      .mockResolvedValue({ status: 200 });
    bridge.push(push);
    bridge.poll(
      vi.fn().mockResolvedValueOnce({
        intervalMs: 0,
        wanted: true,
        commands: [
          { id: 'first', channel: 'files:read' },
          { id: 'second', channel: 'terminal:get-cwd' },
        ],
      }),
    );
    await bridge.tick();
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    finishSecond(new Response(JSON.stringify({ ok: true, result: 'second' })));
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(2));
    expect(push).toHaveBeenCalledTimes(1);
    finishPush({ status: 200 });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push.mock.calls.map(([body]) => body)).toEqual([
      { events: [], wake: true },
      { events: [], wake: true },
    ]);
  });

  it('falls back to poll for results after a failed wake push without retrying in a tight loop', async () => {
    const { bridge } = bridgeHarness();
    const push = vi.fn().mockRejectedValue(new Error('offline'));
    const poll = vi
      .fn()
      .mockResolvedValue({ intervalMs: 0, wanted: true })
      .mockResolvedValueOnce({ intervalMs: 0, wanted: true, commands: [{ id: 'one', channel: 'files:read' }] });
    bridge.push(push);
    bridge.poll(poll);
    await bridge.tick();
    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledTimes(1);
      expect(bridge.pushing()).toBe(false);
    });
    expect(bridge.pending()).toHaveLength(1);
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0]).toMatchObject({ results: [{ id: 'one', ok: true }] });
    expect(push).toHaveBeenCalledTimes(1);
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

  it('replaces an oversized UTF-8 result with an error without blocking small results or new commands', async () => {
    const { bridge, fetcher } = bridgeHarness();
    const poll = vi
      .fn()
      .mockResolvedValue({ intervalMs: 0, wanted: true })
      .mockResolvedValueOnce({
        intervalMs: 0,
        wanted: true,
        commands: [{ id: 'next', channel: 'terminal:write' }],
      });
    bridge.poll(poll);
    bridge.results([
      {
        id: 'huge',
        channel: 'files:read',
        payload: { path: 'private' },
        ok: true,
        result: '界'.repeat(6 * 1024 * 1024),
      },
      { id: 'small', ok: true, result: 'small' },
    ]);
    await bridge.tick();
    expect(poll.mock.calls[0]?.[0].results).toEqual([
      { id: 'huge', ok: false, status: 413, error: expect.stringContaining('too large') },
      { id: 'small', ok: true, result: 'small' },
    ]);
    await vi.waitFor(() => expect(bridge.pending()).toHaveLength(1));
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0]).toMatchObject({ results: [{ id: 'next', ok: true, result: { value: 42 } }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('splits result batches by raw JSON bytes and drains remaining results without sleeping', async () => {
    const { bridge, delays } = bridgeHarness();
    const poll = vi.fn().mockResolvedValue({ intervalMs: 300, wanted: true });
    bridge.poll(poll);
    const result = 'x'.repeat(10 * 1024 * 1024);
    bridge.results([
      { id: 'first', ok: true, result },
      { id: 'second', ok: true, result },
      { id: 'small', ok: true, result: 'done' },
    ]);
    await bridge.tick();
    expect(poll.mock.calls[0]?.[0].results.map((item: { id: string }) => item.id)).toEqual(['first']);
    expect(bridge.pending()).toHaveLength(2);
    expect(delays).toEqual([]);
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0].results.map((item: { id: string }) => item.id)).toEqual(['second', 'small']);
    expect(bridge.pending()).toHaveLength(0);
    for (const [body] of poll.mock.calls) {
      expect(Buffer.byteLength(JSON.stringify(body.results))).toBeLessThanOrEqual(18 * 1024 * 1024);
    }
  });

  it('pushes a local event immediately instead of waiting for the parked poll', async () => {
    const { bridge } = bridgeHarness();
    bridge.wanted(true);
    // 轮询永远挂起：事件不能再指望它捎带，只能走独立的上行。
    const poll = vi.fn(() => new Promise<never>(() => {}));
    const push = vi.fn(async (_body: Record<string, unknown>) => ({ status: 200, body: Buffer.alloc(0) }));
    bridge.poll(poll);
    bridge.push(push);

    void bridge.tick();
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    bridge.pushEvent({ channel: 'terminal:data', payload: { data: 'a' } });

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push.mock.calls[0]?.[0]).toMatchObject({
      events: [{ channel: 'terminal:data', payload: { data: 'a' } }],
    });
  });

  it('falls back to the poll when the event push fails', async () => {
    const { bridge } = bridgeHarness();
    bridge.wanted(true);
    const poll = vi.fn(async (_body: Record<string, unknown>) => ({ intervalMs: 0, wanted: true }));
    const push = vi.fn(async (_body: Record<string, unknown>) => {
      throw new Error('offline');
    });
    bridge.poll(poll);
    bridge.push(push);

    await bridge.tick();
    bridge.pushEvent({ channel: 'terminal:data', payload: { data: 'a' } });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));

    // The retry retains the original immutable batch and identity.
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0]).toMatchObject({
      eventBatchId: push.mock.calls[0]?.[0].eventBatchId,
      events: [{ channel: 'terminal:data', payload: { data: 'a' } }],
    });
  });

  it('does not let a poll or a newer event overtake an in-flight push', async () => {
    const { bridge } = bridgeHarness();
    bridge.wanted(true);
    let finishPush!: (value: unknown) => void;
    const push = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPush = resolve;
          }),
      )
      .mockResolvedValue({ status: 200 });
    const poll = vi.fn().mockResolvedValue({ intervalMs: 0, wanted: true });
    bridge.push(push);
    bridge.poll(poll);
    bridge.pushEvent({ channel: 'terminal:data', payload: 'first' });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    bridge.pushEvent({ channel: 'terminal:data', payload: 'second' });
    bridge.results([{ id: 'result', ok: true, result: 'ready' }]);
    await bridge.tick();
    expect(poll.mock.calls[0]?.[0]).toMatchObject({ events: [], results: [{ id: 'result' }] });
    expect(poll.mock.calls[0]?.[0]).not.toHaveProperty('eventBatchId');
    expect(push).toHaveBeenCalledTimes(1);
    finishPush({ status: 200 });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push.mock.calls[1]?.[0]).toMatchObject({ events: [{ payload: 'second' }] });
    expect(push.mock.calls[1]?.[0].eventBatchId).not.toBe(push.mock.calls[0]?.[0].eventBatchId);
  });

  it('retains the same batch across repeated poll failures without merging newer events', async () => {
    const { bridge } = bridgeHarness();
    bridge.wanted(true);
    const push = vi.fn().mockRejectedValue(new Error('lost push acknowledgement'));
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('poll offline'))
      .mockRejectedValueOnce(new Error('poll still offline'))
      .mockResolvedValue({ intervalMs: 0, wanted: true });
    bridge.push(push);
    bridge.poll(poll);
    bridge.pushEvent({ channel: 'terminal:data', payload: 'first' });
    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledTimes(1);
      expect(bridge.pushing()).toBe(false);
    });
    bridge.pushEvent({ channel: 'terminal:data', payload: 'second' });
    await bridge.tick();
    await bridge.tick();
    await bridge.tick();
    const original = push.mock.calls[0]?.[0];
    for (const [body] of poll.mock.calls) {
      expect(body).toMatchObject({ eventBatchId: original.eventBatchId, events: original.events });
      expect(body.events).toBe(original.events);
    }
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push.mock.calls[1]?.[0]).toMatchObject({ events: [{ payload: 'second' }] });
  });

  it('ignores an old push callback after an identity switch', async () => {
    const { bridge } = bridgeHarness();
    bridge.wanted(true);
    let failOld!: (error: Error) => void;
    let finishNew!: (value: unknown) => void;
    const push = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failOld = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      );
    const poll = vi.fn().mockResolvedValue({ intervalMs: 0, wanted: true });
    bridge.push(push);
    bridge.poll(poll);
    bridge.pushEvent({ channel: 'terminal:data', payload: 'old' });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    bridge.settings(() => ({ relayUrl: 'https://other.test', token: 'b'.repeat(32) }));
    await bridge.tick();
    bridge.pushEvent({ channel: 'terminal:data', payload: 'new' });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    failOld(new Error('late old failure'));
    await Promise.resolve();
    expect(bridge.pushing()).toBe(true);
    await bridge.tick();
    expect(poll.mock.calls.at(-1)?.[0]).toMatchObject({ events: [] });
    finishNew({ status: 200 });
    await vi.waitFor(() => expect(bridge.pushing()).toBe(false));
  });

  it('leaves a relay cache miss unresolved for a full-result retry', () => {
    const source = readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('function resolveResult(');
    const end = source.indexOf('\n/*', start);
    const resolveResult = runInNewContext(`${source.slice(start, end)}; resolveResult`, {
      cacheKey: (channel: unknown, payload: unknown) => JSON.stringify([channel, payload]),
      RESULT_CACHE_LIMIT: 200,
    }) as (state: { resultCache: Map<string, unknown> }, item: unknown) => unknown;
    const state = { resultCache: new Map<string, unknown>() };
    expect(resolveResult(state, { ok: true, unchanged: true, hash: 'unknown', channel: 'test' })).toBe(null);
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

describe('relay result wake notifications', () => {
  function wakeHarness() {
    const source = readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');
    const state = {
      key: Buffer.alloc(32),
      label: 'test',
      lastPollAt: Date.now(),
      lastPollTs: 0,
      commands: [],
      pending: new Map(),
      phones: new Set(),
      awakeUntil: 0,
      resultWakePending: false,
      retryResultIds: new Set<string>(),
      resultCache: new Map(),
      resultCacheBytes: 0,
      seenEventBatches: new Set<string>(),
      parked: null as null | { res: unknown },
    };
    const broadcast = vi.fn();
    const handlers = runInNewContext(
      `${source.slice(source.indexOf('function resolveResult('), source.indexOf('\n/*', source.indexOf('function resolveResult(')))}
      ${source.slice(source.indexOf('function acceptEvents('), source.indexOf('function handleEvents('))}; ({ handlePoll, handlePush })`,
      {
        openAny: (body: unknown) => ({ state, body }),
        readRaw: async (body: unknown) => body,
        sendJson: (res: { end: (body: string) => void }, _status: number, body: unknown) =>
          res.end(JSON.stringify(body)),
        seal: (_key: unknown, body: unknown) => Buffer.from(JSON.stringify(body)),
        phoneOnline: () => true,
        persistAgents: vi.fn(),
        broadcastEvents: broadcast,
        cacheKey: (channel: unknown, payload: unknown) => `${channel}\u0000${JSON.stringify(payload ?? {})}`,
        RESULT_CACHE_LIMIT: 200,
        RESULT_CACHE_BYTES: 4 * 1024 * 1024,
        Buffer,
        AGENT_STALE_MS: 45_000,
        REPLAY_WINDOW_MS: 120_000,
        Date,
        setTimeout,
        clearTimeout,
      },
    ) as {
      handlePoll(req: unknown, res: unknown): Promise<void>;
      handlePush(req: unknown, res: unknown): Promise<void>;
    };
    const response = () =>
      Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn(), writableEnded: false });
    const push = () => handlers.handlePush({ ts: Date.now(), wake: true }, response());
    const poll = async () => {
      const res = response();
      await handlers.handlePoll({ ts: Date.now(), results: [] }, res);
      return res;
    };
    return { state, push, poll, handlers, response, broadcast };
  }

  it('remembers an early wake until the next poll and consumes it exactly once', async () => {
    vi.useFakeTimers();
    const { state, push, poll } = wakeHarness();
    await push();
    expect(state.resultWakePending).toBe(true);
    const immediate = await poll();
    expect(immediate.end).toHaveBeenCalledTimes(1);
    expect(JSON.parse(immediate.end.mock.calls[0]?.[0].toString())).toMatchObject({ intervalMs: 0 });
    expect(state.resultWakePending).toBe(false);
    const parked = await poll();
    expect(parked.end).not.toHaveBeenCalled();
    expect(state.parked?.res).toBe(parked);
    parked.emit('close');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers a post-restart unchanged miss after wake without resolving early or executing again', async () => {
    const { state, push, handlers, response } = wakeHarness();
    const { bridge, fetcher, delays } = bridgeHarness();
    const item = await bridge.runCommand({ id: 'finished', channel: 'terminal:get-cwd' });
    bridge.rememberResult(bridge.cache(), item);
    bridge.results([item]);
    const resolve = vi.fn();
    state.pending.set('finished', { resolve });
    state.lastPollAt = 0;
    await push();
    const replies: Array<Record<string, unknown>> = [];
    const poll = vi.fn(async (body: Record<string, unknown>) => {
      const res = response();
      await handlers.handlePoll({ ...body, ts: Date.now() }, res);
      expect(res.end).toHaveBeenCalledTimes(1);
      const reply = JSON.parse(res.end.mock.calls[0]?.[0].toString());
      replies.push(reply);
      return reply;
    });
    bridge.poll(poll);
    await bridge.tick();
    expect(poll.mock.calls[0]?.[0]).toMatchObject({ results: [{ id: 'finished', unchanged: true }] });
    expect(replies[0]).toMatchObject({ resetCache: false, intervalMs: 0, retryResultIds: ['finished'] });
    expect(resolve).not.toHaveBeenCalled();
    expect(state.pending.has('finished')).toBe(true);
    expect(state.retryResultIds.size).toBe(0);
    expect(bridge.pending()).toEqual([item]);
    expect(delays).toEqual([]);
    await bridge.tick();
    expect(poll.mock.calls[1]?.[0]).toMatchObject({ results: [{ id: 'finished', result: { value: 42 } }] });
    const fullResults = poll.mock.calls[1]?.[0].results as Array<Record<string, unknown>>;
    expect(fullResults[0]).not.toHaveProperty('unchanged');
    expect(replies[1]).toMatchObject({ intervalMs: 0, retryResultIds: [] });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ ok: true, result: { value: 42 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('releases a parked poll on wake without leaving another pending wake', async () => {
    vi.useFakeTimers();
    const { state, push, poll } = wakeHarness();
    const parked = await poll();
    expect(parked.end).not.toHaveBeenCalled();
    await push();
    expect(parked.end).toHaveBeenCalledTimes(1);
    expect(state.parked).toBe(null);
    expect(state.resultWakePending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const next = await poll();
    expect(next.end).not.toHaveBeenCalled();
    next.emit('close');
  });

  it('broadcasts once after a lost push acknowledgement and still processes poll results and commands', async () => {
    const { state, handlers, response, broadcast } = wakeHarness();
    const events = [{ channel: 'terminal:data', payload: 'one output' }];
    const body = { ts: Date.now(), eventBatchId: 'startup-1', events };
    await handlers.handlePush(body, response());
    const resolve = vi.fn();
    state.pending.set('result', { resolve });
    (state.commands as unknown[]).push({ id: 'next', channel: 'terminal:write' });
    const retry = response();
    await handlers.handlePoll({ ...body, results: [{ id: 'result', ok: true }] }, retry);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(JSON.parse(retry.end.mock.calls[0]?.[0].toString())).toMatchObject({ commands: [{ id: 'next' }] });
    await handlers.handlePush({ ...body, wake: true }, response());
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(state.resultWakePending).toBe(true);
  });

  it('bounds seen batches to the most recent 256 and drops missing or invalid batch identities', async () => {
    const { state, handlers, response, broadcast } = wakeHarness();
    const events = [{ channel: 'terminal:data', payload: 'event' }];
    for (const eventBatchId of [undefined, '', 'x'.repeat(97), '../bad', 42]) {
      await handlers.handlePush({ ts: Date.now(), eventBatchId, events }, response());
    }
    expect(broadcast).not.toHaveBeenCalled();
    for (let index = 0; index < 257; index++) {
      await handlers.handlePush({ ts: Date.now(), eventBatchId: `boot-${index}`, events }, response());
    }
    expect(state.seenEventBatches.size).toBe(256);
    expect(state.seenEventBatches.has('boot-0')).toBe(false);
    expect(state.seenEventBatches.has('boot-1')).toBe(true);
    await handlers.handlePush({ ts: Date.now(), eventBatchId: 'boot-256', events }, response());
    expect(broadcast).toHaveBeenCalledTimes(257);
  });
});

// 与 bridge.mjs 的 MAX_POLL_RESPONSE_BYTES 一致：手机贴的截图要能过，别的一律截断。
const POLL_RESPONSE_LIMIT = 24 * 1024 * 1024;

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
    response.emit('data', Buffer.alloc(POLL_RESPONSE_LIMIT + 1));
    expect(await result).toHaveProperty('message', expect.stringContaining('too large'));
    expect(request.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

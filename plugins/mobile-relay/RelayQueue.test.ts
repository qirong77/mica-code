import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

function queueHarness() {
  const source = readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function invokeRemote(');
  const end = source.indexOf('function resolveResult(', start);
  const state = { label: 'test', pending: new Map(), commands: [] as Array<{ id: string }> };
  const invoke = runInNewContext(`${source.slice(start, end)}; invokeRemote`, {
    agentOnline: () => true,
    INVOKE_TIMEOUT_MS: 90_000,
    MAX_PENDING_CALLS: 128,
    randomBytes,
    Date,
    setTimeout,
    clearTimeout,
    wakePoll: vi.fn(),
  }) as (state: unknown, channel: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
  return { state, invoke };
}

afterEach(() => vi.useRealTimers());

describe('relay command queue', () => {
  it('removes commands that time out before being sent to the bridge', async () => {
    vi.useFakeTimers();
    const { state, invoke } = queueHarness();
    const result = invoke(state, 'terminal:write', { data: 'expired input' });
    expect(state.commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await result).toMatchObject({ ok: false, status: 504 });
    expect(state.pending.size).toBe(0);
    expect(state.commands).toHaveLength(0);
  });

  it('removes abandoned calls and releases their timeout timers', async () => {
    vi.useFakeTimers();
    const { state, invoke } = queueHarness();
    const controller = new AbortController();
    const result = invoke(state, 'chat:start', {}, controller.signal);
    controller.abort();
    expect(await result).toMatchObject({ ok: false });
    expect(state.pending.size).toBe(0);
    expect(state.commands).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds pending calls and command timers during a burst, then fully recovers', async () => {
    vi.useFakeTimers();
    const { state, invoke } = queueHarness();
    const requests = Array.from({ length: 2000 }, () => invoke(state, 'terminal:get-cwd', {}));
    expect(state.pending.size).toBeLessThanOrEqual(128);
    expect(state.commands.length).toBeLessThanOrEqual(128);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(128);
    await vi.advanceTimersByTimeAsync(90_000);
    const results = await Promise.all(requests);
    expect(results.filter((value) => (value as { status: number }).status === 429)).toHaveLength(1872);
    expect(state.pending.size).toBe(0);
    expect(state.commands).toHaveLength(0);
    const next = invoke(state, 'terminal:get-cwd', {});
    const [id, pending] = state.pending.entries().next().value!;
    state.pending.delete(id);
    pending.resolve({ ok: true, result: 'recovered' });
    expect(await next).toMatchObject({ ok: true, result: 'recovered' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('keeps commands queued after a settings reload and a completed parked poll', () => {
  vi.useFakeTimers();
  const source = readFileSync(new URL('./relay/relay.mjs', import.meta.url), 'utf8');
  const parked = source.slice(source.indexOf('function parkWait('), source.indexOf('function handleEvents('));
  const reload = source.slice(source.indexOf('function reloadAgents('), source.indexOf('setInterval(reloadAgents'));
  const state = {
    token: 'a'.repeat(32),
    label: 'test',
    phones: new Set(),
    commands: [] as Array<{ id: string }>,
    awakeUntil: 0,
  };
  const agents = new Map([[state.token, state]]);
  const functions = runInNewContext(`${parked}\n${reload}; ({ parkPoll, wakePoll, reloadAgents })`, {
    agents,
    agentsMtime: 0,
    AGENTS_FILE: '/isolated/agents.json',
    AWAKE_MS: 20_000,
    statSync: () => ({ mtimeMs: 1 }),
    readFileSync: () => JSON.stringify({ agents: [{ token: state.token, label: 'renamed' }] }),
    phoneOnline: () => false,
    seal: (_key: unknown, body: unknown) => Buffer.from(JSON.stringify(body)),
    setTimeout,
    clearTimeout,
    console,
  }) as {
    parkPoll(res: unknown, state: unknown, reset: boolean): void;
    wakePoll(state: unknown): void;
    reloadAgents(): void;
  };
  const response = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() });
  functions.parkPoll(response, state, false);
  functions.reloadAgents();
  const current = agents.get(state.token)!;
  current.commands.push({ id: 'first' });
  functions.wakePoll(current);
  expect(response.end).toHaveBeenCalledTimes(1);
  // A second command arriving before the bridge's next poll must remain queued.
  current.commands.push({ id: 'second' });
  functions.wakePoll(current);
  expect(current.commands).toEqual([{ id: 'second' }]);
  expect(vi.getTimerCount()).toBe(0);
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidecarRegistry, type SidecarRegistryOptions } from './registry.js';
import { SidecarTranscript } from './transcript.js';

const startMock = vi.hoisted(() => vi.fn());

// 起进程这一步换掉：这里测的是「登记表怎么把子会话自己的事记成事件」，
// 不需要真的起一个 mica app-server。
vi.mock('./sidecarProcess.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sidecarProcess.js')>();
  return { ...actual, SidecarProcess: Object.assign(vi.fn(), { start: startMock }) };
});

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

type FakeProcess = {
  sessionId: string;
  cwd: string;
  closed: boolean;
  transcript: SidecarTranscript;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  describeFailure: () => string;
  subscribe: (listener: () => void) => () => void;
  waitForChange: () => Promise<boolean>;
};

/** 一个够真的子进程：转录是真的，通知（变化）由测试手动 emit。 */
function makeProcess(id: string): { process: FakeProcess; transcript: SidecarTranscript; emit: () => void } {
  const transcript = new SidecarTranscript();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const process: FakeProcess = {
    sessionId: id,
    cwd: '/tmp',
    closed: false,
    transcript,
    send: vi.fn(async () => ({ queued: false })),
    close: vi.fn(async () => {
      process.closed = true;
      emit();
    }),
    abort: vi.fn(async () => true),
    describeFailure: () => 'mica app-server 已退出（code 1）',
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitForChange: async () => false,
  };
  return { process, transcript, emit };
}

function makeRegistry(
  options: SidecarRegistryOptions = {},
  extra: Record<string, unknown> = {},
) {
  return new SidecarRegistry(
    { logger: noopLogger, health: { report() {} }, ...extra } as never,
    'parent',
    '/tmp',
    () => undefined,
    options,
  );
}

/** 起一个假子会话并返回它的条目与进程；父会话这一侧看到的就是 `sidecar_spawn` 之后的状态。 */
async function spawnFake(registry: SidecarRegistry, process: FakeProcess) {
  startMock.mockResolvedValue(process);
  const result = await registry.spawn({ prompt: '跑一遍测试' });
  if (!result.ok) throw new Error(result.error);
  return result.entry;
}

function finishTurn(transcript: SidecarTranscript, emit: () => void, text = '全部通过') {
  transcript.apply({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
  transcript.apply({ method: 'item/agentMessage/delta', params: { delta: text } });
  transcript.apply({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  emit();
}

beforeEach(() => {
  startMock.mockReset();
});

describe('sidecar events', () => {
  it('records a finished turn with its status and tail', async () => {
    const registry = makeRegistry();
    const { process, transcript, emit } = makeProcess('child-1');
    await spawnFake(registry, process);

    finishTurn(transcript, emit);
    const events = registry.takeEventsForPrompt();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 'child-1', kind: 'turn' });
    expect(events[0]?.summary).toContain('完成');
    expect(events[0]?.summary).toContain('全部通过');
    // 读一次就清：下一轮 prompt 里不该再出现同一条。
    expect(registry.takeEventsForPrompt()).toHaveLength(0);
  });

  it('reports a process exit once, with the reason', async () => {
    const registry = makeRegistry();
    const { process, emit } = makeProcess('child-2');
    await spawnFake(registry, process);

    process.closed = true;
    emit();
    emit();
    const events = registry.takeEventsForPrompt();
    expect(events.filter((event) => event.kind === 'exit')).toHaveLength(1);
    expect(events.at(-1)?.detail).toContain('已退出');
  });

  it('notifies a stall once per turn instead of every tick', async () => {
    let now = 1_000_000;
    const registry = makeRegistry({ stallMs: 60_000, now: () => now });
    const { process, transcript } = makeProcess('child-4');
    await spawnFake(registry, process);
    transcript.apply({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
    // 假时钟：转录里的活动时刻要跟着它走，否则「多久没输出了」会算出负数。
    transcript.lastActivityAt = now;

    now += 61_000;
    expect(registry.tick().stalled).toEqual(['child-4']);
    now += 61_000;
    // 同一轮里只提示一次：反复提示等于让模型每 15 秒读一遍同一句话。
    expect(registry.tick().stalled).toEqual([]);
    const stalls = registry.takeEventsForPrompt().filter((event) => event.kind === 'stalled');
    expect(stalls).toHaveLength(1);
  });

  it('recycles an idle child only after its result has been read', async () => {
    let now = 1_000_000;
    const registry = makeRegistry({ recycleMs: 60_000, now: () => now });
    const { process, transcript, emit } = makeProcess('child-5');
    const entry = await spawnFake(registry, process);
    finishTurn(transcript, emit);
    transcript.lastActivityAt = now;

    now += 61_000;
    // 还没人读过结果：收掉等于把结论删了。
    expect(registry.tick().recycled).toEqual([]);
    registry.markRead(entry.id);
    now += 61_000;
    expect(registry.tick().recycled).toEqual(['child-5']);
    expect(process.close).toHaveBeenCalled();
  });

  it('turns a timed-out wait into an event when the condition finally holds', async () => {
    const registry = makeRegistry();
    const { process, transcript, emit } = makeProcess('child-6');
    const entry = await spawnFake(registry, process);

    registry.registerWatcher(entry, 'idle', null);
    expect(registry.hasWatcher(entry.id)).toBe(true);
    finishTurn(transcript, emit);

    const watch = registry.takeEventsForPrompt().filter((event) => event.kind === 'watch');
    expect(watch).toHaveLength(1);
    expect(registry.hasWatcher(entry.id)).toBe(false);
  });

  it('drops the events of a session it just closed', async () => {
    const registry = makeRegistry();
    const { process, transcript, emit } = makeProcess('child-7');
    const entry = await spawnFake(registry, process);
    finishTurn(transcript, emit);

    await registry.close(entry.id);
    // 条目都没了，还提示「它跑完了」只会让人去找一个不存在的东西。
    expect(registry.takeEventsForPrompt()).toHaveLength(0);
  });

  it('closes several children in one go', async () => {
    const registry = makeRegistry();
    const first = await spawnFake(registry, makeProcess('a-1').process);
    const second = await spawnFake(registry, makeProcess('b-2').process);
    const closed = await registry.closeMany('all');
    expect(closed.sort()).toEqual([first.id, second.id].sort());
    expect(registry.list()).toHaveLength(0);
  });
});

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function homeWithSession(id: string): string {
  const home = mkdtempSync(join(tmpdir(), 'mica-sidecar-attach-'));
  homes.push(home);
  const sessions = join(home, 'sessions');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      title: '之前那条会话',
      cwd: '/repo/api',
      snapshot: {
        conversationMessages: [
          { role: 'user', content: '把测试跑一遍' },
          { role: 'assistant', content: [{ type: 'text', text: '三个用例失败' }] },
        ],
      },
    }),
  );
  return home;
}

describe('sidecar attach', () => {
  it('resumes the session and seeds the history the notification stream does not carry', async () => {
    const home = homeWithSession('sess-1');
    // `home` 是系统家目录，`config` 才是 MICA_HOME：会话必须从后者找，
    // 拿 home 拼会去 `~/sessions` 里找一个永远不存在的文件。
    const registry = makeRegistry(
      {},
      { paths: { home: join(home, 'os-home'), config: home, plugins: join(home, 'plugins') } },
    );
    startMock.mockImplementation(async (options: { resumeSessionId?: string }) =>
      makeProcess(options.resumeSessionId ?? 'fresh').process,
    );

    const result = await registry.attach({ sessionId: 'sess-1' });
    expect(result.ok).toBe(true);
    const entry = result.ok ? result.entry : null;
    expect(entry?.id).toBe('sess-1');
    expect(entry?.title).toBe('之前那条会话');
    expect(entry?.attached).toBe(true);
    // resume 不发通知：不 seed 的话 sidecar_turns 会说「还没有任何一轮对话」。
    expect(entry?.process.transcript.totalTurnCount).toBe(1);
    expect(entry?.process.transcript.turns[0]?.text).toBe('三个用例失败');
    // 历史不能被当成「刚发生的事」再报一遍。
    expect(registry.takeEventsForPrompt().map((event) => event.kind)).toEqual(['attach']);
  });

  it('refuses a session that never landed on disk', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-sidecar-attach-'));
    homes.push(home);
    const registry = makeRegistry(
      {},
      { paths: { home: join(home, 'os-home'), config: home, plugins: home } },
    );
    const result = await registry.attach({ sessionId: 'missing' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('找不到会话');
    // 报错里给的是真正查过的目录：指到系统家目录会把人带到错的排查方向。
    expect(result.ok ? '' : result.error).toContain(join(home, 'sessions'));
    expect(startMock).not.toHaveBeenCalled();
  });

  it('returns the existing entry instead of attaching twice', async () => {
    const home = homeWithSession('sess-2');
    const registry = makeRegistry(
      {},
      { paths: { home: join(home, 'os-home'), config: home, plugins: home } },
    );
    startMock.mockImplementation(async (options: { resumeSessionId?: string }) =>
      makeProcess(options.resumeSessionId ?? 'fresh').process,
    );
    const first = await registry.attach({ sessionId: 'sess-2' });
    const again = await registry.attach({ sessionId: 'sess-2' });
    expect(first.ok && again.ok && again.entry.id === 'sess-2').toBe(true);
    expect(startMock).toHaveBeenCalledTimes(1);
  });
});

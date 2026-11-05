import { describe, expect, it } from 'vitest';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import type { ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { ToolSessionPeers } from '../SessionAutonomyTools.js';
import { buildConcurrencyNotice } from '../SessionAutonomyPlugin.js';
import type { SessionTurnLock } from '@packages/mica-session/index.js';

function mockAgent(taskOwnerId = 'agent-1'): CommandAgent {
  return {
    taskOwnerId,
    role: 'default',
    config: {
      provider: { id: 'mock', name: 'Mock Provider', contextWindowSize: 256_000 },
      model: 'mock-chat',
      effort: 'none',
    },
    getSnapshot: () => ({
      providerId: 'mock',
      model: 'mock-chat',
      effort: 'none',
      role: 'default',
      messages: [],
      usageHistory: [],
    }),
  } as unknown as CommandAgent;
}

function makeDeps() {
  const agent = mockAgent();
  let currentAgent: CommandAgent | undefined = agent;
  const deps = {
    agent,
    services: undefined as unknown as CommandRuntimeServices,
    setCurrentAgent(next: CommandAgent | undefined) {
      currentAgent = next;
    },
  };
  deps.services = {
    getCurrentAgent: () => currentAgent,
    getCurrentAgentSessionId: () => 'sess-1',
    getCurrentSessionController: () => ({ getCurrentTitle: () => '测试会话', saveCurrent: () => undefined }),
    showNotice: () => undefined,
  } as unknown as CommandRuntimeServices;
  return deps;
}

function withAgent(deps: ReturnType<typeof makeDeps>): ToolExecuteCallbacks {
  return { context: { agent: deps.agent } };
}

function lock(overrides: Partial<SessionTurnLock> & Pick<SessionTurnLock, 'sessionId' | 'pid'>): SessionTurnLock {
  return {
    sessionId: overrides.sessionId,
    pid: overrides.pid,
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    alive: overrides.alive ?? true,
    lockPath: `/locks/${overrides.sessionId}.lock`,
    sessionPath: `/sessions/${overrides.sessionId}.json`,
    title: overrides.title ?? '某个会话',
    cwd: overrides.cwd ?? '/repo',
    updatedAt: overrides.updatedAt,
    turnState: overrides.turnState ?? 'running',
    model: overrides.model ?? 'mock-chat',
  };
}

describe('session_peers tool', () => {
  it('lists running instances with their session file paths, marks the caller and explains how to read', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [
        lock({ sessionId: 'sess-1', pid: 111, title: '当前会话', cwd: '/repo' }),
        lock({ sessionId: 'sess-2', pid: 222, title: '另一个会话', turnState: 'running' }),
        lock({ sessionId: 'sess-dead', pid: 333, alive: false }),
      ],
      describeProcess: (pid) => `mica app-server (${pid})`,
    }).execute({}, withAgent(deps));

    expect(output).toContain('正在运行的 Mica 会话：2 个');
    expect(output).toContain('sess-1（本会话）');
    expect(output).toContain('另一个会话');
    expect(output).toContain('/sessions/sess-2.json');
    expect(output).toContain('mica app-server (222)');
    expect(output).toContain('残留 turn 锁');
    expect(output).toContain('sess-dead(pid 333)');
    // The reading guidance is part of the contract: conversation text first, never the whole file.
    expect(output).toContain('snapshot.conversationMessages');
    expect(output).toContain('不要用 read_file 直接读整个文件');
  });

  it('says so explicitly when no other instance is running', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [],
      describeProcess: () => undefined,
    }).execute({}, withAgent(deps));

    expect(output).toContain('当前没有正在运行的 Mica 会话');
    expect(output).toContain('conversationMessages');
  });

  it('reports when only the calling session is running', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [lock({ sessionId: 'sess-1', pid: 111 })],
      describeProcess: () => undefined,
    }).execute({}, withAgent(deps));

    expect(output).toContain('除本会话外，没有其他 Mica 会话在运行');
  });

  it('flags other instances that share this session working directory', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [
        lock({ sessionId: 'sess-1', pid: 111, cwd: '/repo/mica-code' }),
        lock({ sessionId: 'sess-same', pid: 222, cwd: '/repo/mica-code' }),
        lock({ sessionId: 'sess-other', pid: 333, cwd: '/repo/other' }),
      ],
      describeProcess: () => undefined,
    }).execute({}, withAgent(deps));

    expect(output).toContain('sess-same（与本会话同一工作目录）');
    expect(output).not.toContain('sess-other（与本会话同一工作目录）');
  });

  it('names the files a same-cwd peer wrote this turn, so ownership is never guessed from git status', async () => {
    const deps = makeDeps();
    const startedAt = '2026-11-05T02:00:00.000Z';
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [
        lock({ sessionId: 'sess-1', pid: 111, cwd: '/repo/mica-code' }),
        lock({ sessionId: 'sess-same', pid: 222, cwd: '/repo/mica-code', startedAt }),
        lock({ sessionId: 'sess-other', pid: 333, cwd: '/repo/other', startedAt }),
      ],
      listSessionWrites: (sessionId) =>
        sessionId === 'sess-same'
          ? [
              { path: '/repo/mica-code/src/before.ts', at: '2026-11-05T01:00:00.000Z' },
              { path: '/repo/mica-code/src/session-filter.js', at: '2026-11-05T02:30:00.000Z' },
              { path: '/repo/elsewhere/x.ts', at: '2026-11-05T02:30:00.000Z' },
            ]
          : [{ path: '/repo/other/ignored.ts', at: '2026-11-05T02:30:00.000Z' }],
      describeProcess: () => undefined,
    }).execute({}, withAgent(deps));

    expect(output).toContain('本轮写过的文件: src/session-filter.js, /repo/elsewhere/x.ts');
    // Entries from before the peer's current turn belong to its previous work.
    expect(output).not.toContain('src/before.ts');
    // A different working directory is not the caller's problem.
    expect(output).not.toContain('ignored.ts');
    expect(output).toContain('不属于本会话的改动只能报告，不能回滚或还原');
  });

  it('is rejected outside the active primary agent', async () => {
    const deps = makeDeps();
    deps.setCurrentAgent(undefined);
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [],
      describeProcess: () => undefined,
    }).execute({}, withAgent(deps));
    expect(output).toContain('只能在交互式主会话中使用');
  });

  it('stays on running instances only unless hours is passed', async () => {
    const deps = makeDeps();
    let asked = false;
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [lock({ sessionId: 'sess-1', pid: 111 })],
      listRecentSessions: () => {
        asked = true;
        return [];
      },
      describeProcess: () => undefined,
    }).execute({}, withAgent(deps));

    expect(asked).toBe(false);
    expect(output).not.toContain('小时内结束的会话');
  });

  it('lists sessions that ended inside the hours window, skipping running and the caller', async () => {
    const deps = makeDeps();
    const sinceSeen: number[] = [];
    const endedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [lock({ sessionId: 'sess-1', pid: 111 }), lock({ sessionId: 'sess-busy', pid: 222 })],
      listRecentSessions: (since) => {
        sinceSeen.push(since);
        return [
          {
            sessionId: 'sess-1',
            sessionPath: '/sessions/sess-1.json',
            title: '本会话',
            updatedAt: endedAt,
            modifiedAt: endedAt,
          },
          {
            sessionId: 'sess-busy',
            sessionPath: '/sessions/sess-busy.json',
            title: '还在跑',
            turnState: 'running',
            updatedAt: endedAt,
            modifiedAt: endedAt,
          },
          {
            sessionId: 'sess-done',
            sessionPath: '/sessions/sess-done.json',
            title: '刚结束的会话',
            cwd: '/repo/finished',
            turnState: 'completed',
            model: 'mock-chat',
            updatedAt: endedAt,
            modifiedAt: endedAt,
          },
        ];
      },
      describeProcess: () => undefined,
    }).execute({ hours: 3 }, withAgent(deps));

    expect(sinceSeen).toHaveLength(1);
    expect(Date.now() - sinceSeen[0]!).toBeGreaterThanOrEqual(3 * 3_600_000 - 5_000);
    expect(output).toContain('最近 3 小时内结束的会话：1 个');
    expect(output).toContain('/sessions/sess-done.json');
    expect(output).toContain('刚结束的会话');
    expect(output).toContain('turnState completed');
    expect(output).toContain('30 分钟前');
    // The caller and live instances keep their own block; the ended list holds one entry.
    const endedSection = output.slice(output.indexOf('最近 3 小时内结束的会话'));
    expect(endedSection).not.toContain('/sessions/sess-1.json');
    expect(endedSection).not.toContain('/sessions/sess-busy.json');
  });

  it('says so when nothing finished inside the window', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionPeers({
      ...deps,
      listTurnLocks: () => [lock({ sessionId: 'sess-1', pid: 111 })],
      listRecentSessions: () => [],
      describeProcess: () => undefined,
    }).execute({ hours: 6 }, withAgent(deps));

    expect(output).toContain('最近 6 小时内没有已结束的其他会话');
  });
});

describe('concurrency prompt section', () => {
  it('stays empty while this session owns the working directory', () => {
    const deps = makeDeps();
    const notice = buildConcurrencyNotice({
      services: deps.services,
      listTurnLocks: () => [
        lock({ sessionId: 'sess-1', pid: 111, cwd: '/repo/mica-code' }),
        lock({ sessionId: 'sess-other', pid: 333, cwd: '/repo/other' }),
      ],
    });

    // A section that renders nothing costs no prompt tokens in the normal case.
    expect(notice).toBe('');
  });

  it('states the facts and the rule as soon as a same-cwd session is alive', () => {
    const deps = makeDeps();
    const startedAt = new Date(Date.now() - 42 * 60_000).toISOString();
    const notice = buildConcurrencyNotice({
      services: deps.services,
      listTurnLocks: () => [
        lock({ sessionId: 'sess-1', pid: 111, cwd: '/repo/mica-code' }),
        lock({ sessionId: 'sess-peer', pid: 222, cwd: '/repo/mica-code', title: '改筛选列表', startedAt }),
      ],
    });

    expect(notice).toContain('还有 1 个 Mica 会话正在跑');
    expect(notice).toContain('sess-peer · 改筛选列表 · 本轮已跑 42 分钟');
    expect(notice).toContain('`git status` / `git diff` 不记录作者');
    expect(notice).toContain('不能回滚、还原、重排或格式化整份文件');
    // The dead-lease case must not be reported as a live writer.
    expect(notice).not.toContain('sess-1');
  });

  it('ignores leases whose holder process is gone', () => {
    const deps = makeDeps();
    const notice = buildConcurrencyNotice({
      services: deps.services,
      listTurnLocks: () => [
        lock({ sessionId: 'sess-1', pid: 111, cwd: '/repo/mica-code' }),
        lock({ sessionId: 'sess-dead', pid: 999, cwd: '/repo/mica-code', alive: false }),
      ],
    });

    expect(notice).toBe('');
  });
});

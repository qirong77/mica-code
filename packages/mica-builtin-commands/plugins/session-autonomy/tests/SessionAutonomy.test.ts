import { describe, expect, it } from 'vitest';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import type { ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { ToolSessionPeers } from '../SessionAutonomyTools.js';
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
});

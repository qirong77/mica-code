import { describe, expect, it } from 'vitest';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import type { ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { ToolSessionCompact, ToolSessionInfo, type PendingSessionOp } from '../SessionAutonomyTools.js';

const MESSAGES = [
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好！有什么可以帮你？' },
  { role: 'user', content: '帮我写一个函数' },
  { role: 'assistant', content: '好的，以下是函数：' },
];

function mockAgent(messages: unknown[] = MESSAGES, taskOwnerId = 'agent-1'): CommandAgent {
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
      messages,
      usageHistory: [],
      lastUsage: { input_tokens: 100, output_tokens: 50 },
    }),
  } as unknown as CommandAgent;
}

function makeDeps() {
  const queued: Array<{ ownerKey: string; op: PendingSessionOp }> = [];
  const agent = mockAgent();
  let currentAgent: CommandAgent | undefined = agent;
  const deps = {
    agent,
    queued,
    queueOp: (ownerKey: string, op: PendingSessionOp) => {
      if (queued.some((entry) => entry.ownerKey === ownerKey)) return false;
      queued.push({ ownerKey, op });
      return true;
    },
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
    compact: async () => ({
      beforeCount: 10,
      afterCount: 4,
      savedTokenEstimate: 12_000,
      savedRatio: 0.6,
      keptCount: 3,
      contextUsageRatio: 0.2,
    }),
  } as unknown as CommandRuntimeServices;
  return deps;
}

function withAgent(deps: ReturnType<typeof makeDeps>): ToolExecuteCallbacks {
  return { context: { agent: deps.agent } };
}

describe('session tools', () => {
  it('session_info reports session metadata', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionInfo(deps).execute({}, withAgent(deps));
    expect(output).toContain('sess-1');
    expect(output).toContain('测试会话');
    expect(output).toContain('mock-chat');
    expect(output).toContain('消息数: 4');
    expect(output).toContain('256,000 tokens');
  });

  it('session_info rejects non-active agents', async () => {
    const deps = makeDeps();
    deps.setCurrentAgent(mockAgent([{ role: 'user', content: 'other' }], 'agent-other'));
    const output = await new ToolSessionInfo(deps).execute({}, withAgent(deps));
    expect(output).toContain('只能在交互式主会话中使用');
  });

  it('session_compact preview runs immediately and returns estimates', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionCompact(deps).execute({ preview: true }, withAgent(deps));
    expect(output).toContain('压缩预览');
    expect(output).toContain('12k tokens');
    expect(deps.queued).toHaveLength(0);
  });

  it('session_compact queues an op when not preview', async () => {
    const deps = makeDeps();
    const output = await new ToolSessionCompact(deps).execute({}, withAgent(deps));
    expect(output).toContain('已登记会话压缩');
    expect(deps.queued).toHaveLength(1);
    expect(deps.queued[0]!.op.type).toBe('compact');

    // second op for the same owner is rejected while one is pending
    const second = await new ToolSessionCompact(deps).execute({}, withAgent(deps));
    expect(second).toContain('已有待应用的会话操作排队');
  });
});

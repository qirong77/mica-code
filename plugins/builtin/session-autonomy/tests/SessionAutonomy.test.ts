import { describe, expect, it } from 'vitest';
import type { CommandAgent, CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import type { ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import {
  ToolSessionCompact,
  ToolSessionHistory,
  ToolSessionInfo,
  ToolSessionRewrite,
  ToolSessionSetPrompt,
  buildRewriteMessages,
  type PendingSessionOp,
} from '../SessionAutonomyTools.js';

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

describe('buildRewriteMessages', () => {
  it('keeps plain chat completion message shape', () => {
    const next = buildRewriteMessages(MESSAGES, '  总结内容  ');
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ role: 'user', content: '总结内容' });
  });

  it('keeps array-content message shape', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ];
    const next = buildRewriteMessages(messages, 'sum');
    expect(next[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'sum' }] });
  });

  it('keeps responses message shape', () => {
    const messages = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }];
    const next = buildRewriteMessages(messages, 'sum');
    expect(next[0]).toEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sum' }] });
  });

  it('keeps recent user-led rounds when requested', () => {
    const next = buildRewriteMessages(MESSAGES, 'sum', 1);
    expect(next).toHaveLength(3); // summary + 最后一条 user + assistant
    expect(next[0]).toEqual({ role: 'user', content: 'sum' });
    expect(next[1]).toEqual({ role: 'user', content: '帮我写一个函数' });
    expect(next[2]).toEqual({ role: 'assistant', content: '好的，以下是函数：' });
  });
});

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

  it('session_history paginates and truncates', async () => {
    const deps = makeDeps();
    const tool = new ToolSessionHistory(deps);
    const page = await tool.execute({ start: 0, limit: 2 }, withAgent(deps));
    expect(page).toContain('共 4 条消息');
    expect(page).toContain('[user] 你好');
    expect(page).not.toContain('帮我写一个函数');

    const outOfRange = await tool.execute({ start: 10 }, withAgent(deps));
    expect(outOfRange).toContain('没有更多历史消息');
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

  it('session_set_prompt validates and queues', async () => {
    const deps = makeDeps();
    const tool = new ToolSessionSetPrompt(deps);
    const missing = await tool.execute({ mode: 'replace' }, withAgent(deps));
    expect(missing).toContain('text 不能为空');
    const tooLong = await tool.execute({ mode: 'replace', text: 'x'.repeat(8_001) }, withAgent(deps));
    expect(tooLong).toContain('上限 8000');
    const ok = await tool.execute({ mode: 'append', text: '新增约束' }, withAgent(deps));
    expect(ok).toContain('本轮对话结束后生效');
    expect(deps.queued[0]!.op).toEqual({ type: 'setPrompt', input: { mode: 'append', text: '新增约束' } });
    deps.queued.length = 0;
    const clear = await new ToolSessionSetPrompt(deps).execute({ mode: 'clear' }, withAgent(deps));
    expect(clear).toContain('清除');
  });

  it('session_rewrite validates summary and queues', async () => {
    const deps = makeDeps();
    const tool = new ToolSessionRewrite(deps);
    expect(await tool.execute({}, withAgent(deps))).toContain('summary 不能为空');
    const ok = await tool.execute({ summary: '总结', keep_recent_rounds: 2 }, withAgent(deps));
    expect(ok).toContain('已登记历史重写');
    expect(deps.queued[0]!.op).toEqual({ type: 'rewrite', input: { summary: '总结', keep_recent_rounds: 2 } });
  });
});

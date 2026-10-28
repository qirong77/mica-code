import { describe, expect, it, vi } from 'vitest';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { createPluginThread } from './PluginSubagentThread.js';

/**
 * 旁问线程的宿主机制：建子代理时的工具边界、每次提问只记新增用量、以及「一次只答
 * 一个问题」这条不变量。插件侧（`/btw` 怎么问、怎么显示）不在这里测。
 */

describe('createPluginThread', () => {
  it('builds an isolated child agent with the plugin system prompt and no primary-only tools', () => {
    const tool = registerOwnerOnlyTool();
    const harness = makeHarness();
    try {
      createPluginThread({
        owner: harness.owner,
        pluginId: 'btw',
        threadId: '1',
        options: { type: 'btw', systemPrompt: '你是旁问', description: '问题' },
      });

      const options = harness.createSubAgent.mock.calls[0]?.[0] as {
        systemPrompt?: string;
        tools?: boolean;
        toolFilter?: (name: string) => boolean;
      };
      expect(options.systemPrompt).toBe('你是旁问');
      expect(options.tools).toBe(true);
      expect(options.toolFilter?.(tool.name)).toBe(false);
      expect(options.toolFilter?.('read_file')).toBe(true);
      expect(options.toolFilter?.('mcp__demo__search')).toBe(true);
    } finally {
      micaTools.unregisterRuntime(tool);
    }
  });

  it('honours tools / allowedTools / model', () => {
    const harness = makeHarness();
    createPluginThread({
      owner: harness.owner,
      pluginId: 'btw',
      threadId: '1',
      options: { type: 'btw', systemPrompt: 'p', tools: false, allowedTools: ['read_file'], model: 'other-model' },
    });

    const options = harness.createSubAgent.mock.calls[0]?.[0] as {
      tools?: boolean;
      model?: string;
      toolFilter?: (name: string) => boolean;
    };
    expect(options.tools).toBe(false);
    expect(options.model).toBe('other-model');
    expect(options.toolFilter?.('write_file')).toBe(false);
    expect(options.toolFilter?.('read_file')).toBe(true);
  });

  it('streams through the per-ask callbacks and clears them afterwards', async () => {
    const harness = makeHarness();
    const thread = createPluginThread({
      owner: harness.owner,
      pluginId: 'btw',
      threadId: '1',
      options: { type: 'btw', systemPrompt: 'p' },
    });
    const onText = vi.fn();

    await thread.ask('问题', { onText });

    // 回调只在提问期间挂在子代理上：这期间模型推正文就走它。
    expect(onText).toHaveBeenCalledWith('delta');
    expect(harness.child.onText).toBeUndefined();
    expect(harness.child.onThinking).toBeUndefined();
    expect(harness.query).toHaveBeenCalledWith('问题', {});
  });

  it('bills only the requests each ask produced, as plugin-origin usage', async () => {
    const harness = makeHarness();
    const persistUsage = vi.fn();
    const thread = createPluginThread({
      owner: harness.owner,
      pluginId: 'btw',
      threadId: '7',
      options: { type: 'btw', systemPrompt: 'p', description: '默认描述' },
      persistUsage,
    });

    harness.replyWith(1);
    await thread.ask('第一问');
    harness.replyWith(2);
    await thread.ask('第二问');

    expect(harness.recordSubagentUsage).toHaveBeenCalledTimes(2);
    const first = harness.recordSubagentUsage.mock.calls[0]?.[0] as {
      taskId: string;
      origin: string;
      pluginId: string;
      subagentType: string;
      description: string;
      status: string;
      requests: Array<{ requestIndex: number }>;
    };
    expect(first.taskId).toBe('plugin:btw:thread:7');
    expect(first.origin).toBe('plugin');
    expect(first.pluginId).toBe('btw');
    expect(first.subagentType).toBe('btw');
    expect(first.description).toBe('默认描述');
    expect(first.status).toBe('completed');
    expect(first.requests.map((request) => request.requestIndex)).toEqual([1]);

    const second = harness.recordSubagentUsage.mock.calls[1]?.[0] as { requests: Array<{ requestIndex: number }> };
    expect(second.requests.map((request) => request.requestIndex)).toEqual([2]);
    expect(persistUsage).toHaveBeenCalledTimes(2);

    expect(thread.usage()).toEqual({
      requests: 2,
      last: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, totalTokens: 11 },
    });
  });

  it('reports the question as the usage description when the ask carries one', async () => {
    const harness = makeHarness();
    const thread = createPluginThread({
      owner: harness.owner,
      pluginId: 'btw',
      threadId: '1',
      options: { type: 'btw', systemPrompt: 'p' },
    });

    await thread.ask('具体问题', { description: '具体问题' });

    expect((harness.recordSubagentUsage.mock.calls[0]?.[0] as { description: string }).description).toBe('具体问题');
  });

  it('records a failed ask as failed usage and rethrows', async () => {
    const harness = makeHarness();
    // 失败的请求也可能已经被 provider 计费（超时、断流），所以这里先记一笔再抛。
    harness.query.mockImplementationOnce(async () => {
      harness.pushUsage(1);
      throw new Error('boom');
    });
    const thread = createPluginThread({
      owner: harness.owner,
      pluginId: 'btw',
      threadId: '1',
      options: { type: 'btw', systemPrompt: 'p' },
    });

    await expect(thread.ask('问题')).rejects.toThrow('boom');

    expect((harness.recordSubagentUsage.mock.calls[0]?.[0] as { status: string }).status).toBe('failed');
  });

  it('rejects a second question while one is still running', async () => {
    const harness = makeHarness();
    let release: (answer: string) => void = () => undefined;
    harness.query.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const thread = createPluginThread({
      owner: harness.owner,
      pluginId: 'btw',
      threadId: '1',
      options: { type: 'btw', systemPrompt: 'p' },
    });

    const first = thread.ask('第一问');
    await expect(thread.ask('第二问')).rejects.toThrow('还在回答上一个问题');
    release('答案');
    await expect(first).resolves.toBe('答案');
  });

  it('rejects empty questions and any question after dispose', async () => {
    const harness = makeHarness();
    const thread = createPluginThread({
      owner: harness.owner,
      pluginId: 'btw',
      threadId: '1',
      options: { type: 'btw', systemPrompt: 'p' },
    });

    await expect(thread.ask('   ')).rejects.toThrow('问题不能为空');
    thread.dispose();
    await expect(thread.ask('问题')).rejects.toThrow('已经关闭');
  });
});

function registerOwnerOnlyTool(): MicaTool {
  class OwnerOnlyTool extends MicaTool {
    constructor() {
      super('btw_thread_owner_only', 'test', { type: 'object', properties: {} }, { readOnly: true });
    }

    async execute() {
      return 'ok';
    }

    onToolUseDisplayText() {
      return 'owner only';
    }
  }

  const tool = new OwnerOnlyTool();
  micaTools.registerRuntime(tool, { primaryAgentOnly: true });
  return tool;
}

type Harness = {
  owner: AgentRuntime;
  child: Record<string, unknown>;
  query: ReturnType<typeof vi.fn>;
  createSubAgent: ReturnType<typeof vi.fn>;
  recordSubagentUsage: ReturnType<typeof vi.fn>;
  replyWith(index: number): void;
  pushUsage(index: number): void;
};

function makeHarness(): Harness {
  const usageHistory: AgentUsageRecord[] = [];
  let nextRequestIndex = 1;
  const child: Record<string, unknown> = {
    model: 'mock-model',
    usageHistory,
    lastUsage: undefined,
    onText: undefined,
    onThinking: undefined,
    onToolCall: undefined,
    onToolResult: undefined,
  };
  const query = vi.fn(async () => {
    (child.onText as ((text: string) => void) | undefined)?.('delta');
    const usage = usageRecord(nextRequestIndex++);
    usageHistory.push(usage);
    child.lastUsage = usage;
    return '答案';
  });
  child.query = query;
  const createSubAgent = vi.fn(() => child);
  const recordSubagentUsage = vi.fn();
  const owner = { createSubAgent, recordSubagentUsage } as unknown as AgentRuntime;

  return {
    owner,
    child,
    query,
    createSubAgent,
    recordSubagentUsage,
    replyWith(index: number) {
      nextRequestIndex = index;
    },
    pushUsage(index: number) {
      usageHistory.push(usageRecord(index));
    },
  };
}

function usageRecord(requestIndex: number): AgentUsageRecord {
  return {
    provider: 'mock',
    turnId: requestIndex,
    requestIndex,
    messageCount: 2,
    inputTokens: 10,
    outputTokens: 1,
    totalTokens: 11,
    paidTokenRate: 1,
  };
}

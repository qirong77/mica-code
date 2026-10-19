import { describe, expect, it, vi } from 'vitest';

import {
  BtwThreadController,
  capBtwHead,
  capBtwTail,
  parseBtwToolArgs,
  resolveBtwToolIndex,
  MAX_BTW_THINKING_CHARS,
  MAX_BTW_TOOL_OUTPUT_CHARS,
} from './btwThread.js';
import type { MicaBtwThread } from '@packages/mica-runtime/codexProtocol.js';
import type { CommandAgent, CommandSessionController } from '@packages/mica-builtin-commands/services.js';

type FakeOptions = {
  reply?: () => Promise<string>;
  messages?: unknown[];
  /** 让 `query` 挂住不返回，测试自己控制回答结束的时刻（流式用例用）。 */
  pendingReply?: boolean;
  flushIntervalMs?: number;
};

function makeHarness(options: FakeOptions = {}) {
  const usageHistory: unknown[] = [];
  let finishReply: ((value: string) => void) | null = null;
  let failReply: ((error: unknown) => void) | null = null;
  const query = vi.fn(async (_input?: unknown) => {
    usageHistory.push({ usageId: usageHistory.length + 1 });
    if (options.reply) return await options.reply();
    if (options.pendingReply) {
      return await new Promise<string>((resolve, reject) => {
        finishReply = resolve;
        failReply = reject;
      });
    }
    return 'By The Way 答案';
  });
  const recordSubagentUsage = vi.fn();
  // 子代理的流式回调由 controller 赋值（真实实现里是 IAgent 的可写回调），
  // 所以这里必须是一个普通对象，测试可以直接触发它们。
  const subagent: {
    query: typeof query;
    usageHistory: unknown[];
    onText?: (text: string) => void;
    onThinking?: (thinking: string) => void;
    onToolCall?: (name: string, args: string, id?: string) => void;
    onToolResult?: (name: string, result: string, id?: string) => void;
  } = { query, usageHistory };
  const createSubAgent = vi.fn((_options?: { systemPrompt?: string }) => subagent);
  const saveCurrent = vi.fn();
  const agent = {
    config: { provider: { id: 'test' }, model: 'gpt-test', effort: 'medium' },
    isRunning: false,
    recordSubagentUsage,
    getSnapshot: () => ({
      providerId: 'test',
      model: 'gpt-test',
      effort: 'medium',
      role: 'default',
      messages: options.messages ?? [
        { role: 'user', content: '主流程问题' },
        { role: 'assistant', content: '主流程回答' },
      ],
      usageHistory: [],
    }),
    createSubAgent,
  } as unknown as CommandAgent;
  const sessionController = { saveCurrent } as unknown as CommandSessionController;
  const updates: MicaBtwThread[] = [];
  const controller = new BtwThreadController({
    agent,
    sessionController,
    onUpdate: (snapshot) => updates.push(snapshot),
    flushIntervalMs: options.flushIntervalMs ?? 0,
  });
  return {
    agent,
    controller,
    updates,
    query,
    subagent,
    createSubAgent,
    recordSubagentUsage,
    saveCurrent,
    usageHistory,
    finishReply: (text: string) => finishReply?.(text),
    failReply: (error: unknown) => failReply?.(error),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BtwThreadController', () => {
  it('answering one question pushes running then completed snapshots', async () => {
    const harness = makeHarness();
    expect(harness.controller.ask('这个方案可行吗')).toEqual({ ok: true });
    expect(harness.controller.snapshot().entries).toMatchObject([{ question: '这个方案可行吗', status: 'running' }]);
    await settle();
    expect(harness.controller.snapshot().entries).toMatchObject([
      { question: '这个方案可行吗', status: 'completed', answer: 'By The Way 答案' },
    ]);
    expect(harness.updates).toHaveLength(2);
    expect(harness.updates[0].entries[0].status).toBe('running');
    expect(harness.updates[1].entries[0].status).toBe('completed');
    expect(harness.updates[0].id).toBe(harness.updates[1].id);
  });

  it('runs one question at a time', async () => {
    const harness = makeHarness();
    harness.controller.ask('第一个问题');
    const second = harness.controller.ask('第二个问题');
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.message).toContain('还在回答');
    await settle();
    expect(harness.controller.snapshot().entries).toHaveLength(1);
    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  it('rejects empty questions', () => {
    const harness = makeHarness();
    expect(harness.controller.ask('   ').ok).toBe(false);
    expect(harness.controller.snapshot().entries).toHaveLength(0);
  });

  it('reuses one subagent across follow-ups and re-reads the transcript on a new topic', async () => {
    const harness = makeHarness();
    const first = harness.controller.ask('这个方案可行吗');
    await settle();
    expect(first.ok).toBe(true);
    harness.controller.ask('那成本呢');
    await settle();
    const thread = harness.controller.snapshot();
    expect(thread.entries).toHaveLength(2);
    expect(harness.query).toHaveBeenCalledTimes(2);
    // 同一话题复用同一个子代理，背景只取一次
    expect(harness.createSubAgent).toHaveBeenCalledTimes(1);

    harness.controller.ask('换个话题', { newThread: true });
    await settle();
    const fresh = harness.controller.snapshot();
    expect(fresh.id).not.toBe(thread.id);
    expect(fresh.entries).toMatchObject([{ question: '换个话题', status: 'completed' }]);
    expect(harness.createSubAgent).toHaveBeenCalledTimes(2);
    const systemPrompt = harness.createSubAgent.mock.calls[1]?.[0]?.systemPrompt ?? '';
    expect(systemPrompt).toContain('主流程问题');
  });

  it('reset clears the thread and notifies listeners', () => {
    const harness = makeHarness();
    harness.controller.ask('问题');
    harness.controller.reset();
    expect(harness.controller.snapshot().entries).toHaveLength(0);
    expect(harness.updates.at(-1)?.entries).toHaveLength(0);
  });

  it('records usage per request and marks failures', async () => {
    const harness = makeHarness({ reply: () => Promise.reject(new Error('模型挂了')) });
    harness.controller.ask('会失败的问题');
    await settle();
    expect(harness.recordSubagentUsage).toHaveBeenCalledTimes(1);
    expect(harness.recordSubagentUsage.mock.calls[0][0]).toMatchObject({
      subagentType: 'btw',
      status: 'failed',
      requests: [{ usageId: 1 }],
    });
    expect(harness.controller.snapshot().entries).toMatchObject([{ status: 'error', error: '模型挂了' }]);
    // 会话空闲时立刻落盘
    expect(harness.saveCurrent).toHaveBeenCalledWith({ allowEmpty: true });
  });

  it('does not save the session while a turn is running', async () => {
    const harness = makeHarness();
    (harness.agent as unknown as { isRunning: boolean }).isRunning = true;
    harness.controller.ask('问题');
    await settle();
    expect(harness.saveCurrent).not.toHaveBeenCalled();
  });

  it('keeps only the most recent entries', async () => {
    const harness = makeHarness();
    for (let index = 0; index < 40; index += 1) {
      harness.controller.ask(`问题 ${index}`);
      await settle();
    }
    const entries = harness.controller.snapshot().entries;
    expect(entries).toHaveLength(20);
    expect(entries.at(-1)?.question).toBe('问题 39');
  });

  it('streams thinking, tool calls and partial text into the running entry', async () => {
    const harness = makeHarness({ pendingReply: true });
    harness.controller.ask('这个方案可行吗');

    harness.subagent.onThinking?.('先看看代码');
    harness.subagent.onToolCall?.('read_file', '{"file_path":"src/a.ts"}', 'call-1');
    harness.subagent.onText?.('可以先');

    let entry = harness.controller.snapshot().entries.at(0);
    expect(entry).toMatchObject({ status: 'running', thinking: '先看看代码', answer: '可以先' });
    expect(entry?.tools).toMatchObject([
      { id: 'call-1', tool: 'read_file', status: 'running', input: { file_path: 'src/a.ts' } },
    ]);

    harness.subagent.onToolResult?.('read_file', 'export const a = 1', 'call-1');
    entry = harness.controller.snapshot().entries.at(0);
    expect(entry?.tools?.[0]).toMatchObject({ status: 'completed', output: 'export const a = 1' });

    // 完成时正文以 query 的返回值为准，流式期间攒下的思考与工具行留着给用户看
    harness.subagent.onText?.('以先');
    harness.finishReply('可以先做 A，再做 B');
    await settle();
    entry = harness.controller.snapshot().entries.at(0);
    expect(entry).toMatchObject({ status: 'completed', answer: '可以先做 A，再做 B' });
    expect(entry?.thinking).toBe('先看看代码');
    expect(entry?.tools).toHaveLength(1);
  });

  it('keeps the partial answer when the request fails', async () => {
    const harness = makeHarness({ pendingReply: true });
    harness.controller.ask('问题');
    harness.subagent.onText?.('写了一半');
    harness.subagent.onThinking?.('想着想着');
    harness.failReply(new Error('模型挂了'));
    await settle();
    // 失败时流出来的正文与思考是唯一的记录（完成时才用 query 的返回值覆盖），必须留着
    expect(harness.controller.snapshot().entries.at(0)).toMatchObject({
      status: 'error',
      error: '模型挂了',
      answer: '写了一半',
      thinking: '想着想着',
    });
  });

  it('drops the previous turn activity log when the next question starts', async () => {
    const harness = makeHarness();
    harness.controller.ask('第一个问题');
    harness.subagent.onThinking?.('思考一');
    harness.subagent.onToolCall?.('grep_search', '{"pattern":"x"}', 'c1');
    await settle();
    expect(harness.controller.snapshot().entries.at(0)?.tools).toHaveLength(1);

    harness.controller.ask('第二个问题');
    const entries = harness.controller.snapshot().entries;
    expect(entries).toHaveLength(2);
    // 日志只描述正在发生的那一轮；回答本身留着
    expect(entries[0].thinking).toBeUndefined();
    expect(entries[0].tools).toBeUndefined();
    expect(entries[0].answer).toBe('By The Way 答案');
  });

  it('coalesces deltas inside the flush window', () => {
    vi.useFakeTimers();
    try {
      const harness = makeHarness({ flushIntervalMs: 50, pendingReply: true });
      harness.controller.ask('问题');
      const before = harness.updates.length;
      harness.subagent.onText?.('A');
      harness.subagent.onText?.('B');
      harness.subagent.onText?.('C');
      // 窗口内的 delta 先攒着，一次都没推
      expect(harness.updates).toHaveLength(before);
      expect(harness.controller.snapshot().entries.at(0)?.answer).toBeUndefined();
      vi.advanceTimersByTime(60);
      expect(harness.updates).toHaveLength(before + 1);
      expect(harness.controller.snapshot().entries.at(0)?.answer).toBe('ABC');
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns pasted image references into multimodal content', async () => {
    const harness = makeHarness();
    // 文件不存在也没关系：这里只验证「带 [Image] 引用的问题被当成多模态内容交给子代理」，
    // 解析失败时 parseImageRefs 会把它降级成 `[image omitted: …]` 文本块而不是丢掉问题。
    harness.controller.ask('看看这张图 [Image](/tmp/mica-missing-shot.png) 是什么');
    await settle();
    const input = harness.query.mock.calls[0]?.[0] as unknown;
    expect(Array.isArray(input)).toBe(true);
    expect(JSON.stringify(input)).toContain('mica-missing-shot.png');

    // 纯文本问题保持原样（也保持「收下问题就发」的同步时序）
    harness.controller.ask('第二个问题');
    await settle();
    expect(harness.query.mock.calls[1]?.[0]).toBe('第二个问题');
  });

  it('bounds thinking, tool output and matches tool results defensively', () => {
    expect(capBtwHead('abcdef', 3)).toBe('abc…');
    expect(capBtwHead('abc', 3)).toBe('abc');
    expect(capBtwTail('abcdef', 3)).toBe('…def');
    expect(capBtwTail('abc', 3)).toBe('abc');
    expect(parseBtwToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseBtwToolArgs('not json')).toEqual({ value: 'not json' });
    expect(parseBtwToolArgs('')).toEqual({});

    const tools = [
      { id: 'a', tool: 'read_file', status: 'completed' as const, startedAt: '' },
      { id: 'b', tool: 'read_file', status: 'running' as const, startedAt: '' },
      { id: 'c', tool: 'grep_search', status: 'running' as const, startedAt: '' },
    ];
    expect(resolveBtwToolIndex(tools, 'read_file', 'a')).toBe(0);
    // 没有 id（或 id 对不上）时退回到「最后一个同名且还在跑」的调用，
    // 不能记到已经结束的那条上
    expect(resolveBtwToolIndex(tools, 'read_file')).toBe(1);
    expect(resolveBtwToolIndex(tools, 'read_file', 'missing')).toBe(1);
    expect(resolveBtwToolIndex(tools, 'unknown')).toBe(-1);

    expect(MAX_BTW_THINKING_CHARS).toBeGreaterThan(0);
    expect(MAX_BTW_TOOL_OUTPUT_CHARS).toBeGreaterThan(0);
  });
});

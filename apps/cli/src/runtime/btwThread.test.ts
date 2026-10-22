import { describe, expect, it, vi } from 'vitest';

import {
  BtwThreads,
  BtwThreadController,
  capBtwHead,
  capBtwTail,
  parseBtwToolArgs,
  persistableBtwMessages,
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
  /** 让挂住的 `query` 在 signal abort 时按真实实现的形状抛出 AbortError。 */
  honorAbort?: boolean;
  flushIntervalMs?: number;
};

function makeHarness(options: FakeOptions = {}) {
  const usageHistory: unknown[] = [];
  let finishReply: ((value: string) => void) | null = null;
  let failReply: ((error: unknown) => void) | null = null;
  const query = vi.fn(async (_input?: unknown, queryOptions?: { signal?: AbortSignal }) => {
    usageHistory.push({ usageId: usageHistory.length + 1 });
    if (options.reply) return await options.reply();
    if (options.pendingReply) {
      return await new Promise<string>((resolve, reject) => {
        finishReply = resolve;
        failReply = reject;
        if (options.honorAbort) {
          queryOptions?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }
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
    messages: unknown[];
    getSnapshot: () => { messages: unknown[] };
    loadSnapshot: (snapshot: { messages: unknown[] }) => void;
    onText?: (text: string) => void;
    onThinking?: (thinking: string) => void;
    onToolCall?: (name: string, args: string, id?: string) => void;
    onToolResult?: (name: string, result: string, id?: string) => void;
  } = {
    query,
    usageHistory,
    messages: [],
    getSnapshot: () => ({ messages: subagent.messages }),
    loadSnapshot: (snapshot) => {
      subagent.messages = snapshot.messages as unknown[];
    },
  };
  const createSubAgent = vi.fn(
    (_options?: { systemPrompt?: string; toolFilter?: (name: string) => boolean }) => subagent,
  );
  const saveCurrent = vi.fn();
  const agent = {
    config: { provider: { id: 'test' }, model: 'gpt-test', effort: 'medium' },
    isRunning: false,
    role: 'default',
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

  // 回答期间提交 = 排队（单槽位）。面板的 Enter/Tab 走这条路径，答完自动接上，
  // 不会并发开第二次提问（btw 复用同一个子代理，消息数组不是并发安全的）。
  it('queues a question while answering and runs it after', async () => {
    const harness = makeHarness({ pendingReply: true });
    harness.controller.ask('第一个问题');
    const queued = harness.controller.ask('第二个问题', { queue: true });
    expect(queued).toEqual({ ok: true });
    expect(harness.controller.snapshot().pendingQuestion).toBe('第二个问题');
    // 只留一个槽位：再排一条如实拒绝，而不是悄悄丢掉前一条
    expect(harness.controller.ask('第三个问题', { queue: true }).ok).toBe(false);

    harness.finishReply('第一个答案');
    await settle();
    await settle();
    expect(harness.query).toHaveBeenCalledTimes(2);
    expect(harness.controller.snapshot().entries).toMatchObject([
      { question: '第一个问题', status: 'completed' },
      { question: '第二个问题', status: 'running' },
    ]);
    expect(harness.controller.snapshot().pendingQuestion).toBeUndefined();
  });

  it('recalls a queued question without running it', async () => {
    const harness = makeHarness({ pendingReply: true });
    harness.controller.ask('第一个问题');
    harness.controller.ask('第二个问题', { queue: true });
    expect(harness.controller.recall()).toEqual({ ok: true, question: '第二个问题' });
    expect(harness.controller.snapshot().pendingQuestion).toBeUndefined();
    // 没有排队中的问题时如实返回，不假装成功
    expect(harness.controller.recall().ok).toBe(false);

    harness.finishReply('第一个答案');
    await settle();
    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  // 停止按钮：中断不是失败，已经流出的那半段仍是这一问的答案，历史要补回去，
  // 否则下一次追问时模型看不到刚才问过什么。
  it('interrupt marks the entry aborted and keeps the streamed answer', async () => {
    const harness = makeHarness({ pendingReply: true, honorAbort: true });
    harness.controller.ask('这个方案可行吗');
    await settle();
    // 已经流出来的那半段就是这一问的答案（与主对话 abort 同一条语义）
    harness.subagent.onText?.('半段回答');
    expect(harness.controller.interrupt()).toEqual({ ok: true });
    await settle();
    const [entry] = harness.controller.snapshot().entries;
    expect(entry.status).toBe('aborted');
    expect(entry.answer).toContain('半段回答');
    expect(harness.controller.running).toBe(false);
    // 没有在跑时再点停止是业务性失败，不抛
    expect(harness.controller.interrupt().ok).toBe(false);
  });

  it('rejects empty questions', () => {
    const harness = makeHarness();
    expect(harness.controller.ask('   ').ok).toBe(false);
    expect(harness.controller.snapshot().entries).toHaveLength(0);
  });

  it('compacts only its own thread history, never the main conversation', async () => {
    const harness = makeHarness();
    harness.controller.ask('这个方案可行吗');
    await settle();
    // 工具结果与图片是这条线程里唯一能占到大头的部分
    harness.subagent.messages = [
      { role: 'user', content: '这个方案可行吗' },
      {
        role: 'assistant',
        content: [
          {
            type: 'function_call',
            call_id: 'c1',
            name: 'read_file',
            arguments: '{"path":"src/a.ts"}',
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'x'.repeat(4000) }],
        tool_call_id: 'c1',
      },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { role: 'assistant', content: '看完了' },
    ];

    const result = await harness.controller.compact();
    expect(result.ok).toBe(true);
    // 对话文本一律保留，只把工具结果与媒体块换掉
    expect(JSON.stringify(harness.subagent.messages)).toContain('看完了');
    expect(JSON.stringify(harness.subagent.messages)).not.toContain('xxxx');
    expect(JSON.stringify(harness.subagent.messages)).not.toContain('base64');
    // 压缩后界面读这份估算（lastUsage 描述的是压缩前那次请求）
    expect(harness.controller.snapshot().context?.estimated).toBe(true);

    const again = await harness.controller.compact();
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.message).toContain('暂不需要压缩');
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
    expect(systemPrompt).toContain('<role name="default">');
    // 工具边界与主会话一致：主会话专属工具不进 btw。
    const toolFilter = harness.createSubAgent.mock.calls[1]?.[0]?.toolFilter;
    expect(typeof toolFilter).toBe('function');
    expect(toolFilter?.('read_file')).toBe(true);
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

  it('compacts its own history locally and reports the estimate until the next request', async () => {
    const harness = makeHarness({
      messages: [
        { role: 'user', content: '主流程问题' },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: `巨大的工具输出 ${'x'.repeat(4000)}`,
        },
      ],
    });
    // 假子代理要能被 loadSnapshot 改写：与真实 IAgent 同一形状（getSnapshot/loadSnapshot）。
    let snapshot = {
      messages: harness.agent.getSnapshot().messages,
      usageHistory: [] as unknown[],
    };
    Object.assign(harness.subagent, {
      getSnapshot: () => snapshot,
      loadSnapshot: (next: typeof snapshot) => {
        snapshot = next;
      },
    });
    harness.controller.ask('问题');
    await settle();

    const result = await harness.controller.compact();
    expect(result.ok).toBe(true);
    // 工具结果被换成占位符：本地压缩真的改写了这条线程自己的历史
    expect(JSON.stringify(snapshot.messages).length).toBeLessThan(2000);
    const context = harness.controller.snapshot().context;
    // 压缩后到下一次请求之前，占用读估算值（否则界面一直停在压缩前那个数字）
    expect(context?.estimated).toBe(true);
    expect(context?.tokens).toBeGreaterThan(0);

    // 没有线程 / 正忙时都是业务性拒绝，不抛错
    const empty = makeHarness();
    expect((await empty.controller.compact()).ok).toBe(false);
    const busy = makeHarness({ pendingReply: true });
    busy.controller.ask('问题');
    expect(await busy.controller.compact()).toMatchObject({ ok: false });
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

  it('drops media blocks before persisting, keeping the rest of the history', () => {
    const messages = [
      { role: 'user', content: '看看这张图' },
      { role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
      { role: 'assistant', content: '是只猫' },
      { role: 'user', content: [{ type: 'input_text', text: '谢谢' }] },
    ];
    const kept = persistableBtwMessages(messages);
    // base64 图片能让落盘文件涨到几十 MB，重启后模型也不再需要它；
    // 但同一批里的纯文本消息一条都不能少（那是「还能接着追问」的上下文）。
    expect(kept).toHaveLength(3);
    expect(JSON.stringify(kept)).not.toContain('input_image');
    expect(JSON.stringify(kept)).toContain('谢谢');
  });
});

describe('BtwThreads', () => {
  function makeThreads(options: { persist?: boolean } = {}) {
    const harness = makeHarness();
    const updates: string[] = [];
    const persisted: unknown[][] = [];
    const threads = new BtwThreads({
      agent: harness.agent,
      sessionController: harness.saveCurrent
        ? ({ saveCurrent: harness.saveCurrent } as unknown as CommandSessionController)
        : ({} as CommandSessionController),
      onUpdate: (thread) => updates.push(thread.id),
      ...(options.persist ? { onPersist: (state) => persisted.push(state) } : {}),
      flushIntervalMs: 0,
    });
    return { harness, threads, updates, persisted };
  }

  it('keeps tabs independent and names the thread that took each question', async () => {
    const { threads } = makeThreads();
    const first = threads.ask(null, '第一个问题');
    expect(first.ok).toBe(true);
    const firstId = (first as { threadId: string }).threadId;
    const second = threads.ask(null, '第二个问题');
    const secondId = (second as { threadId: string }).threadId;
    // 不传 id = 新 tab：两条线程有自己的快照
    expect(firstId).not.toBe(secondId);
    await settle();
    expect(threads.list()).toHaveLength(2);

    // 带上 id 就是在那个 tab 里追问
    const again = threads.ask(firstId, '接着问');
    expect(again).toMatchObject({ ok: true, threadId: firstId });
    await settle();
    const list = threads.list();
    expect(list.find((item) => item.id === firstId)?.entries).toHaveLength(2);
    expect(list.find((item) => item.id === secondId)?.entries).toHaveLength(1);
  });

  it('rebuilds a thread id it does not know instead of losing the question', async () => {
    const { threads } = makeThreads();
    // host 重启过 / 被淘汰：客户端手里的 id 还在，但 host 里没有。
    const result = threads.ask('stale-thread-id', '还在吗');
    expect(result).toMatchObject({ ok: true, threadId: 'stale-thread-id' });
    await settle();
    expect(threads.list().map((item) => item.id)).toContain('stale-thread-id');
  });

  it('refuses to close a thread that is still answering', async () => {
    // pendingReply：提问之后答案一直没回来，线程就处在「回答中」。
    const harness = makeHarness({ pendingReply: true });
    const threads = new BtwThreads({
      agent: harness.agent,
      sessionController: { saveCurrent: vi.fn() } as unknown as CommandSessionController,
      onUpdate: () => {},
      flushIntervalMs: 0,
    });
    const created = threads.ask(null, '挂住的问题') as { threadId: string };
    // 回答中的 tab 不能关：问题已经发出去了，关掉答案就再也没人收
    expect(threads.close(created.threadId)).toMatchObject({ ok: false });
    expect(threads.list().map((item) => item.id)).toContain(created.threadId);
  });

  it('restores persisted entries and messages, then flushes them back', async () => {
    const harness = makeHarness();
    let loaded: { messages?: unknown[] } | null = null;
    let snapshot = { messages: [] as unknown[], usageHistory: [] as unknown[] };
    Object.assign(harness.subagent, {
      getSnapshot: () => snapshot,
      loadSnapshot: (next: typeof snapshot) => {
        loaded = next;
        snapshot = next;
      },
    });
    const persisted: unknown[][] = [];
    const threads = new BtwThreads({
      agent: harness.agent,
      sessionController: { saveCurrent: vi.fn() } as unknown as CommandSessionController,
      onUpdate: () => {},
      onPersist: (state) => persisted.push(state),
      flushIntervalMs: 0,
    });

    threads.restore([
      {
        id: 'restored',
        entries: [{ id: 'e1', question: '上次问的', status: 'completed', startedAt: '' }],
        messages: [{ role: 'user', content: '上次问的' }],
      },
    ]);
    // 问答随线程一起恢复（这就是「关掉 app 再打开还在」）
    expect(threads.list().find((item) => item.id === 'restored')?.entries).toHaveLength(1);

    // 恢复出来的上下文要灌回新子代理：不然重启后模型看不到自己上一轮读过什么
    threads.ensure('restored').ask('接着上次说');
    await settle();
    expect(JSON.stringify(loaded)).toContain('上次问的');

    threads.flush();
    expect(JSON.stringify(persisted.at(-1))).toContain('上次问的');
  });
});

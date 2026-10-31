import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { micaCommands, type CommandRegistry } from '@packages/mica-commands/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import type {
  PluginContext,
  PluginNoticeOptions,
  PluginSubagentThread,
  PluginSubagentThreadAskOptions,
} from '@packages/mica-plugin/index.js';
import setupBtw from './index.js';
import { formatBtwNotice, formatBtwProgress, formatBtwStopped, parseBtwArgs } from './message.js';

/**
 * `/btw` 作为插件的行为：注册形态、进度与结果怎么呈现、`-continue` 复用的是哪条线程、
 * 停止与并发怎么处理、失败是否对用户可见。宿主能力（真正的子代理、记账、notice 渲染）
 * 由宿主自己的测试覆盖，这里用替身把它们隔开。
 */

describe('parseBtwArgs', () => {
  it('parses a plain question', () => {
    expect(parseBtwArgs('这个方案可行吗')).toEqual({
      kind: 'ask',
      question: '这个方案可行吗',
      isContinue: false,
    });
  });

  it('parses a continue with a follow-up', () => {
    expect(parseBtwArgs('-continue 那具体怎么落地')).toEqual({
      kind: 'ask',
      question: '那具体怎么落地',
      isContinue: true,
    });
    expect(parseBtwArgs('-c 那具体怎么落地')).toEqual({
      kind: 'ask',
      question: '那具体怎么落地',
      isContinue: true,
    });
  });

  it('parses stop and help', () => {
    expect(parseBtwArgs('-stop')).toEqual({ kind: 'stop' });
    expect(parseBtwArgs('--help')).toEqual({ kind: 'help' });
    expect(parseBtwArgs('')).toEqual({ kind: 'help' });
    expect(parseBtwArgs('   ')).toEqual({ kind: 'help' });
  });

  it('treats continue-only as help instead of a question', () => {
    expect(parseBtwArgs('-continue')).toEqual({ kind: 'help' });
    expect(parseBtwArgs('-continue   ')).toEqual({ kind: 'help' });
  });

  it('keeps a question that merely starts with a dash', () => {
    expect(parseBtwArgs('-5 的补码是什么')).toEqual({
      kind: 'ask',
      question: '-5 的补码是什么',
      isContinue: false,
    });
  });
});

describe('formatBtwNotice', () => {
  it('shows the question, answer, and a -continue affordance', () => {
    const notice = formatBtwNotice('这个方案可行吗', '可行。');
    expect(notice).toContain('> 这个方案可行吗');
    expect(notice).toContain('可行。');
    expect(notice).toContain('/btw -continue');
  });

  it('adds the elapsed time and request count when known', () => {
    const notice = formatBtwNotice('问题', '答案', { elapsedMs: 8_400, requests: 3 });
    expect(notice).toContain('8.4s');
    expect(notice).toContain('3 次请求');
  });

  it('says so when a continue had no thread to continue', () => {
    expect(formatBtwNotice('没有前文', '答案', { isFallback: true })).toContain('没有可延续的 btw 对话');
  });
});

describe('formatBtwProgress', () => {
  it('reports the tool, the streamed length, and how long it has been running', () => {
    expect(formatBtwProgress({ question: '问题', tool: 'grep_search', elapsedMs: 3_200 })).toBe(
      '> 问题\n正在调用 grep_search… · 3.2s（/btw -stop 停止）',
    );
    expect(formatBtwProgress({ question: '问题', answerChars: 1_240, elapsedMs: 8_400 })).toBe(
      '> 问题\n正在回答… 1.2k 字 · 8.4s（/btw -stop 停止）',
    );
    expect(formatBtwProgress({ question: '问题', elapsedMs: 0 })).toContain('正在思考…');
  });

  it('keeps the question on one line', () => {
    const text = formatBtwProgress({ question: `第一行\n${'很长的内容'.repeat(30)}`, elapsedMs: 1_000 });
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('…');
  });
});

describe('formatBtwStopped', () => {
  it('keeps the partial answer and points at -continue', () => {
    const notice = formatBtwStopped('问题', '已经说了一半');
    expect(notice).toContain('已停止');
    expect(notice).toContain('已经说了一半');
    expect(notice).toContain('/btw -continue');
  });
});

describe('/btw plugin', () => {
  it('registers /btw so it can run while the main flow is busy', () => {
    const harness = makeHarness();
    const command = harness.commands.list().find((item) => item.name === 'btw');
    expect(command).toBeDefined();
    expect(command?.scope).toBe('local-only');
    expect(command?.allowDuringTurn).toBe(true);
    expect(command?.pluginId).toBe('btw');
    const items = typeof command?.completionItems === 'function' ? command.completionItems() : command?.completionItems;
    expect(items?.map((item) => item.arg)).toEqual(['-continue', '-stop']);
  });

  it('answers in an isolated thread and reports progress then the result', async () => {
    const harness = makeHarness();
    await harness.run('/btw 这个方案可行吗');

    const call = harness.ask.mock.calls[0];
    expect(call?.[0]).toBe('这个方案可行吗');
    expect(call?.[1]).toMatchObject({ description: '这个方案可行吗' });
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.notices[0]?.content).toContain('> 这个方案可行吗');
    expect(harness.notices[0]?.content).toContain('/btw -stop');
    expect(harness.notices[0]?.options).toEqual({
      command: '/btw',
      status: 'running',
      surface: 'command_panel',
    });
    const last = harness.notices.at(-1);
    expect(last?.content).toContain('> 这个方案可行吗');
    expect(last?.content).toContain('/btw -continue');
    expect(last?.options).toEqual({ command: '/btw', status: 'success' });
  });

  it('streams tool calls into the progress panel', async () => {
    const harness = makeHarness({
      ask: vi.fn(async (_question: string, options: PluginSubagentThreadAskOptions = {}) => {
        options.onToolCall?.('grep_search', '{}', 'call_1');
        expect(harnessNotices(harness).at(-1)?.content).toContain('grep_search');
        options.onToolResult?.('grep_search', 'ok', 'call_1');
        return '答案';
      }),
    });
    await harness.run('/btw 问题');

    expect(harness.notices.at(-1)?.content).toContain('答案');
  });

  it('gives the thread the main transcript, the session role, and a btw type for accounting', async () => {
    const harness = makeHarness();
    await harness.run('/btw 这个方案可行吗');

    const options = harness.threadOptions[0];
    expect(options.type).toBe('btw');
    expect(options.systemPrompt).toContain('用户：主流程在写代码');
    expect(options.systemPrompt).toContain('<role name="default">');
  });

  it('reuses the same thread on -continue', async () => {
    const harness = makeHarness();
    await harness.run('/btw 这个方案可行吗');
    await harness.run('/btw -continue 那具体怎么落地');

    expect(harness.threadOptions).toHaveLength(1);
    expect(harness.ask).toHaveBeenCalledTimes(2);
    expect(harness.ask.mock.calls[1]?.[0]).toBe('那具体怎么落地');
  });

  it('disposes the previous thread when a new topic starts', async () => {
    const harness = makeHarness();
    await harness.run('/btw 第一问');
    await harness.run('/btw 第二问');

    expect(harness.threadOptions).toHaveLength(2);
    expect(harness.disposed).toHaveBeenCalledOnce();
  });

  it('falls back to a new thread and says so when continuing with no prior btw', async () => {
    const harness = makeHarness();
    await harness.run('/btw -continue 没有前文');

    expect(harness.threadOptions).toHaveLength(1);
    expect(harness.notices.at(-1)?.content).toContain('没有可延续的 btw 对话，已作为一条新问题处理');
  });

  it('starts a new thread after the session changed', async () => {
    const harness = makeHarness();
    await harness.run('/btw 第一问');
    harness.setSession('s2');
    await harness.run('/btw 第二问');

    expect(harness.threadOptions).toHaveLength(2);
  });

  it('shows the usage when there is no question', async () => {
    const harness = makeHarness();
    await harness.run('/btw');

    expect(harness.threadOptions).toHaveLength(0);
    expect(harness.notices[0]?.content).toContain('用法');
    expect(harness.notices[0]?.options).toEqual({ command: '/btw', status: 'info' });
  });

  it('refuses a second question while one is still answering', async () => {
    const harness = makeHarness({ ask: deferredAsk() });
    const first = harness.run('/btw 第一问');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledTimes(1));

    await harness.run('/btw 第二问');
    expect(harness.notices.at(-1)?.content).toContain('上一个 btw 还在回答中');
    expect(harness.notices.at(-1)?.options).toEqual({ command: '/btw', status: 'warning' });
    expect(harness.ask).toHaveBeenCalledTimes(1);

    harness.resolveAsk('答案');
    await first;
    expect(harness.notices.at(-1)?.content).toContain('答案');
  });

  it('stops the in-flight question and keeps the streamed text', async () => {
    const harness = makeHarness({ ask: deferredAsk() });
    const first = harness.run('/btw 一个很长的问题');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledTimes(1));
    harness.ask.mock.calls[0]?.[1]?.onText?.('已经流出来的部分');

    await harness.run('/btw -stop');
    await first;

    const last = harness.notices.at(-1);
    expect(last?.content).toContain('已停止');
    expect(last?.content).toContain('已经流出来的部分');
    expect(last?.options).toEqual({ command: '/btw', status: 'warning' });
  });

  it('reports when there is nothing to stop', async () => {
    const harness = makeHarness();
    await harness.run('/btw -stop');

    expect(harness.notices.at(-1)?.content).toContain('当前没有正在回答的 btw');
    expect(harness.notices.at(-1)?.options).toEqual({ command: '/btw', status: 'info' });
  });

  it('reports a failure instead of leaving the running notice on screen', async () => {
    const harness = makeHarness({ ask: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await harness.run('/btw 问题');

    const last = harness.notices.at(-1);
    expect(last?.content).toContain('btw 出错：boom');
    expect(last?.options).toEqual({ command: '/btw', status: 'error' });
  });

  it('reports why the thread could not be created', async () => {
    const harness = makeHarness({ threadError: new Error('未配置 api_key') });
    await harness.run('/btw 问题');

    expect(harness.notices.at(-1)?.content).toContain('btw 暂时不可用：未配置 api_key');
  });

  it('refuses to run without a session', async () => {
    const harness = makeHarness();
    harness.clearSession();
    await harness.run('/btw 问题');

    expect(harness.threadOptions).toHaveLength(0);
    expect(harness.notices.at(-1)?.options).toEqual({ command: '/btw', status: 'error' });
  });

  it('disposes the threads it opened', async () => {
    const harness = makeHarness();
    await harness.run('/btw 问题');
    harness.dispose();

    expect(harness.disposed).toHaveBeenCalledOnce();
  });

  it('does not write an old session answer or progress into the newly selected session', async () => {
    const harness = makeHarness({ ask: deferredAsk() });
    const first = harness.run('/btw 第一问');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledOnce());
    const noticesBeforeSwitch = harness.notices.length;
    harness.setSession('s2');
    harness.ask.mock.calls[0]?.[1]?.onToolCall?.('grep_search', '{}', 'call-1');
    harness.resolveAsk('第一条会话的答案');
    await first;
    expect(harness.notices).toHaveLength(noticesBeforeSwitch);
  });

  it('routes progress and the completed answer to the captured owner after switching away', async () => {
    const harness = makeHarness({ ask: deferredAsk(), captureOwner: true });
    const first = harness.run('/btw 第一问');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledOnce());
    const ownerA = harness.notices[0]?.options?.owner;
    expect(ownerA).toBeDefined();
    const noticesBeforeSwitch = harness.notices.length;
    harness.setSession('s2');
    harness.ask.mock.calls[0]?.[1]?.onToolCall?.('grep_search', '{}', 'call-1');
    harness.resolveAsk('第一条会话的答案');
    await first;

    expect(harness.notices).toHaveLength(noticesBeforeSwitch + 2);
    expect(harness.notices.slice(noticesBeforeSwitch).every((notice) => notice.options?.owner === ownerA)).toBe(true);
    expect(harness.notices.at(-1)?.content).toContain('第一条会话的答案');
    expect(harness.notices.at(-1)?.options?.status).toBe('success');
  });

  it('drops callbacks when the captured controller resumed a different session', async () => {
    const harness = makeHarness({ ask: deferredAsk(), captureOwner: true });
    const first = harness.run('/btw 第一问');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledOnce());
    const ownerA = harness.notices[0]?.options?.owner;
    const noticesBeforeResume = harness.notices.length;
    harness.setSession('s2');
    harness.resumeOwner(ownerA, 's3');
    harness.ask.mock.calls[0]?.[1]?.onToolCall?.('grep_search', '{}', 'call-1');
    harness.resolveAsk('恢复前的过期答案');
    await first;
    expect(harness.notices).toHaveLength(noticesBeforeResume);
  });

  it('drops callbacks after the captured owner is disposed', async () => {
    const harness = makeHarness({ ask: deferredAsk(), captureOwner: true });
    const first = harness.run('/btw 第一问');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledOnce());
    const ownerA = harness.notices[0]?.options?.owner;
    const noticesBeforeDispose = harness.notices.length;
    harness.setSession('s2');
    harness.disposeOwner(ownerA);
    harness.ask.mock.calls[0]?.[1]?.onToolCall?.('grep_search', '{}', 'call-1');
    harness.resolveAsk('已关闭会话的答案');
    await first;
    expect(harness.notices).toHaveLength(noticesBeforeDispose);
  });

  it('stops emitting notices when the plugin is disposed during an ask', async () => {
    const harness = makeHarness({ ask: deferredAsk() });
    const first = harness.run('/btw 第一问');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledOnce());
    const noticesBeforeDispose = harness.notices.length;
    harness.dispose();
    harness.ask.mock.calls[0]?.[1]?.onToolCall?.('grep_search', '{}', 'call-1');
    await first;
    expect(harness.notices).toHaveLength(noticesBeforeDispose);
  });

  it('keeps the stopped outcome when the provider resolves after cancellation', async () => {
    const harness = makeHarness({ ask: deferredAsk(true) });
    const first = harness.run('/btw 第一问');
    await vi.waitFor(() => expect(harness.ask).toHaveBeenCalledOnce());
    harness.ask.mock.calls[0]?.[1]?.onText?.('部分答案');
    await harness.run('/btw -stop');
    harness.resolveAsk('provider swallowed the abort');
    await first;
    expect(harness.notices.at(-1)?.options?.status).toBe('warning');
    expect(harness.notices.at(-1)?.content).toContain('已停止');
    expect(harness.notices.at(-1)?.content).toContain('部分答案');
  });

  it('clears the progress timer immediately on disposal even if the provider delays aborting', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ ask: deferredAsk(true) });
    const first = harness.run('/btw 问题');
    try {
      expect(harness.ask).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      harness.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      harness.resolveAsk('finished');
      await first;
      vi.useRealTimers();
    }
  });
});

describe('/btw long-running resources', () => {
  it('disposes closed-session threads over hundreds of session lifecycles and retains other owners', async () => {
    const harness = makeHarness({ captureOwner: true });
    await harness.run('/btw retained owner');
    const ownerA = harness.notices[0]?.options?.owner;
    for (let index = 0; index < 200; index++) {
      harness.setSession(`closed-${index}`);
      await harness.run('/btw temporary question');
      harness.disposeOwner(harness.notices.at(-1)?.options?.owner);
    }
    console.info(
      'btw lifecycle retention',
      JSON.stringify({ created: harness.threadOptions.length, disposed: harness.disposed.mock.calls.length }),
    );
    expect(harness.disposed).toHaveBeenCalledTimes(200);
    harness.setSession('s1');
    await harness.run('/btw -continue retained follow-up');
    expect(harness.notices.at(-1)?.options?.owner).toBe(ownerA);
    expect(harness.threadOptions).toHaveLength(201);
    harness.dispose();
    expect(harness.disposed).toHaveBeenCalledTimes(201);
    expect(harness.lifecycleDisposed).toHaveBeenCalledOnce();
    harness.events.publish({ type: 'session:disposed', owner: ownerA });
    expect(harness.disposed).toHaveBeenCalledTimes(201);
  });

  it('counts streamed output beyond the partial-answer cap and labels the retained prefix on stop', async () => {
    vi.useFakeTimers();
    const harness = makeHarness({ ask: deferredAsk(true) });
    const running = harness.run('/btw long answer');
    try {
      const onText = harness.ask.mock.calls[0]?.[1]?.onText;
      for (let index = 0; index < 100; index++) onText?.('x'.repeat(1_000));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(harness.notices.at(-1)?.content).toContain('100k 字');
      await harness.run('/btw -stop');
      expect(vi.getTimerCount()).toBe(0);
      onText?.('discard-after-stop');
      harness.resolveAsk('provider resolved after stop');
      await running;
      expect(harness.notices.at(-1)?.content).toContain('截断');
      expect(harness.notices.at(-1)?.content).not.toContain('discard-after-stop');
      expect(harness.notices.at(-1)!.content.length).toBeLessThan(21_000);
    } finally {
      harness.resolveAsk('finished');
      await running;
      harness.dispose();
      vi.useRealTimers();
    }
  });
});

type Harness = {
  events: InstanceType<typeof micaRuntime.RuntimeEventBus>;
  lifecycleDisposed: MockInstance;
  commands: CommandRegistry;
  notices: Array<{ content: string; options?: PluginNoticeOptions }>;
  ask: ReturnType<typeof vi.fn>;
  threadOptions: Array<Record<string, unknown>>;
  disposed: ReturnType<typeof vi.fn>;
  setSession(id: string): void;
  resumeOwner(owner: unknown, id: string): void;
  disposeOwner(owner: unknown): void;
  clearSession(): void;
  dispose(): void;
  run(raw: string): Promise<unknown>;
};

function harnessNotices(harness: Harness): Harness['notices'] {
  return harness.notices;
}

/** 一问答到一半的 ask：等测试显式 resolve，返回的 promise 才结算。 */
function deferredAsk(ignoreAbort = false) {
  let resolve!: (answer: string) => void;
  const ask = vi.fn(
    (_question: string, options?: PluginSubagentThreadAskOptions) =>
      new Promise<string>((done, reject) => {
        resolve = done;
        // 与真实宿主一致：中断时这一问以异常结束，收尾（展示已流出的正文）在 catch 里。
        if (!ignoreAbort) options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  return Object.assign(ask, {
    resolveAnswer: (answer: string) => resolve(answer),
  }) as ReturnType<typeof vi.fn> & { resolveAnswer(answer: string): void };
}

function makeHarness(
  overrides: { ask?: ReturnType<typeof vi.fn>; threadError?: Error; captureOwner?: boolean } = {},
): Harness & { resolveAsk(answer: string): void } {
  const commands = new micaCommands.CommandRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const subscriptions = vi.spyOn(events, 'on');
  const notices: Harness['notices'] = [];
  const ask = overrides.ask ?? vi.fn(async () => '答案');
  const disposed = vi.fn();
  const thread: PluginSubagentThread = { ask, usage: () => ({ requests: 1, last: null }), dispose: disposed };
  const threadOptions: Array<Record<string, unknown>> = [];
  const disposes: Array<() => void> = [];
  let session: { id: string; title: string; role: string } | null = { id: 's1', title: 'session', role: 'default' };
  let currentOwner: unknown = {};
  const ownersById = new Map<string, unknown>([['s1', currentOwner]]);
  const sessionsByOwner = new Map<unknown, typeof session>([[currentOwner, session]]);

  const ctx = {
    pluginId: 'btw',
    commands,
    events,
    session: {
      captureOwner: overrides.captureOwner ? () => currentOwner : undefined,
      describe: (owner?: unknown) => (owner === undefined ? session : (sessionsByOwner.get(owner) ?? null)),
      messages: () => [
        { role: 'user', content: '主流程在写代码' },
        { role: 'assistant', content: '收到。' },
      ],
      rename: () => true,
    },
    subagents: {
      thread: (options: Record<string, unknown>) => {
        if (overrides.threadError) throw overrides.threadError;
        threadOptions.push(options);
        return thread;
      },
    },
    ui: {
      submit() {},
      showMessage() {},
      notice(content: string, options?: PluginNoticeOptions) {
        notices.push({ content, options });
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    onDispose(dispose: () => void) {
      disposes.push(dispose);
    },
  } as unknown as PluginContext;

  setupBtw(ctx);

  return {
    commands,
    events,
    notices,
    lifecycleDisposed: vi.spyOn(subscriptions.mock.results[0]!.value, 'dispose'),
    ask,
    threadOptions,
    disposed,
    setSession(id) {
      currentOwner = ownersById.get(id) ?? {};
      ownersById.set(id, currentOwner);
      session = sessionsByOwner.get(currentOwner) ?? { id, title: id, role: 'default' };
      sessionsByOwner.set(currentOwner, session);
    },
    resumeOwner(owner, id) {
      const resumed = { id, title: id, role: 'default' };
      sessionsByOwner.set(owner, resumed);
      if (owner === currentOwner) session = resumed;
      events.publish({ type: 'session:invalidated', reason: 'resume', owner });
    },
    disposeOwner(owner) {
      sessionsByOwner.delete(owner);
      if (owner === currentOwner) session = null;
      events.publish({ type: 'session:disposed', owner });
    },
    clearSession() {
      session = null;
    },
    dispose() {
      for (const dispose of disposes) dispose();
    },
    run: (raw) => commands.execute(raw, {}),
    resolveAsk(answer: string) {
      (ask as unknown as { resolveAnswer?: (value: string) => void }).resolveAnswer?.(answer);
    },
  };
}

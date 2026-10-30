import { describe, expect, it, vi } from 'vitest';
import { micaCommands, type CommandRegistry } from '@packages/mica-commands/index.js';
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
    expect(formatBtwNotice('没有前文', '答案', { isFallback: true })).toContain(
      '没有可延续的 btw 对话',
    );
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
    const items =
      typeof command?.completionItems === 'function'
        ? command.completionItems()
        : command?.completionItems;
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
});

type Harness = {
  commands: CommandRegistry;
  notices: Array<{ content: string; options?: PluginNoticeOptions }>;
  ask: ReturnType<typeof vi.fn>;
  threadOptions: Array<Record<string, unknown>>;
  disposed: ReturnType<typeof vi.fn>;
  setSession(id: string): void;
  clearSession(): void;
  dispose(): void;
  run(raw: string): Promise<unknown>;
};

function harnessNotices(harness: Harness): Harness['notices'] {
  return harness.notices;
}

/** 一问答到一半的 ask：等测试显式 resolve，返回的 promise 才结算。 */
function deferredAsk() {
  let resolve!: (answer: string) => void;
  const ask = vi.fn(
    (_question: string, options?: PluginSubagentThreadAskOptions) =>
      new Promise<string>((done, reject) => {
        resolve = done;
        // 与真实宿主一致：中断时这一问以异常结束，收尾（展示已流出的正文）在 catch 里。
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  return Object.assign(ask, {
    resolveAnswer: (answer: string) => resolve(answer),
  }) as ReturnType<typeof vi.fn> & { resolveAnswer(answer: string): void };
}

function makeHarness(
  overrides: { ask?: ReturnType<typeof vi.fn>; threadError?: Error } = {},
): Harness & { resolveAsk(answer: string): void } {
  const commands = new micaCommands.CommandRegistry();
  const notices: Harness['notices'] = [];
  const ask = overrides.ask ?? vi.fn(async () => '答案');
  const disposed = vi.fn();
  const thread: PluginSubagentThread = { ask, usage: () => ({ requests: 1, last: null }), dispose: disposed };
  const threadOptions: Array<Record<string, unknown>> = [];
  const disposes: Array<() => void> = [];
  let session: { id: string; title: string; role: string } | null = { id: 's1', title: 'session', role: 'default' };

  const ctx = {
    pluginId: 'btw',
    commands,
    session: {
      describe: () => session,
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
    notices,
    ask,
    threadOptions,
    disposed,
    setSession(id) {
      session = { id, title: id, role: 'default' };
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

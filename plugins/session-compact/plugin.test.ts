import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  PluginBackgroundTask,
  PluginContext,
  PluginIdleCompactOptions,
  PluginIdleCompactOutcome,
  PluginSessionMenuHandler,
  PluginTurnPrepareEvent,
} from '@packages/mica-plugin/index.js';
import type {
  RuntimeInput,
  RuntimeInputSource,
  RuntimeTurnAfterHookEvent,
  RuntimeTurnBeforeHookEvent,
  SubmitOptions,
  SubmitResult,
} from '@packages/mica-runtime/index.js';
import { HANDOFF_MARKER, RESUME_MARKER, type AutoCompactState } from './autoCompact.js';
import setup from './index.js';

type Notice = { content: string; options?: { status?: string; variant?: string } };
type UiMessage = { role: string; content: unknown };

type HarnessOptions = {
  /** 最近一次请求的 inputTokens；null 表示还没发过请求。 */
  usage?: number | null;
  contextWindowSize?: number;
  /** 依次返回的压缩结果；用完就退回 createHarness 的第一个参数。 */
  compact?: Array<PluginIdleCompactOutcome | Error>;
  settings?: Record<string, string>;
  messages?: UiMessage[];
  /** 排队槽里已有的输入。 */
  queue?: string[];
  /** 依次返回的提交结果；用完就是 ok。 */
  submit?: SubmitResult[];
  summary?: string;
  configured?: boolean;
  configDir?: string;
  sessionId?: string;
};

type Harness = {
  run: (action: string) => Promise<{ message?: string } | void>;
  prepare: (event: PluginTurnPrepareEvent) => Promise<void>;
  before: (event: RuntimeTurnBeforeHookEvent) => Promise<void>;
  after: (event: { input: RuntimeInput; outcome: RuntimeTurnAfterHookEvent['outcome'] }) => Promise<void>;
  tick: () => Promise<void>;
  calls: PluginIdleCompactOptions[];
  requests: Array<{ purpose: string; system: string; user: string }>;
  notices: Notice[];
  logs: Array<{ event: string; data?: unknown }>;
  submitted: Array<{ text: string; options?: SubmitOptions }>;
  state: () => AutoCompactState | undefined;
  setState: (value: AutoCompactState) => void;
  setUsage: (tokens: number | null) => void;
  setMessages: (messages: UiMessage[]) => void;
  setQueue: (texts: string[]) => void;
  rewindPhase: (ms: number) => void;
  input: (text: string, source?: RuntimeInputSource) => RuntimeInput;
};

const applied = (beforeTokens = 806_000, afterTokens = 46_000): PluginIdleCompactOutcome => ({
  status: 'applied',
  beforeTokens,
  afterTokens,
  savedTokens: beforeTokens - afterTokens,
});

const skipped = (reason: 'busy' | 'empty'): PluginIdleCompactOutcome => ({ status: 'skipped', reason });

function createHarness(
  outcome: PluginIdleCompactOutcome | Error,
  options: HarnessOptions = {},
): Harness {
  const calls: PluginIdleCompactOptions[] = [];
  const requests: Harness['requests'] = [];
  const notices: Notice[] = [];
  const logs: Harness['logs'] = [];
  const submitted: Harness['submitted'] = [];
  const hooks = new Map<string, Array<(event: never) => unknown>>();
  const compactQueue = [...(options.compact ?? [])];
  const submitQueue = [...(options.submit ?? [])];
  const queue = [...(options.queue ?? [])];
  let usage = options.usage === undefined ? null : options.usage;
  let messages: UiMessage[] = [...(options.messages ?? [])];
  let state: AutoCompactState | undefined;
  let background: PluginBackgroundTask | undefined;
  let ticks = 0;
  let seq = 0;
  let handler: PluginSessionMenuHandler = { run: async () => ({ message: '未注册' }) };

  const input = (text: string, source: RuntimeInputSource = 'ui'): RuntimeInput => ({
    id: `in-${++seq}`,
    text,
    source,
    createdAt: Date.now(),
  });

  const values = {
    autoCompact: 'true',
    thresholdTokens: '400000',
    modelCompactThreshold: '100000',
    minIntervalMinutes: '10',
    autoResume: 'true',
    saveHandover: 'true',
    ...options.settings,
  };

  const nextOutcome = (): PluginIdleCompactOutcome => {
    const next = compactQueue.length > 0 ? compactQueue.shift()! : outcome;
    if (next instanceof Error) throw next;
    return next;
  };

  const compactIdleHistory = async (compactOptions: PluginIdleCompactOptions = {}) => {
    calls.push(compactOptions);
    const result = nextOutcome();
    if (result.status === 'applied') {
      compactOptions.afterApply?.({
        savedTokens: result.savedTokens,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
      });
    }
    return result;
  };

  setup({
    pluginId: 'session-compact',
    health: { report: () => undefined },
    logger: {
      info: (event: string, data?: unknown) => logs.push({ event, data }),
      warn: (event: string, data?: unknown) => logs.push({ event, data }),
      error: (event: string, data?: unknown) => logs.push({ event, data }),
    },
    ui: { notice: (content: string, noticeOptions?: Notice['options']) => notices.push({ content, options: noticeOptions }) },
    hooks: {
      on: (name: string, hook: (event: never) => unknown) => {
        const list = hooks.get(name) ?? [];
        list.push(hook);
        hooks.set(name, list);
        return { dispose() {} };
      },
    },
    onDispose: () => {},
    desktop: {
      sessionMenu: (value: PluginSessionMenuHandler) => {
        handler = value;
      },
    },
    agent: {
      mode: 'session',
      compactIdleHistory,
      lastUsage: () => (usage === null ? null : { inputTokens: usage, model: 'test-model' }),
      contextWindowSize: options.contextWindowSize,
    },
    session: {
      describe: () => ({ id: options.sessionId ?? 'session-1', title: '测试会话', model: 'test-model' }),
      messages: () => messages,
      rename: () => true,
    },
    sessionState: {
      get: () => state,
      set: (value: unknown) => {
        state = value as AutoCompactState;
      },
      clear: () => {
        state = undefined;
      },
    },
    settings: {
      path: null,
      get: () => values,
      validate: () => [],
      set: () => values,
    },
    runtime: {
      submit: async (text: string, submitOptions?: SubmitOptions) => {
        submitted.push({ text, ...(submitOptions ? { options: submitOptions } : {}) });
        return submitQueue.shift() ?? { ok: true };
      },
      queue: {
        isBusy: () => queue.length > 0,
        enqueue: (_owner: object, queued: RuntimeInput) => {
          queue.push(queued.text);
          return true;
        },
        dequeue: () => (queue.length > 0 ? input(queue.shift()!) : null),
        list: () => queue.map((text) => input(text)),
      },
    },
    background: {
      register: (task: PluginBackgroundTask) => {
        background = task;
        return { dispose() {} };
      },
      list: () => [],
      disposeAll: () => {},
    },
    paths: options.configDir
      ? { home: options.configDir, config: options.configDir, plugins: options.configDir }
      : undefined,
    llm: {
      configured: () => options.configured !== false,
      config: () => ({ useMainProvider: true, baseUrl: '', apiKey: '', protocol: 'openai_chat_completions', model: '' }),
      describe: () => '测试模型',
      request: async (request: { purpose: string; system: string; user: string }) => {
        requests.push(request);
        return { text: options.summary ?? '## 摘要' };
      },
    },
  } as unknown as PluginContext);

  const runHooks = async (name: string, event: unknown) => {
    for (const hook of hooks.get(name) ?? []) await (hook as (value: unknown) => unknown)(event);
  };

  const turnAfter = (
    event: Pick<RuntimeTurnAfterHookEvent, 'input' | 'outcome'>,
  ): RuntimeTurnAfterHookEvent => ({
    input: event.input,
    outcome: event.outcome,
    elapsedMs: 10,
    hasError: event.outcome === 'error',
    owner: {},
  });

  return {
    run: async (action) => handler.run({ action }),
    prepare: (event) => runHooks('turn:prepare', event) as Promise<void>,
    before: (event) => runHooks('turn:before', event) as Promise<void>,
    after: (event) => runHooks('turn:after', turnAfter(event)) as Promise<void>,
    tick: async () => {
      if (!background) return;
      await background.run({ signal: new AbortController().signal, tick: ++ticks });
    },
    calls,
    requests,
    notices,
    logs,
    submitted,
    state: () => state,
    setState: (value) => {
      state = value;
    },
    setUsage: (tokens) => {
      usage = tokens;
    },
    setMessages: (next) => {
      messages = next;
    },
    setQueue: (texts) => {
      queue.splice(0, queue.length, ...texts);
    },
    rewindPhase: (ms) => {
      if (state?.phaseAt !== undefined) state = { ...state, phaseAt: state.phaseAt - ms };
    },
    input,
  };
}

describe('session compaction menu', () => {
  it('quickly compacts only after an effective model configuration change', async () => {
    const harness = createHarness(applied());
    const compactCalls: Array<{ mode?: 'quick' }> = [];
    const config = { providerId: 'p', model: 'a', effort: 'low' };
    const compactHistory = async (options?: { mode?: 'quick' }) => {
      compactCalls.push(options ?? {});
      return applied();
    };
    await harness.prepare({ previous: config, current: { ...config }, compactHistory });
    expect(compactCalls).toEqual([]);
    await harness.prepare({ previous: config, current: { ...config, effort: 'high' }, compactHistory });
    for (const current of [{ ...config, model: 'b' }, { ...config, providerId: 'q' }]) {
      await harness.prepare({ previous: config, current, compactHistory });
    }
    expect(compactCalls).toEqual([{ mode: 'quick' }, { mode: 'quick' }]);
    // 轮前这条路没有菜单可以回话：压了什么写日志，不往对话里发 notice。
    expect(harness.notices).toEqual([]);
    expect(harness.logs.map((entry) => entry.event)).toEqual([
      'compact.turn-prepare',
      'compact.turn-prepare',
    ]);
  });

  it('keeps the turn alive and says so when the automatic compaction fails', async () => {
    const harness = createHarness(applied());
    const config = { providerId: 'p', model: 'a', effort: 'low' };
    const compactHistory = async () => {
      throw new Error('压缩结果没能写入会话文件，已保留原历史');
    };

    // 处理器不抛错：宿主的 failPolicy 会吞掉异常，用户就只剩「什么都没发生」。
    await expect(
      harness.prepare({ previous: config, current: { ...config, model: 'b' }, compactHistory }),
    ).resolves.toBeUndefined();
    expect(harness.notices.map((notice) => notice.content)).toEqual([
      '切换模型后的自动快速压缩没做成：压缩结果没能写入会话文件，已保留原历史。这一轮照常发送。',
    ]);
    expect(harness.logs[0]).toMatchObject({ event: 'compact.turn-prepare-failed' });
  });

  it('stays quiet when the turn itself was cancelled during preparation', async () => {
    const harness = createHarness(applied());
    const config = { providerId: 'p', model: 'a', effort: 'low' };
    const compactHistory = async () => {
      const abort = new Error('aborted');
      abort.name = 'AgentAbortError';
      throw abort;
    };

    await harness.prepare({ previous: config, current: { ...config, model: 'b' }, compactHistory });
    expect(harness.notices).toEqual([]);
    expect(harness.logs).toEqual([]);
  });

  it('quick compaction only replaces tool results', async () => {
    const harness = createHarness(applied());

    const result = await harness.run('quick');

    // 快速压缩就是本地清理：既不传摘要请求，也不惊动模型。
    expect(harness.calls).toEqual([{ mode: 'quick' }]);
    expect(harness.requests).toEqual([]);
    expect(result?.message).toBe('快速压缩完成：806K → 约 46K（清掉 760K）');
  });

  it('model compaction sends the dialogue through the plugin llm', async () => {
    const harness = createHarness(applied());

    const result = await harness.run('model');

    expect(harness.calls.map((call) => call.mode)).toEqual(['model']);
    const summarize = harness.calls[0]!.summarize!;
    await expect(summarize('用户：看看构建为什么慢', '写一段摘要')).resolves.toBe('## 摘要');
    expect(harness.requests[0]).toMatchObject({
      purpose: '会话压缩摘要',
      system: '写一段摘要',
      user: '用户：看看构建为什么慢',
    });
    expect(result?.message).toBe('模型压缩完成：806K → 约 46K（清掉 760K）');
  });

  it('reports why nothing happened instead of failing silently', async () => {
    expect(await createHarness(skipped('busy')).run('quick')).toEqual({
      outcome: 'busy', code: 'session_busy',
      message: '这条会话正忙，等这一轮结束再压',
    });
    expect(await createHarness(skipped('empty')).run('quick')).toEqual({
      outcome: 'skipped', code: 'empty',
      message: '没有可清理的工具结果',
    });
    expect(await createHarness(skipped('empty')).run('model')).toEqual({
      outcome: 'skipped', code: 'empty',
      message: '当前没有可压缩的历史，或压缩后预计不会节省上下文',
    });
  });

  it('does not call the model when the summarization model is unconfigured', async () => {
    const harness = createHarness(applied(), { configured: false });

    expect(await harness.run('model')).toEqual({
      outcome: 'declined', code: 'unconfigured',
      message: '压缩摘要模型未配置：在插件设置里复用当前会话模型，或填写接口地址与模型',
    });
    expect(harness.calls).toEqual([]);
  });

  it('turns a host failure into a readable menu message', async () => {
    expect(await createHarness(new Error('摘要请求超时')).run('model')).toEqual({
      outcome: 'error', code: 'compact_failed',
      message: '模型压缩失败：摘要请求超时',
    });
  });

  it('ignores unknown actions', async () => {
    const harness = createHarness(applied());

    expect(await harness.run('compact-everything')).toEqual({ outcome: 'declined', code: 'unknown_action', message: '未知动作：compact-everything' });
    expect(harness.calls).toEqual([]);
  });
});

describe('自动交接压缩', () => {
  const turn = (h: Harness, text = '把构建改快一点') => h.input(text);

  it('到阈值就以插件身份发出交接请求，不到阈值什么都不做', async () => {
    const quiet = createHarness(applied(), { usage: 399_000 });
    await quiet.after({ input: turn(quiet), outcome: 'completed' });
    expect(quiet.submitted).toEqual([]);

    const harness = createHarness(applied(), { usage: 420_000 });
    await harness.after({ input: turn(harness), outcome: 'completed' });

    expect(harness.submitted).toHaveLength(1);
    const [handoff] = harness.submitted;
    expect(handoff!.text.startsWith(HANDOFF_MARKER)).toBe(true);
    expect(handoff!.text).toContain('420.0K');
    expect(handoff!.options).toMatchObject({ source: 'plugin' });
    expect(handoff!.options?.displayText).toContain('先写交接文档');
    expect(harness.state()).toMatchObject({ phase: 'handoff', triggeredAt: expect.any(Number) });
  });

  it('窗口比阈值小时按窗口的 90% 提前触发', async () => {
    const harness = createHarness(applied(), { usage: 190_000, contextWindowSize: 200_000 });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.text).toContain('180.0K');
  });

  it('失败/中止的那一轮不作为触发点', async () => {
    const harness = createHarness(applied(), { usage: 420_000 });
    await harness.after({ input: turn(harness), outcome: 'aborted' });
    expect(harness.submitted).toEqual([]);
  });

  it('轮到交接那一轮：快速压缩就够时不再做模型压缩，随后发「继续」', async () => {
    const harness = createHarness(applied(), {
      usage: 420_000,
      compact: [applied(420_000, 40_000)],
    });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    const handoff = harness.submitted[0]!.text;

    harness.setMessages([
      { role: 'user', content: turn(harness).text },
      { role: 'assistant', content: '## 待办\n- 改 cache' },
    ]);
    await harness.after({ input: harness.input(handoff, 'plugin'), outcome: 'completed' });
    expect(harness.state()).toMatchObject({ phase: 'compact' });

    await harness.tick();
    expect(harness.calls.map((call) => call.mode)).toEqual(['quick']);
    expect(harness.state()).toMatchObject({ phase: 'resume', compactedTokens: 40_000 });
    expect(harness.submitted).toHaveLength(1);

    harness.rewindPhase(5_000);
    await harness.tick();
    expect(harness.submitted).toHaveLength(2);
    expect(harness.submitted[1]!.text.startsWith(RESUME_MARKER)).toBe(true);
    expect(harness.state()).toMatchObject({ phase: 'resuming' });

    await harness.after({ input: harness.input(harness.submitted[1]!.text, 'plugin'), outcome: 'completed' });
    expect(harness.state()).toMatchObject({ phase: 'idle' });
  });

  it('快速压缩后仍高于 100K 就补一次模型压缩', async () => {
    const harness = createHarness(applied(), {
      usage: 420_000,
      summary: '## Pending Tasks\n- 改 cache',
      compact: [applied(420_000, 180_000), applied(180_000, 24_000)],
    });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    const handoff = harness.submitted[0]!.text;

    harness.setMessages([
      { role: 'user', content: handoff },
      { role: 'assistant', content: '## 待办\n- 改 cache' },
    ]);
    await harness.after({ input: harness.input(handoff, 'plugin'), outcome: 'completed' });
    await harness.tick();

    expect(harness.calls.map((call) => call.mode)).toEqual(['quick', 'model']);
    expect(harness.state()).toMatchObject({ phase: 'resume', compactedTokens: 24_000, failures: 0 });
    const modelCall = harness.calls[1]!;
    await expect(modelCall.summarize!('用户：…', '写摘要')).resolves.toBe('## Pending Tasks\n- 改 cache');
    expect(harness.requests[0]).toMatchObject({ purpose: '会话压缩摘要' });
    const final = harness.notices.at(-1);
    expect(final?.content).toContain('420K → 24K');
    expect(final?.content).toContain('快速压缩 + 模型压缩');
  });

  it('没有可清理的工具过程时直接从当前用量判断要不要模型压缩', async () => {
    const harness = createHarness(applied(), {
      usage: 420_000,
      compact: [skipped('empty'), applied(420_000, 30_000)],
    });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    await harness.after({ input: harness.input(harness.submitted[0]!.text, 'plugin'), outcome: 'completed' });
    await harness.tick();

    expect(harness.calls.map((call) => call.mode)).toEqual(['quick', 'model']);
    expect(harness.state()).toMatchObject({ compactedTokens: 30_000 });
  });

  it('会话正忙时这一拍不做，下一拍重来而不是报错', async () => {
    const harness = createHarness(applied(), {
      usage: 420_000,
      compact: [skipped('busy'), applied(420_000, 30_000)],
    });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    await harness.after({ input: harness.input(harness.submitted[0]!.text, 'plugin'), outcome: 'completed' });

    await harness.tick();
    expect(harness.calls).toHaveLength(1);
    expect(harness.state()).toMatchObject({ phase: 'compact' });
    await harness.tick();
    expect(harness.calls.map((call) => call.mode)).toEqual(['quick', 'quick']);
    expect(harness.state()).toMatchObject({ phase: 'resume' });
  });

  it('排队槽里有用户的消息时先让用户那条跑', async () => {
    const harness = createHarness(applied(), { usage: 420_000, queue: ['我自己补一句'] });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    expect(harness.submitted).toEqual([]);
    // 连状态都没写：这一轮直接让位，连「开始过」都不算。
    expect(harness.state()).toBeUndefined();
  });

  it('用户中途插话：照样压缩，但不再自动发「继续」', async () => {
    const harness = createHarness(applied(), { usage: 420_000, compact: [applied(420_000, 40_000)] });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    await harness.before({ runtime: {}, input: harness.input('我自己接着干'), content: undefined } as RuntimeTurnBeforeHookEvent);
    await harness.after({ input: harness.input(harness.submitted[0]!.text, 'plugin'), outcome: 'completed' });

    await harness.tick();
    expect(harness.calls.map((call) => call.mode)).toEqual(['quick']);
    harness.rewindPhase(5_000);
    await harness.tick();

    expect(harness.state()).toMatchObject({ phase: 'idle' });
    expect(harness.submitted).toHaveLength(1);
    expect(harness.notices.at(-1)?.content).toContain('不再自动接着跑');
  });

  it('交接那一轮被中止就取消这次自动压缩', async () => {
    const harness = createHarness(applied(), { usage: 420_000 });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    await harness.after({ input: harness.input(harness.submitted[0]!.text, 'plugin'), outcome: 'aborted' });

    expect(harness.state()).toMatchObject({ phase: 'idle' });
    expect(harness.notices.at(-1)?.content).toContain('自动压缩已取消');
    expect(harness.calls).toEqual([]);
  });

  it('把交接文档另存到 handovers/，模型压缩后还能回看原文', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'mica-compact-'));
    const harness = createHarness(applied(), {
      usage: 420_000,
      configDir,
      compact: [applied(420_000, 40_000)],
    });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    const handoff = harness.submitted[0]!.text;
    // 会话记录里存的是展示文本（短的那句），不是整段提示词——仍然要能找回交接文档。
    const shown = harness.submitted[0]!.options!.displayText!;
    harness.setMessages([
      { role: 'user', content: shown },
      { role: 'assistant', content: '## 待办\n- 改 cache\n- 跑测试' },
    ]);
    await harness.after({ input: harness.input(handoff, 'plugin'), outcome: 'completed' });

    const files = readdirSync(join(configDir, 'handovers'));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(configDir, 'handovers', files[0]!), 'utf-8');
    expect(text).toContain('# 自动压缩交接');
    expect(text).toContain('## 待办');
    expect(text).toContain('改 cache');
    expect(harness.notices[0]?.content).toContain('已另存');
  });

  it('手动「交接并压缩」直接发交接请求', async () => {
    const harness = createHarness(applied(), { usage: 420_000 });
    const result = await harness.run('handoff');

    expect(harness.submitted).toHaveLength(1);
    expect(harness.submitted[0]!.text.startsWith(HANDOFF_MARKER)).toBe(true);
    expect(result).toMatchObject({ outcome: 'success', code: 'handoff_started' });
  });

  it('没有用量时手动入口给出可读原因', async () => {
    const harness = createHarness(applied(), { usage: null });
    expect(await harness.run('handoff')).toMatchObject({ outcome: 'declined', code: 'no_usage' });
  });

  it('已经在流程里时不重复发交接请求', async () => {
    const harness = createHarness(applied(), { usage: 420_000 });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    expect(await harness.run('handoff')).toMatchObject({ outcome: 'busy', code: 'in_progress' });
    expect(harness.submitted).toHaveLength(1);
  });

  it('提交失败时退回 idle 并说清楚原因', async () => {
    const harness = createHarness(applied(), {
      usage: 420_000,
      submit: [{ ok: false, reason: 'busy' }],
    });
    await harness.after({ input: turn(harness), outcome: 'completed' });
    expect(harness.state()).toMatchObject({ phase: 'idle' });
    expect(harness.logs.some((entry) => entry.event === 'compact.auto-handoff-failed')).toBe(true);
  });

  it('连续失败停掉之后，上下文回到阈值以下就重新启用', async () => {
    const harness = createHarness(applied(), { usage: 4_000 });
    harness.setState({ phase: 'idle', failures: 3 });

    await harness.after({ input: turn(harness), outcome: 'completed' });

    // 没有再触发（用量本来就在阈值以下），但失败计数清零，下一轮到阈值时会重新工作。
    expect(harness.submitted).toEqual([]);
    expect(harness.state()).toMatchObject({ phase: 'idle', failures: 0 });
  });
});

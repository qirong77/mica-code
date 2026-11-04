import { describe, expect, it, vi } from 'vitest';
import { createPluginLlmApi } from '@packages/mica-plugin/index.js';
import type {
  PluginAgentHandle,
  PluginAskAnswer,
  PluginAskQuestion,
  PluginContext,
  PluginIterationRewriter,
  PluginModelRequest,
  PluginSettingValues,
} from '@packages/mica-plugin/index.js';
import setup from './index.js';

const configured: PluginSettingValues = {
  enabled: 'true',
  quickThresholdK: '200',
  quickLimit: '1',
  modelThresholdK: '120',
  modelLimit: '1',
  minIntervalMinutes: '0',
  idleMinutes: '15',
};

const history = [
  { role: 'user', content: '看看构建为什么慢' },
  { role: 'tool', content: 'x'.repeat(40_000) },
];

describe('auto-compact plugin', () => {
  it('compacts the history between two requests when the context is over the threshold', async () => {
    // 本地清理把 250k 压到 50k：已经低于模型阈值，所以只跑一次快速压缩。
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [200_000] });

    const next = await harness.rewrite();

    expect(harness.compactCalls).toEqual([{ mode: 'quick' }]);
    expect(next).toEqual([{ role: 'compacted' }]);
  });

  it('leaves the history untouched while the context is small', async () => {
    const harness = createHarness({ inputTokens: 30_000 });

    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.compactCalls).toEqual([]);
    // 只有「上一次请求是什么时候」会跟着走：提醒要判断这段历史在缓存里还热不热。
    expect(harness.state).toMatchObject({ lastRequestAt: expect.any(String) });
    expect(harness.state).not.toMatchObject({ quickRuns: 1 });
  });

  it('escalates to the model pass when the local pass did not shrink enough', async () => {
    // 本地清理只省下 1k：仍然高于模型阈值，因此紧接着走一次模型摘要。
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [1_000, 12_000] });

    await harness.rewrite();

    expect(harness.compactCalls.map((call) => call.mode)).toEqual(['quick', 'model']);
  });

  // 只有模型摘要真的改写了历史才提示。本地清理一轮里会跑好几次（每批工具结果都能清），
  // 它不改用户看到的对话，逐次提示只会在会话里排出一列「自动压缩：xx → yy」的卡片。
  it('stays quiet when the local pass alone already brought the context down', async () => {
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [200_000] });

    await harness.rewrite();

    expect(harness.compactCalls.map((call) => call.mode)).toEqual(['quick']);
    expect(harness.notices).toEqual([]);
  });

  it('reports a model compaction and takes over the previous status row', async () => {
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [1_000, 12_000] });

    await harness.rewrite();

    // 运行中的进度条之后只剩一条结论，且它声明「同一 command 只留最新一条」。
    expect(harness.notices.at(-1)).toContain('自动压缩：250K → 237K');
    expect(harness.noticeReplaceFlags.at(-1)).toBe(true);
  });

  it('writes the checkpoint with the model from the llm component', async () => {
    // 模型接口走清单的 `llm` 声明：默认复用当前会话模型，也能在插件设置里换一个便宜接口。
    const requests: PluginModelRequest[] = [];
    const harness = createHarness({
      inputTokens: 250_000,
      savedTokens: [1_000, 12_000],
      llm: { configured: true, requests },
    });

    await harness.rewrite();

    // 快速压缩不调用模型，只有模型压缩那一步拿到摘要请求。
    expect(harness.summarizers[0]).toBeUndefined();
    const summarize = harness.summarizers[1];
    expect(summarize).toBeDefined();
    await expect(summarize!('转录内容', '摘要系统提示词')).resolves.toBe('<summary>压好了</summary>');
    expect(requests[0]).toMatchObject({
      purpose: '自动压缩摘要',
      system: '摘要系统提示词',
      user: '转录内容',
    });
  });

  it('refuses to summarize with a half-configured endpoint instead of quietly using the session model', async () => {
    const harness = createHarness({
      inputTokens: 250_000,
      savedTokens: [1_000, 12_000],
      llm: { configured: false, requests: [] },
    });

    await harness.rewrite();

    await expect(harness.summarizers[1]!('转录内容', '提示词')).rejects.toThrow(/未配置/);
  });

  it('lets the kernel summarize with its own subagent when the host provides no llm', async () => {
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [1_000, 12_000] });

    await harness.rewrite();

    expect(harness.compactCalls.map((call) => call.mode)).toEqual(['quick', 'model']);
    expect(harness.summarizers[1]).toBeUndefined();
  });

  it('does not spend a model request when the local pass already brought it down', async () => {
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [200_000] });

    await harness.rewrite();

    expect(harness.compactCalls.map((call) => call.mode)).toEqual(['quick']);
  });

  it('records the counters in the session state so they survive a restart', async () => {
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [200_000] });

    await harness.rewrite();

    expect(harness.state).toMatchObject({ quickRuns: 1, modelRuns: 0, lastKind: 'quick' });
    expect(harness.state?.lastRunAt).toEqual(expect.any(String));
  });

  it('keeps the original history when compaction has nothing to clean', async () => {
    // `compact` 抛「没有可清理内容」不是错误：历史原样发出去，也不消耗次数。
    const harness = createHarness({ inputTokens: 250_000, fail: 'nothing to compact' });

    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.state).toMatchObject({ quickRuns: 0, modelRuns: 0, lastAttemptTokens: 250_000 });
    expect(harness.healthReports.at(-1)?.level).toBe('warn');
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  it('never touches one-shot runs (mica exec has no next request to save)', async () => {
    const harness = createHarness({ inputTokens: 250_000, mode: 'one-shot' });

    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.compactCalls).toEqual([]);
  });

  it('does nothing when the switch is off', async () => {
    const harness = createHarness({ inputTokens: 250_000, settings: { ...configured, enabled: 'false' } });

    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.compactCalls).toEqual([]);
  });

  it('follows the session override instead of the global default', async () => {
    // 全局开着，但这条会话关掉了：读不到会话层就等于「按会话配置」没实现。
    const harness = createHarness({
      inputTokens: 250_000,
      settings: { ...configured, enabled: 'true' },
      sessionValues: { ...configured, enabled: 'false' },
    });

    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.compactCalls).toEqual([]);
  });

  it('stops after the configured number of runs', async () => {
    // 只允许快速压缩（模型压缩次数为 0）：用完之后同一段上下文不再被压。
    const harness = createHarness({
      inputTokens: 250_000,
      savedTokens: [200_000],
      settings: { ...configured, modelLimit: '0' },
    });

    await harness.rewrite();
    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.compactCalls).toHaveLength(1);
  });

  // 间隔是「模型还在同一轮里跑」的节流，不是跨轮冷却：上一轮压过之后，这一轮又超
  // 阈值时必须立刻压。否则用户会看到上下文已经很大、插件却要等半小时才肯动手。
  it('does not carry the minimum interval into a new turn', async () => {
    const harness = createHarness({
      inputTokens: 250_000,
      savedTokens: [200_000],
      settings: { ...configured, minIntervalMinutes: '30' },
      lastRunAt: minutesAgo(5),
      turnStartedAt: minutesAgo(10),
    });

    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.compactCalls).toEqual([]);

    harness.emitHook('turn:before', {});
    await harness.rewrite();

    expect(harness.compactCalls.map((call) => call.mode)).toEqual(['quick']);
  });

  it('keeps throttling repeated compactions while the same turn is still running', async () => {
    const harness = createHarness({
      inputTokens: 250_000,
      savedTokens: [200_000],
      settings: { ...configured, minIntervalMinutes: '30' },
      lastRunAt: minutesAgo(5),
      turnStartedAt: minutesAgo(10),
    });

    await expect(harness.rewrite()).resolves.toBeNull();
    expect(harness.compactCalls).toEqual([]);
  });

  it('reports incomplete settings as a health warning instead of silently doing nothing', async () => {
    const harness = createHarness({ inputTokens: 30_000, issues: ['快速压缩阈值 不能小于 150'] });

    await harness.rewrite();

    expect(harness.healthReports[0]).toMatchObject({ level: 'warn' });
  });

  // 本轮的产品规则：只在请求边界压缩。空闲、焦点回到输入框、敲字都只是客户端信号，
  // 插件不再订阅它们——否则用户点进点出输入框就会看到一串「已快速压缩」。
  it('never compacts outside a request, however often the composer is focused or typed in', async () => {
    const lastActivityAt = minutesAgo(120);
    const harness = createHarness({ inputTokens: 900_000, idleCompact: true, lastActivityAt });

    for (let round = 0; round < 3; round += 1) {
      await harness.focusComposer();
      await harness.typeInComposer();
    }

    expect(harness.idleCompactCalls).toEqual([]);
    expect(harness.compactCalls).toEqual([]);
    expect(harness.notices).toEqual([]);
    // 轮次之外也不该往会话状态里写东西：压了才记，没压就什么都不动。
    expect(harness.state).toEqual({ lastActivityAt });
  });

  // 轮次之外只有一条路：问一句。问之前什么都不动，问完用户点了才压。
  it('asks before touching anything when the session has been idle for an hour', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      idleCompact: true,
      reminders: true,
      lastRequestAt: minutesAgo(65),
    });

    const pending = harness.runReminder();

    expect(harness.asks).toHaveLength(1);
    expect(harness.asks[0]?.question.title).toContain('已经 1 小时没有请求');
    expect(harness.asks[0]?.question.options.map((option) => option.id)).toEqual(['compact', 'later']);
    // 卡片挂着的时候什么都没压，也没改历史。
    expect(harness.idleCompactCalls).toEqual([]);
    expect(harness.compactCalls).toEqual([]);

    harness.answerReminder(['compact']);
    await pending;

    expect(harness.idleCompactCalls).toHaveLength(1);
    expect(harness.state).toMatchObject({ quickRuns: 1, lastKind: 'quick' });
    expect(harness.notices.at(-1)).toContain('已清理较早的工具结果');
  });

  it('does nothing when the answer is "not now"', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      idleCompact: true,
      reminders: true,
      lastRequestAt: minutesAgo(65),
    });

    const pending = harness.runReminder();
    harness.answerReminder(['later']);
    await pending;

    expect(harness.idleCompactCalls).toEqual([]);
    expect(harness.notices).toEqual([]);
  });

  // 同一段空闲只问一次：用户没回或者回了「先不压」，下一次 tick 不该再弹一张。
  it('asks at most once per idle window', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      idleCompact: true,
      reminders: true,
      lastRequestAt: minutesAgo(65),
    });

    const first = harness.runReminder();
    harness.answerReminder(['later']);
    await first;
    await harness.runReminder();

    expect(harness.asks).toHaveLength(1);
    expect(harness.state).toMatchObject({ lastReminderAt: expect.any(String) });
  });

  it('keeps quiet while a turn is running', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      idleCompact: true,
      reminders: true,
      lastRequestAt: minutesAgo(65),
    });

    harness.emitHook('turn:before', {});
    await harness.runReminder();
    expect(harness.asks).toEqual([]);

    harness.emitHook('turn:after', {});
    const pending = harness.runReminder();
    expect(harness.asks).toHaveLength(1);
    harness.answerReminder(['later']);
    await pending;
  });

  it('does not ask when the reminder switch is off', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      idleCompact: true,
      reminders: true,
      lastRequestAt: minutesAgo(65),
      settings: { ...configured, remindEnabled: 'false' },
    });

    await harness.runReminder();

    expect(harness.asks).toEqual([]);
  });

  // 用户没点卡片直接发了下一条消息：那张「要不要压缩」已经没有意义，撤掉它，
  // 别让它挂在新一轮的输入框上面继续要一个答案。
  it('takes the card away when the next turn starts', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      idleCompact: true,
      reminders: true,
      lastRequestAt: minutesAgo(65),
    });

    const pending = harness.runReminder();
    expect(harness.asks).toHaveLength(1);

    harness.emitHook('turn:before', {});
    await pending;

    expect(harness.idleCompactCalls).toEqual([]);
    expect(harness.notices).toEqual([]);
  });

  // 提醒问的是「缓存还热着吗」，所以每个请求都要把这只表重新上一次弦：
  // 一轮里发过几次请求，缓存就被刷新过几次。
  it('restarts the idle clock on every request', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      reminders: true,
      lastRequestAt: minutesAgo(65),
    });

    await harness.rewrite();

    const recorded = Date.parse(String(harness.state?.lastRequestAt));
    expect(Date.now() - recorded).toBeLessThan(5_000);
  });

  it('steps aside when another plugin already has a question on screen', async () => {
    const harness = createHarness({
      inputTokens: 260_000,
      idleCompact: true,
      reminders: true,
      askBusy: true,
      lastRequestAt: minutesAgo(65),
    });

    const pending = harness.runReminder();
    await pending;

    expect(harness.asks).toEqual([]);
    expect(harness.logger.info).toHaveBeenCalledWith(
      'auto-compact:remind-skipped',
      expect.objectContaining({ reason: expect.any(String) }),
    );
  });
});

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function createHarness(options: {
  inputTokens: number;
  mode?: 'session' | 'one-shot';
  settings?: PluginSettingValues;
  /** 本会话覆盖之后的生效值；省略表示与全局设置相同。 */
  sessionValues?: PluginSettingValues;
  savedTokens?: number[];
  fail?: string;
  issues?: string[];
  /** 宿主能不能在轮次之外压一次存下来的历史（`app-server` 能，`exec` 不能）。 */
  idleCompact?: boolean;
  /** 会话状态里记的最后活动时间（ISO）；省略表示没有记录。 */
  lastActivityAt?: string;
  /** 会话状态里记的上一次压缩时间（ISO）：节流判断的基线。 */
  lastRunAt?: string;
  /** 会话状态里记的本轮开始时间（ISO）：最小间隔只在同一轮里生效。 */
  turnStartedAt?: string;
  /** 会话状态里记的上一次请求时间（ISO）：空闲提醒的基线。 */
  lastRequestAt?: string;
  /**
   * 宿主有没有「问一句」的两块能力（`ctx.ask` 与 `ctx.background`）。
   *
   * 不给就代表 TUI / `mica exec` 那种没有可点地方的宿主：提醒整块不生效。
   */
  reminders?: boolean;
  /** 已经有别的插件在问：`post` 会抛错，插件应该让开。 */
  askBusy?: boolean;
  /** 不提供会话级状态：用来验证插件不会因为缺能力就崩。 */
  withoutSessionState?: boolean;
  /** 宿主给的模型组件：`configured` 决定它能不能用，缺省不提供（退回内核摘要子代理）。 */
  llm?: { configured: boolean; requests: PluginModelRequest[] };
}) {
  const compactCalls: Array<{ mode: string }> = [];
  const summarizers: Array<((transcript: string, prompt: string) => Promise<string>) | undefined> = [];
  const savedTokens = [...(options.savedTokens ?? [])];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const healthReports: Array<{ level: string; message: string }> = [];
  const idleCompactCalls: number[] = [];
  const notices: string[] = [];
  /** 每条 notice 带的 command：宿主靠它把「同一段历史被连压几次」合并成一条。 */
  const noticeCommands: Array<string | undefined> = [];
  const noticeReplaceFlags: boolean[] = [];
  const stateOwners: unknown[] = [];
  const eventHandlers: Array<(event: { type: string; owner?: unknown }) => void> = [];
  const hookHandlers = new Map<string, Array<(event?: { owner?: unknown }) => void>>();
  const seedState: Record<string, unknown> = {};
  if (options.lastActivityAt) seedState.lastActivityAt = options.lastActivityAt;
  if (options.lastRunAt) seedState.lastRunAt = options.lastRunAt;
  if (options.turnStartedAt) seedState.turnStartedAt = options.turnStartedAt;
  if (options.lastRequestAt) seedState.lastRequestAt = options.lastRequestAt;
  let state: Record<string, unknown> | undefined = Object.keys(seedState).length ? seedState : undefined;
  let rewriter: PluginIterationRewriter | null = null;
  const disposeHandlers: Array<() => void> = [];
  type PendingAsk = { question: PluginAskQuestion; answer: (answer: PluginAskAnswer) => void };
  const asks: PendingAsk[] = [];
  let pendingAsk: PendingAsk | null = null;
  const askApi = options.reminders
    ? {
        request: async (): Promise<PluginAskAnswer> => ({ optionIds: [], cancelled: true, reason: 'cancelled' }),
        post: (question: PluginAskQuestion) => {
          // 宿主同一时刻只显示一个问题：撞上了插件应当让开，而不是把卡片顶掉。
          if (options.askBusy || pendingAsk) throw new Error('已经有一个问题在等用户回答');
          const entry: PendingAsk = { question, answer: () => {} };
          const answered = new Promise<PluginAskAnswer>((resolve) => {
            entry.answer = resolve;
          });
          pendingAsk = entry;
          asks.push(entry);
          return {
            id: `ask-${asks.length}`,
            answered,
            dismiss: () => {
              if (pendingAsk === entry) pendingAsk = null;
              entry.answer({ optionIds: [], cancelled: true, reason: 'cancelled' });
            },
          };
        },
      }
    : undefined;
  const backgroundTasks = new Map<string, { run: (context: { signal: AbortSignal; tick: number }) => unknown }>();
  const backgroundApi = options.reminders
    ? {
        register: (task: { id: string; run: (context: { signal: AbortSignal; tick: number }) => unknown }) => {
          backgroundTasks.set(task.id, task);
          return { dispose: () => backgroundTasks.delete(task.id) };
        },
        list: () => [],
        disposeAll: () => backgroundTasks.clear(),
      }
    : undefined;
  // 宿主仍然提供这条能力。插件一次都不调用它，才说明轮次之外确实没压。
  const compactIdleHistory = options.idleCompact
    ? async (hook?: { afterApply?: (result: { savedTokens: number; beforeTokens: number; afterTokens: number }) => void }) => {
        idleCompactCalls.push(Date.now());
        const result = { savedTokens: 12_000, beforeTokens: 52_000, afterTokens: 40_000 };
        // 宿主在落盘之前回调：插件在这里写计数与 notice，它们随压缩结果一起保存。
        hook?.afterApply?.(result);
        return { status: 'applied', ...result } as const;
      }
    : null;

  const estimates = new WeakMap<unknown[], number>();
  const agent: PluginAgentHandle = {
    sessionId: 'session-1',
    mode: options.mode ?? 'session',
    lastUsage: () => ({ inputTokens: options.inputTokens, model: 'mock/mock-chat' }),
    estimateTokens: (messages) => estimates.get(messages) ?? options.inputTokens,
    getState: <T>() => state as T | undefined,
    setState: (value: unknown) => {
      state = value as Record<string, unknown>;
    },
    compact: async (_messages, compactOptions) => {
      compactCalls.push({ mode: compactOptions.mode });
      summarizers.push(compactOptions.summarize);
      if (options.fail) throw new Error(options.fail);
      const saved = savedTokens.shift() ?? 0;
      const messages = [{ role: 'compacted' }];
      estimates.set(messages, Math.max(0, agent.estimateTokens(_messages) - saved));
      return { messages, savedTokens: saved };
    },
  };

  const llmApi = options.llm
    ? createPluginLlmApi({
        spec: {},
        // 复用会话模型时天然可用；要测「没配好」就关掉复用又不填地址。
        readValues: () => ({ useMainProvider: options.llm?.configured ? 'true' : 'false' }),
        models: async (request) => {
          options.llm?.requests.push(request);
          return { text: '<summary>压好了</summary>', usage: null };
        },
      })
    : undefined;

  const settings = options.settings ?? configured;
  const sessionValues = options.sessionValues ?? settings;
  const ctx = {
    pluginId: 'auto-compact',
    settings: {
      path: '/tmp/plugin-settings/auto-compact.json',
      get: () => settings,
      validate: () =>
        (options.issues ?? []).map((message) => ({ key: 'quickThresholdK', label: '快速压缩阈值', message })),
    },
    // 插件读的是「本会话生效的值」：宿主把会话覆盖合进全局设置后交给它，
    // 因此这里直接返回同一份 settings 就代表「本会话没有覆盖」。
    sessionSettings: {
      get: (owner?: unknown) => {
        stateOwners.push(owner);
        return sessionValues;
      },
      overrides: () => ({}),
      set: vi.fn(),
      clear: vi.fn(),
    },
    agent: {
      mode: options.mode ?? 'session',
      onIterationRewrite: (handler: PluginIterationRewriter) => {
        rewriter = handler;
        return { dispose() {} };
      },
      // 提前量要判断「现在多大」：宿主给的是最近一次真实请求的输入量。
      lastUsage: () => ({ inputTokens: options.inputTokens, model: 'mock/mock-chat' }),
      ...(compactIdleHistory ? { compactIdleHistory } : {}),
    },
    ...(llmApi ? { llm: llmApi } : {}),
    ...(options.withoutSessionState
      ? {}
      : {
          sessionState: {
            get: <T>(owner?: unknown) => {
              stateOwners.push(owner);
              return state as T | undefined;
            },
            set: (value: unknown, owner?: unknown) => {
              stateOwners.push(owner);
              state = value as Record<string, unknown>;
            },
            clear: (owner?: unknown) => {
              stateOwners.push(owner);
              state = undefined;
            },
          },
        }),
    events: {
      on: (_name: string, handler: (event: { type: string }) => void) => {
        eventHandlers.push(handler);
        return { dispose() {} };
      },
    },
    ...(askApi ? { ask: askApi } : {}),
    ...(backgroundApi ? { background: backgroundApi } : {}),
    hooks: {
      on: (name: string, handler: () => void) => {
        const list = hookHandlers.get(name) ?? [];
        list.push(handler);
        hookHandlers.set(name, list);
        return { dispose() {} };
      },
    },
    health: {
      path: null,
      read: () => null,
      report: (report: { level: string; message: string }) => healthReports.push(report),
      clear() {},
    },
    // 压缩落地后在对话里留一行，让人不用翻日志也知道「刚才压过」。
    ui: {
      notice: (content: string, options?: { command?: string; replace?: boolean }) => {
        notices.push(content);
        noticeCommands.push(options?.command);
        noticeReplaceFlags.push(options?.replace === true);
      },
    },
    logger,
    onDispose: (handler: () => void) => disposeHandlers.push(handler),
  } as unknown as PluginContext;

  setup(ctx);

  return {
    logger,
    healthReports,
    notices,
    noticeCommands,
    noticeReplaceFlags,
    stateOwners,
    compactCalls,
    summarizers,
    idleCompactCalls,
    asks,
    get state() {
      return state;
    },
    restoreState: (restored: Record<string, unknown>) => {
      state = restored;
    },
    rewrite: async () => {
      if (!rewriter) throw new Error('plugin did not register a rewriter');
      return await rewriter(history, agent);
    },
    /** 模拟用户在输入框里敲字，并等插件那边（异步）处理完。 */
    typeInComposer: async (owner?: unknown) => {
      for (const handler of eventHandlers) handler({ type: 'input:activity', owner });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** 模拟鼠标点进输入框（还没敲字），并等插件那边（异步）处理完。 */
    focusComposer: async (owner?: unknown) => {
      for (const handler of eventHandlers) handler({ type: 'input:focus', owner });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    emitHook: (name: string, event?: { owner?: unknown }) => {
      for (const handler of hookHandlers.get(name) ?? []) handler(event);
    },
    /** 跑一轮「常驻提醒」的检查（宿主的 background tick）。 */
    runReminder: async () => {
      const task = backgroundTasks.get('remind');
      if (!task) throw new Error('plugin did not register the reminder task');
      return await task.run({ signal: new AbortController().signal, tick: 1 });
    },
    /** 模拟用户在卡片上点了一个选项。 */
    answerReminder: (optionIds: string[]) => {
      const entry = pendingAsk;
      if (!entry) throw new Error('no reminder on screen');
      pendingAsk = null;
      entry.answer({ optionIds, cancelled: false, reason: 'answered' });
    },
  };
}

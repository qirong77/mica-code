import { describe, expect, it, vi } from 'vitest';
import type {
  PluginAgentHandle,
  PluginContext,
  PluginIterationRewriter,
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
    expect(harness.state).toBeUndefined();
  });

  it('escalates to the model pass when the local pass did not shrink enough', async () => {
    // 本地清理只省下 1k：仍然高于模型阈值，因此紧接着走一次模型摘要。
    const harness = createHarness({ inputTokens: 250_000, savedTokens: [1_000, 12_000] });

    await harness.rewrite();

    expect(harness.compactCalls.map((call) => call.mode)).toEqual(['quick', 'model']);
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
    expect(harness.state).toBeUndefined();
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

  it('reports incomplete settings as a health warning instead of silently doing nothing', async () => {
    const harness = createHarness({ inputTokens: 30_000, issues: ['快速压缩阈值 不能小于 150'] });

    await harness.rewrite();

    expect(harness.healthReports[0]).toMatchObject({ level: 'warn' });
  });

  it('compacts the stored history when the user comes back after a long idle', async () => {
    // 上下文小（远低于阈值）也要压：这一条判断的是「人回来了」，不是「上下文大了」。
    const harness = createHarness({
      inputTokens: 30_000,
      idleCompact: true,
      lastActivityAt: minutesAgo(30),
    });

    await harness.typeInComposer();

    expect(harness.idleCompactCalls).toHaveLength(1);
    expect(harness.state).toMatchObject({ quickRuns: 1, lastKind: 'quick', lastSavedTokens: 12_000 });
    // 对话里留一行：否则「到底压没压」只能翻插件日志。
    expect(harness.notices.at(-1)).toContain('已快速压缩历史');
    expect(harness.notices.at(-1)).toContain('空闲 30 分钟');
    // 省下的量要换算成 k、并给出压缩前后的对比：孤零零的 806469 读不出量级。
    expect(harness.notices.at(-1)).toContain('52K → 40K');
    expect(harness.healthReports.at(-1)?.level).toBe('ok');
  });

  // 大数字要换算：真实会话里省下的量动辄六位数，写成「806469 tokens」读不出量级。
  it('reads the gain in k and M for a large history', async () => {
    const harness = createHarness({
      inputTokens: 30_000,
      idleCompact: true,
      lastActivityAt: minutesAgo(90),
      idleBeforeTokens: 1_200_000,
      idleSavedTokens: 806_469,
    });

    await harness.typeInComposer();

    expect(harness.notices.at(-1)).toContain('1.2M → 394K（省 67%）');
    expect(harness.notices.at(-1)).not.toContain('806469');
  });

  // 计数必须在宿主落盘之前写好：压缩与记账是同一次写。晚一步写等于「压了但没记账」，
  // 用户一关页面就没了（真实事故：文件里压缩生效了，pluginState 还是旧的）。
  it('stamps the counters before the host writes the session', async () => {
    const harness = createHarness({ inputTokens: 30_000, idleCompact: true, lastActivityAt: minutesAgo(30) });

    await harness.typeInComposer();

    expect(harness.stateSeenByHost).toMatchObject({ quickRuns: 1, lastKind: 'quick' });
  });

  it('ignores the threshold-trigger interval when the user comes back', async () => {
    // 工作密集时刚按阈值压过一次、20 分钟后又回来：这一条不该被「最小间隔」拦住，
    // 否则最常见的场景（一会儿压、一会儿走）会静默失效。
    const harness = createHarness({
      inputTokens: 30_000,
      idleCompact: true,
      settings: { ...configured, minIntervalMinutes: '30' },
      lastRunAt: minutesAgo(5),
      lastActivityAt: minutesAgo(20),
    });

    await harness.typeInComposer();

    expect(harness.idleCompactCalls).toHaveLength(1);
  });

  it('says why nothing happened when the host reports the session busy', async () => {
    const harness = createHarness({
      inputTokens: 30_000,
      idleCompact: true,
      idleSkipped: 'busy',
      lastActivityAt: minutesAgo(30),
    });

    await harness.typeInComposer();

    expect(harness.logger.info).toHaveBeenCalledWith('auto-compact:idle-skipped', {
      idleMs: expect.any(Number),
      reason: 'busy',
    });
    expect(harness.state?.quickRuns).toBeUndefined();
    expect(harness.notices).toEqual([]);
  });

  it('stays quiet while the user has been typing all along', async () => {
    const harness = createHarness({ inputTokens: 30_000, idleCompact: true, lastActivityAt: minutesAgo(1) });

    await harness.typeInComposer();

    expect(harness.idleCompactCalls).toEqual([]);
    expect(harness.state).toMatchObject({ lastActivityAt: expect.any(String) });
  });

  it('treats a turn as activity, so finishing a long one is not "coming back"', async () => {
    const harness = createHarness({ inputTokens: 30_000, idleCompact: true, lastActivityAt: minutesAgo(60) });

    harness.emitHook('turn:after');
    await harness.typeInComposer();

    expect(harness.idleCompactCalls).toEqual([]);
  });

  it('does not spend a run when the host reports nothing to compact', async () => {
    const harness = createHarness({
      inputTokens: 30_000,
      idleCompact: true,
      idleSavedTokens: null,
      lastActivityAt: minutesAgo(30),
    });

    await harness.typeInComposer();

    expect(harness.idleCompactCalls).toHaveLength(1);
    expect(harness.state?.quickRuns).toBeUndefined();
  });

  it('reports a failed idle compaction without spending a run', async () => {
    const harness = createHarness({
      inputTokens: 30_000,
      idleCompact: true,
      idleFail: '会话正忙',
      lastActivityAt: minutesAgo(30),
    });

    await harness.typeInComposer();

    expect(harness.state?.quickRuns).toBeUndefined();
    expect(harness.healthReports.at(-1)?.level).toBe('warn');
    expect(harness.logger.warn).toHaveBeenCalled();
  });

  it('skips the idle trigger when the host has no way to compact stored history', async () => {
    // TUI / mica exec：没有这条通路时既不订阅事件，也不该报错。
    const harness = createHarness({ inputTokens: 30_000, lastActivityAt: minutesAgo(30) });

    await harness.typeInComposer();

    expect(harness.idleCompactCalls).toEqual([]);
    expect(harness.healthReports.some((report) => report.level === 'warn')).toBe(false);
  });

  it('never compacts idle history without a session state to count runs in', async () => {
    const harness = createHarness({ inputTokens: 30_000, idleCompact: true, withoutSessionState: true });

    await harness.typeInComposer();

    expect(harness.idleCompactCalls).toEqual([]);
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
  /** 空闲压缩由宿主报告的节省量；`null` 表示宿主说「这次没压成」。 */
  idleSavedTokens?: number | null;
  /** 空闲压缩前的估算占用（默认按节省量 + 40K 合成，好让「a → b」两半都不同）。 */
  idleBeforeTokens?: number;
  /** 宿主说这一次做不了（会话正忙 / 别的进程持锁）。 */
  idleSkipped?: 'busy' | 'empty';
  idleFail?: string;
  /** 会话状态里记的上一次压缩时间（ISO）：节流判断的基线。 */
  lastRunAt?: string;
  /** 不提供会话级状态：用来验证插件不会因为缺能力就崩。 */
  withoutSessionState?: boolean;
}) {
  const compactCalls: Array<{ mode: string }> = [];
  const savedTokens = [...(options.savedTokens ?? [])];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const healthReports: Array<{ level: string; message: string }> = [];
  const idleCompactCalls: number[] = [];
  const notices: string[] = [];
  let stateSeenByHost: Record<string, unknown> | undefined;
  const eventHandlers: Array<(event: { type: string }) => void> = [];
  const hookHandlers = new Map<string, Array<() => void>>();
  let state: Record<string, unknown> | undefined = options.lastActivityAt
    ? { lastActivityAt: options.lastActivityAt, ...(options.lastRunAt ? { lastRunAt: options.lastRunAt } : {}) }
    : undefined;
  let rewriter: PluginIterationRewriter | null = null;
  const disposeHandlers: Array<() => void> = [];
  const compactIdleHistory = options.idleCompact
    ? async (hook?: {
        afterApply?: (result: { savedTokens: number; beforeTokens: number; afterTokens: number }) => void;
      }) => {
        idleCompactCalls.push(Date.now());
        if (options.idleFail) throw new Error(options.idleFail);
        if (options.idleSkipped) return { status: 'skipped', reason: options.idleSkipped } as const;
        if (options.idleSavedTokens === null) return { status: 'skipped', reason: 'empty' } as const;
        const savedTokens = options.idleSavedTokens ?? 12_000;
        const beforeTokens = options.idleBeforeTokens ?? savedTokens + 40_000;
        const afterTokens = beforeTokens - savedTokens;
        // 真宿主在落盘之前调它：插件在这里写状态与 notice。
        hook?.afterApply?.({ savedTokens, beforeTokens, afterTokens });
        // 宿主随后读这份快照去写文件——记录那一刻看到的状态。
        stateSeenByHost = state;
        return { status: 'applied', savedTokens, beforeTokens, afterTokens } as const;
      }
    : null;

  const agent: PluginAgentHandle = {
    sessionId: 'session-1',
    mode: options.mode ?? 'session',
    lastUsage: () => ({ inputTokens: options.inputTokens, model: 'mock/mock-chat' }),
    getState: <T>() => state as T | undefined,
    setState: (value: unknown) => {
      state = value as Record<string, unknown>;
    },
    compact: async (_messages, compactOptions) => {
      compactCalls.push({ mode: compactOptions.mode });
      if (options.fail) throw new Error(options.fail);
      return { messages: [{ role: 'compacted' }], savedTokens: savedTokens.shift() ?? 0 };
    },
  };

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
      get: () => sessionValues,
      overrides: () => ({}),
      set: vi.fn(),
      clear: vi.fn(),
    },
    agent: {
      onIterationRewrite: (handler: PluginIterationRewriter) => {
        rewriter = handler;
        return { dispose() {} };
      },
      ...(compactIdleHistory ? { compactIdleHistory } : {}),
    },
    ...(options.withoutSessionState
      ? {}
      : {
          sessionState: {
            get: <T>() => state as T | undefined,
            set: (value: unknown) => {
              state = value as Record<string, unknown>;
            },
            clear: () => {
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
    ui: { notice: (content: string) => notices.push(content) },
    logger,
    onDispose: (handler: () => void) => disposeHandlers.push(handler),
  } as unknown as PluginContext;

  setup(ctx);

  return {
    logger,
    healthReports,
    notices,
    get stateSeenByHost() {
      return stateSeenByHost;
    },
    compactCalls,
    idleCompactCalls,
    get state() {
      return state;
    },
    rewrite: async () => {
      if (!rewriter) throw new Error('plugin did not register a rewriter');
      return await rewriter(history, agent);
    },
    /** 模拟用户在输入框里敲字，并等插件那边（异步）处理完。 */
    typeInComposer: async () => {
      for (const handler of eventHandlers) handler({ type: 'input:activity' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    emitHook: (name: string) => {
      for (const handler of hookHandlers.get(name) ?? []) handler();
    },
  };
}

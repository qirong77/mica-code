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
    expect(harness.healthReports.at(-1)?.level).toBe('ok');
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
  idleFail?: string;
  /** 不提供会话级状态：用来验证插件不会因为缺能力就崩。 */
  withoutSessionState?: boolean;
}) {
  const compactCalls: Array<{ mode: string }> = [];
  const savedTokens = [...(options.savedTokens ?? [])];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const healthReports: Array<{ level: string; message: string }> = [];
  const idleCompactCalls: number[] = [];
  const eventHandlers: Array<(event: { type: string }) => void> = [];
  const hookHandlers = new Map<string, Array<() => void>>();
  let state: Record<string, unknown> | undefined = options.lastActivityAt
    ? { lastActivityAt: options.lastActivityAt }
    : undefined;
  let rewriter: PluginIterationRewriter | null = null;
  const disposeHandlers: Array<() => void> = [];
  const compactIdleHistory = options.idleCompact
    ? async () => {
        idleCompactCalls.push(Date.now());
        if (options.idleFail) throw new Error(options.idleFail);
        if (options.idleSavedTokens === null) return null;
        return { savedTokens: options.idleSavedTokens ?? 12_000 };
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
    logger,
    onDispose: (handler: () => void) => disposeHandlers.push(handler),
  } as unknown as PluginContext;

  setup(ctx);

  return {
    logger,
    healthReports,
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

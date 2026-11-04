import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  EMPTY_COUNTERS,
  decideAutoCompactStep,
  decideCompactReminder,
  normalizeCounters,
  settingsFromValues,
  shouldEscalateToModel,
  type AutoCompactCounters,
  type AutoCompactSettings,
} from './policy.js';

const settings = (patch: Partial<AutoCompactSettings> = {}): AutoCompactSettings => ({
  ...DEFAULT_SETTINGS,
  minIntervalMs: 0,
  ...patch,
});

const counters = (patch: Partial<AutoCompactCounters> = {}): AutoCompactCounters => ({
  ...EMPTY_COUNTERS,
  ...patch,
});

describe('settingsFromValues', () => {
  it('falls back to the declared defaults when the file is empty', () => {
    expect(settingsFromValues({})).toEqual(DEFAULT_SETTINGS);
  });

  it('converts minutes to milliseconds and keeps 0 as "no throttle"', () => {
    expect(settingsFromValues({ minIntervalMinutes: '0' }).minIntervalMs).toBe(0);
    expect(settingsFromValues({ minIntervalMinutes: '1.5' }).minIntervalMs).toBe(90_000);
  });

  it('treats a switch that is off as disabled, and anything else as on', () => {
    expect(settingsFromValues({ enabled: 'false' }).enabled).toBe(false);
    expect(settingsFromValues({ enabled: 'true' }).enabled).toBe(true);
    expect(settingsFromValues({}).enabled).toBe(true);
  });

  it('never yields values that would disable compaction by accident', () => {
    const parsed = settingsFromValues({ quickThresholdK: '-5', quickLimit: '-2', modelThresholdK: 'abc' });
    expect(parsed.quickThresholdK).toBe(1);
    expect(parsed.quickLimit).toBe(0);
    expect(parsed.modelThresholdK).toBe(DEFAULT_SETTINGS.modelThresholdK);
  });

  it('reads the reminder switches and turns their units into tokens and milliseconds', () => {
    expect(settingsFromValues({})).toMatchObject({
      remindEnabled: true,
      idleRemindMs: 60 * 60_000,
      remindContextTokens: 100_000,
    });
    expect(settingsFromValues({ remindEnabled: 'false' }).remindEnabled).toBe(false);
    expect(settingsFromValues({ idleRemindMinutes: '15' }).idleRemindMs).toBe(15 * 60_000);
    expect(settingsFromValues({ remindContextK: '250' }).remindContextTokens).toBe(250_000);
    expect(settingsFromValues({ idleRemindMinutes: '0', remindContextK: '0' })).toMatchObject({
      idleRemindMs: 60_000,
      remindContextTokens: 1000,
    });
  });
});

describe('normalizeCounters', () => {
  it('restarts from zero when the stored state is unreadable', () => {
    expect(normalizeCounters(undefined)).toEqual(EMPTY_COUNTERS);
    expect(normalizeCounters('nonsense')).toEqual(EMPTY_COUNTERS);
    expect(normalizeCounters({ quickRuns: -3, modelRuns: 'x' })).toMatchObject({ quickRuns: 0, modelRuns: 0 });
  });

  it('keeps a valid counter set as-is', () => {
    const stored = {
      quickRuns: 2,
      modelRuns: 1,
      lastRunAt: '2026-10-01T00:00:00.000Z',
      turnStartedAt: '2026-09-30T23:59:00.000Z',
      lastKind: 'model',
      lastSavedTokens: 4096,
      lastAttemptAt: null,
      lastAttemptTokens: 0,
      lastRequestAt: '2026-10-01T00:05:00.000Z',
      lastReminderAt: null,
    };
    expect(normalizeCounters(stored)).toEqual(stored);
  });
});

describe('decideAutoCompactStep', () => {
  it.each([32_000, 128_000, 256_000])(
    'uses model capacity before the fixed threshold for a %d-token model',
    (window) => {
      const input = { settings: settings(), counters: counters(), contextWindowSize: window };
      expect(decideAutoCompactStep({ ...input, ctxTokens: window * 0.54 })).toBeNull();
      expect(decideAutoCompactStep({ ...input, ctxTokens: window * 0.56 })).toBe('quick');
      expect(shouldEscalateToModel({ ...input, ctxTokens: window * 0.76 })).toBe(true);
    },
  );

  it('bypasses a successful-run interval near capacity but backs off after a recent no-op', () => {
    const nowMs = Date.parse('2026-10-31T00:00:00Z');
    const input = { settings: settings({ minIntervalMs: 30 * 60_000 }), contextWindowSize: 128_000, nowMs };
    const state = counters({ lastRunAt: new Date(nowMs - 120_000).toISOString() });
    expect(decideAutoCompactStep({ ...input, counters: state, ctxTokens: 100_000 })).toBeNull();
    expect(decideAutoCompactStep({ ...input, counters: state, ctxTokens: 120_000 })).toBe('quick');
    const attempted = { ...state, lastAttemptAt: new Date(nowMs - 500).toISOString(), lastAttemptTokens: 120_000 };
    expect(decideAutoCompactStep({ ...input, counters: attempted, ctxTokens: 120_001 })).toBeNull();
    expect(decideAutoCompactStep({ ...input, counters: attempted, ctxTokens: 140_000 })).toBe('quick');
  });

  it('does nothing while the context is below both thresholds', () => {
    expect(decideAutoCompactStep({ settings: settings(), counters: counters(), ctxTokens: 50_000 })).toBeNull();
  });

  it('runs the local pass once the quick threshold is crossed', () => {
    expect(decideAutoCompactStep({ settings: settings(), counters: counters(), ctxTokens: 310_000 })).toBe('quick');
  });

  it('escalates to the model pass when the quick allowance is used up', () => {
    const used = counters({ quickRuns: 999 });
    expect(decideAutoCompactStep({ settings: settings(), counters: used, ctxTokens: 210_000 })).toBe('model');
  });

  it('starts from the local pass when only the model pass is due', () => {
    // 200k 在快速阈值（300k）之下：模型压缩到期本身就足以触发一次快速压缩，
    // 否则会直接花一次模型请求去压一段本来能本地清掉的历史。
    const due = counters({ quickRuns: 0, modelRuns: 0 });
    expect(decideAutoCompactStep({ settings: settings(), counters: due, ctxTokens: 210_000 })).toBe('quick');
  });

  it('stops entirely once both allowances are used up', () => {
    const used = counters({ quickRuns: 999, modelRuns: 999 });
    expect(decideAutoCompactStep({ settings: settings(), counters: used, ctxTokens: 900_000 })).toBeNull();
  });

  it('respects "0 runs" as "never do this kind"', () => {
    const noModel = settings({ modelLimit: 0 });
    expect(decideAutoCompactStep({ settings: noModel, counters: counters(), ctxTokens: 900_000 })).toBe('quick');
    const noQuick = settings({ quickLimit: 0, modelLimit: 3 });
    expect(decideAutoCompactStep({ settings: noQuick, counters: counters(), ctxTokens: 900_000 })).toBe('model');
  });

  it('is disabled outright by the switch', () => {
    expect(
      decideAutoCompactStep({ settings: settings({ enabled: false }), counters: counters(), ctxTokens: 900_000 }),
    ).toBeNull();
  });

  it('throttles a second run inside the minimum interval', () => {
    const recent = counters({ quickRuns: 1, lastRunAt: new Date(1_000_000).toISOString() });
    const throttled = settings({ minIntervalMs: 60_000 });
    expect(
      decideAutoCompactStep({ settings: throttled, counters: recent, ctxTokens: 900_000, nowMs: 1_030_000 }),
    ).toBeNull();
    expect(decideAutoCompactStep({ settings: throttled, counters: recent, ctxTokens: 900_000, nowMs: 1_061_000 })).toBe(
      'quick',
    );
  });

  // 间隔只服务于「模型还在同一轮里跑」：跨轮再超阈值时必须立刻压，否则用户会看到
  // 插件明明该工作时却因为半小时前压过而装死。
  it('only throttles repeated compactions inside the same running turn', () => {
    const nowMs = Date.parse('2026-10-31T00:00:00Z');
    const throttled = settings({ minIntervalMs: 30 * 60_000 });
    const lastRunAt = new Date(nowMs - 5 * 60_000).toISOString();

    const newTurn = counters({
      quickRuns: 1,
      lastRunAt,
      turnStartedAt: new Date(nowMs - 60_000).toISOString(),
    });
    expect(decideAutoCompactStep({ settings: throttled, counters: newTurn, ctxTokens: 310_000, nowMs })).toBe('quick');

    const sameTurn = counters({
      quickRuns: 1,
      lastRunAt,
      turnStartedAt: new Date(nowMs - 10 * 60_000).toISOString(),
    });
    expect(decideAutoCompactStep({ settings: throttled, counters: sameTurn, ctxTokens: 310_000, nowMs })).toBeNull();

    const intervalElapsed = counters({
      quickRuns: 1,
      lastRunAt: new Date(nowMs - 31 * 60_000).toISOString(),
      turnStartedAt: new Date(nowMs - 40 * 60_000).toISOString(),
    });
    expect(decideAutoCompactStep({ settings: throttled, counters: intervalElapsed, ctxTokens: 310_000, nowMs })).toBe(
      'quick',
    );
  });

  it('does not let a clock rollback disable compaction for good', () => {
    const future = counters({ quickRuns: 1, lastRunAt: new Date(9_000_000).toISOString() });
    expect(
      decideAutoCompactStep({
        settings: settings({ minIntervalMs: 60_000 }),
        counters: future,
        ctxTokens: 900_000,
        nowMs: 1_000,
      }),
    ).toBe('quick');
  });
  it('scales the quick threshold with the model window', () => {
    // 窗口比默认阈值小时按窗口算：100K 窗口的 55%（55K）就是它的快速压缩阈值。
    const stepAt = (ctxTokens: number) =>
      decideAutoCompactStep({ settings: settings(), counters: counters(), ctxTokens, contextWindowSize: 100_000 });
    expect(stepAt(60_000)).toBe('quick');
    expect(stepAt(50_000)).toBeNull();
  });
});

describe('shouldEscalateToModel', () => {
  it('escalates only when the context is still above the model threshold', () => {
    expect(shouldEscalateToModel({ settings: settings(), counters: counters(), ctxTokens: 210_000 })).toBe(true);
    expect(shouldEscalateToModel({ settings: settings(), counters: counters(), ctxTokens: 90_000 })).toBe(false);
  });

  it('stops at the model allowance', () => {
    expect(
      shouldEscalateToModel({ settings: settings(), counters: counters({ modelRuns: 999 }), ctxTokens: 900_000 }),
    ).toBe(false);
  });
});

describe('decideCompactReminder', () => {
  const nowMs = Date.parse('2026-11-01T12:00:00Z');
  const idleReminder = (patch: Partial<AutoCompactCounters> = {}, ctxTokens = 260_000) =>
    decideCompactReminder({
      settings: settings(),
      counters: counters({ lastRequestAt: new Date(nowMs - 65 * 60_000).toISOString(), ...patch }),
      ctxTokens,
      nowMs,
    });

  it('asks after an hour of silence when the context is worth shrinking', () => {
    expect(idleReminder()).toBe('idle');
  });

  it('stays quiet while the user is still working', () => {
    expect(idleReminder({ lastRequestAt: new Date(nowMs - 5 * 60_000).toISOString() })).toBeNull();
  });

  it('stays quiet when the context is too small to be worth a card', () => {
    expect(idleReminder({}, 60_000)).toBeNull();
  });

  // 「人走开了一小时」只问一次：用户回了「先不压」，或者干脆没回，都不该每分钟再问一遍。
  it('asks once per idle window and re-arms only after a new request', () => {
    const asked = { lastReminderAt: new Date(nowMs - 10 * 60_000).toISOString() };
    expect(idleReminder(asked)).toBeNull();

    // 问过之后又来了一轮新请求：那段空闲结束了，新的空闲重新计时（这里又放了 65 分钟）。
    const askedThenRequested = {
      lastReminderAt: new Date(nowMs - 90 * 60_000).toISOString(),
      lastRequestAt: new Date(nowMs - 65 * 60_000).toISOString(),
    };
    expect(
      decideCompactReminder({ settings: settings(), counters: counters(askedThenRequested), ctxTokens: 260_000, nowMs }),
    ).toBe('idle');
  });

  it('never interrupts a running turn', () => {
    expect(
      decideCompactReminder({
        settings: settings(),
        counters: counters({ lastRequestAt: new Date(nowMs - 65 * 60_000).toISOString() }),
        ctxTokens: 260_000,
        busy: true,
        nowMs,
      }),
    ).toBeNull();
  });

  // 窗口快满了跟「放了多久」无关：这一轮刚答完也该问一句，但要先等它落地。
  it('switches to the capacity reason near the window limit', () => {
    const full = (idleMinutes: number) =>
      decideCompactReminder({
        settings: settings(),
        counters: counters({ lastRequestAt: new Date(nowMs - idleMinutes * 60_000).toISOString() }),
        ctxTokens: 170_000,
        contextWindowSize: 200_000,
        nowMs,
      });
    expect(full(1)).toBeNull();
    expect(full(15)).toBe('context');
  });

  it('scales the "worth a card" floor down with a small window', () => {
    const at = (ctxTokens: number) =>
      decideCompactReminder({
        settings: settings(),
        counters: counters({ lastRequestAt: new Date(nowMs - 65 * 60_000).toISOString() }),
        ctxTokens,
        contextWindowSize: 32_000,
        nowMs,
      });
    // 32K 窗口上「100K 才提醒」永远不成立：门槛按窗口减半（16K）。
    expect(at(12_000)).toBeNull();
    expect(at(20_000)).toBe('idle');
  });

  it('does not ask when the answers are used up or the switch is off', () => {
    const used = counters({
      quickRuns: 999,
      modelRuns: 999,
      lastRequestAt: new Date(nowMs - 65 * 60_000).toISOString(),
    });
    expect(decideCompactReminder({ settings: settings(), counters: used, ctxTokens: 260_000, nowMs })).toBeNull();
    expect(
      decideCompactReminder({
        settings: settings({ remindEnabled: false }),
        counters: counters({ lastRequestAt: new Date(nowMs - 65 * 60_000).toISOString() }),
        ctxTokens: 260_000,
        nowMs,
      }),
    ).toBeNull();
  });

  it('does not guess the idle time after a clock rollback', () => {
    expect(
      decideCompactReminder({
        settings: settings(),
        counters: counters({ lastRequestAt: new Date(nowMs + 60 * 60_000).toISOString() }),
        ctxTokens: 260_000,
        nowMs,
      }),
    ).toBeNull();
  });
});

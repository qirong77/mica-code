import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  EMPTY_COUNTERS,
  decideAutoCompactStep,
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
      lastKind: 'model',
      lastSavedTokens: 4096,
    };
    expect(normalizeCounters(stored)).toEqual(stored);
  });
});

describe('decideAutoCompactStep', () => {
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

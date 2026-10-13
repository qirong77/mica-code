import { describe, expect, it } from 'vitest';
import {
  autoCompactCounterTitle,
  autoCompactDraftFromSettings,
  autoCompactKindLabel,
  autoCompactRunLabel,
  autoCompactSettingsFromDraft,
  autoCompactStatusLabel,
  formatAutoCompactTime,
} from './autoCompact.js';
import type { ConfigWebAutoCompactCounter } from '../src/shared/types.js';

const SETTINGS = {
  enabled: true,
  quickThresholdK: 200,
  quickLimit: 3,
  modelThresholdK: 120,
  modelLimit: 3,
  minIntervalMs: 20 * 60 * 1000,
};

function counter(overrides: Partial<ConfigWebAutoCompactCounter> = {}): ConfigWebAutoCompactCounter {
  return {
    sessionId: '2026-01-01-abcdefgh',
    quickRuns: 2,
    modelRuns: 1,
    lastRunAt: '2026-01-01T00:00:00.000Z',
    lastKind: 'quick',
    lastSavedTokens: 4096,
    lastNote: null,
    ...overrides,
  };
}

describe('auto compact draft', () => {
  it('turns numbers into editable strings', () => {
    expect(autoCompactDraftFromSettings(SETTINGS)).toEqual({
      enabled: true,
      quickThresholdK: '200',
      quickLimit: '3',
      modelThresholdK: '120',
      modelLimit: '3',
      minIntervalMinutes: '20',
    });
    // 缺值、负数、垃圾值都收敛成可编辑的数字，不让表单拿到 NaN
    expect(autoCompactDraftFromSettings({ ...SETTINGS, quickLimit: null as unknown as number })).toMatchObject({
      quickLimit: '0',
    });
    expect(autoCompactDraftFromSettings({ ...SETTINGS, modelLimit: -1 })).toMatchObject({ modelLimit: '0' });
    expect(autoCompactDraftFromSettings({ ...SETTINGS, quickThresholdK: '180' as unknown as number })).toMatchObject({
      quickThresholdK: '180',
    });
    // 存储里是毫秒，表单按分钟编辑
    expect(autoCompactDraftFromSettings({ ...SETTINGS, minIntervalMs: 5 * 60 * 1000 })).toMatchObject({
      minIntervalMinutes: '5',
    });
    expect(
      autoCompactDraftFromSettings({ ...SETTINGS, minIntervalMs: undefined as unknown as number }),
    ).toMatchObject({ minIntervalMinutes: '20' });
  });

  it('round-trips a valid draft', () => {
    const draft = autoCompactDraftFromSettings(SETTINGS);
    expect(autoCompactSettingsFromDraft(draft)).toEqual({ ok: true, settings: SETTINGS });
    expect(autoCompactSettingsFromDraft({ ...draft, enabled: false })).toEqual({
      ok: true,
      settings: { ...SETTINGS, enabled: false },
    });
  });

  it('reports empty, non-numeric and out-of-range fields instead of clamping silently', () => {
    const base = autoCompactDraftFromSettings(SETTINGS);
    for (const value of ['', '  ', 'abc', '-1', '200.5', '0']) {
      expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: value }).ok).toBe(false);
    }
    // 阈值的安全下限：低于它压缩没意义，表单直接拒绝
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '149' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, quickThresholdK: '10001' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, quickLimit: '' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, quickLimit: '1000' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, modelThresholdK: '0' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, modelThresholdK: '99' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, modelLimit: '1000' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, minIntervalMinutes: '' }).ok).toBe(false);
    expect(autoCompactSettingsFromDraft({ ...base, minIntervalMinutes: '1441' }).ok).toBe(false);
    // 上限 0 是合法值（表示不做这类压缩），别被当成「没填」
    expect(autoCompactSettingsFromDraft({ ...base, quickLimit: '0' })).toEqual({
      ok: true,
      settings: { ...SETTINGS, quickLimit: 0 },
    });
    // 间隔 0 同样合法：表示不限制两次压缩的间隔
    expect(autoCompactSettingsFromDraft({ ...base, minIntervalMinutes: '0' })).toEqual({
      ok: true,
      settings: { ...SETTINGS, minIntervalMs: 0 },
    });
    expect(autoCompactSettingsFromDraft({ ...base, minIntervalMinutes: '5' })).toEqual({
      ok: true,
      settings: { ...SETTINGS, minIntervalMs: 5 * 60 * 1000 },
    });
  });
});

describe('auto compact labels', () => {
  it('shows the per-session progress against the current limits', () => {
    expect(autoCompactRunLabel(counter(), SETTINGS)).toBe('快速 2/3 · 模型 1/3');
    expect(autoCompactRunLabel(counter({ quickRuns: 5, modelRuns: 0 }), { ...SETTINGS, quickLimit: 10 })).toBe(
      '快速 5/10 · 模型 0/3',
    );
    expect(autoCompactRunLabel(counter({ quickRuns: -3, modelRuns: 'x' as unknown as number }), SETTINGS)).toBe(
      '快速 0/3 · 模型 0/3',
    );
  });

  it('falls back to the session id when the session file is gone', () => {
    expect(autoCompactCounterTitle(counter({ title: 'Refactor the parser' }))).toBe('Refactor the parser');
    expect(autoCompactCounterTitle(counter({ title: '   ' }))).toBe('2026-01-…（会话已删除）');
    expect(autoCompactCounterTitle(counter({ sessionId: '', title: undefined }))).toBe('未知会话');
  });

  it('summarises the settings for the page header', () => {
    expect(autoCompactStatusLabel(null)).toBe('');
    expect(
      autoCompactStatusLabel({
        path: '/tmp/auto-compact.json',
        settings: SETTINGS,
        defaults: SETTINGS,
        counters: [counter()],
      }),
    ).toBe('快速 200k · 模型 120k · 已压缩 3 次');
    expect(
      autoCompactStatusLabel({
        path: '/tmp/auto-compact.json',
        settings: { ...SETTINGS, enabled: false },
        defaults: SETTINGS,
        counters: [],
      }),
    ).toBe('已关闭');
    expect(autoCompactKindLabel('model')).toBe('模型压缩');
    expect(autoCompactKindLabel(null)).toBe('');
    expect(formatAutoCompactTime('2026-01-01T00:00:00.000Z')).not.toBe('-');
    expect(formatAutoCompactTime(null)).toBe('-');
  });
});

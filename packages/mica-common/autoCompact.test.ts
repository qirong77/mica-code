import { describe, expect, it } from 'vitest';
import {
  AUTO_COMPACT_DEFAULTS,
  AUTO_COMPACT_FIELD_RANGES,
  isEmptyAutoCompactOverride,
  normalizeAutoCompactOverride,
  pruneAutoCompactOverride,
  resolveAutoCompactSettings,
} from './autoCompact.js';

describe('自动压缩的会话覆盖', () => {
  it('只保留显式给出的键，缺失的键继续跟随默认值', () => {
    expect(normalizeAutoCompactOverride({ quickThresholdK: 260 })).toEqual({ quickThresholdK: 260 });
    expect(normalizeAutoCompactOverride(undefined)).toEqual({});
    expect(normalizeAutoCompactOverride({ nope: 1 })).toEqual({});
  });

  it('越界的值钳到边界，非法值整个丢掉（而不是写成默认值）', () => {
    const range = AUTO_COMPACT_FIELD_RANGES.quickThresholdK;
    expect(normalizeAutoCompactOverride({ quickThresholdK: 1 }).quickThresholdK).toBe(range.min);
    expect(normalizeAutoCompactOverride({ quickThresholdK: 999_999 }).quickThresholdK).toBe(range.max);
    expect(normalizeAutoCompactOverride({ quickThresholdK: 'nope' })).toEqual({});
    expect(normalizeAutoCompactOverride({ enabled: 'yes' })).toEqual({});
  });

  it('enabled 只在真的是布尔值时进覆盖', () => {
    expect(normalizeAutoCompactOverride({ enabled: false })).toEqual({ enabled: false });
  });

  it('默认值 + 覆盖 = 生效设置', () => {
    expect(resolveAutoCompactSettings(undefined, undefined)).toEqual(AUTO_COMPACT_DEFAULTS);
    expect(resolveAutoCompactSettings(AUTO_COMPACT_DEFAULTS, { modelLimit: 1 })).toMatchObject({
      modelLimit: 1,
      quickThresholdK: AUTO_COMPACT_DEFAULTS.quickThresholdK,
    });
    // 换一份默认值（桌面设置页），没有覆盖的键跟着新默认值走。
    const base = { ...AUTO_COMPACT_DEFAULTS, quickThresholdK: 300 };
    expect(resolveAutoCompactSettings(base, { modelLimit: 1 }).quickThresholdK).toBe(300);
    expect(resolveAutoCompactSettings(base, { quickThresholdK: 260 }).quickThresholdK).toBe(260);
  });

  it('与默认值相同的键会被剪掉，避免把默认值固化进会话', () => {
    expect(
      pruneAutoCompactOverride(
        { quickThresholdK: AUTO_COMPACT_DEFAULTS.quickThresholdK, modelLimit: 1 },
        AUTO_COMPACT_DEFAULTS,
      ),
    ).toEqual({ modelLimit: 1 });
    expect(pruneAutoCompactOverride({ enabled: AUTO_COMPACT_DEFAULTS.enabled })).toEqual({});
    expect(isEmptyAutoCompactOverride(pruneAutoCompactOverride({ enabled: true }))).toBe(true);
  });
});

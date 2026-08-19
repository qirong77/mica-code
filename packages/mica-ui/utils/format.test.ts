import { describe, expect, it } from 'vitest';
import { buildLoopBadge, formatCountdown, formatElapsed } from './format.js';

describe('formatCountdown', () => {
  it('formats sub-minute remainders in seconds', () => {
    expect(formatCountdown(0)).toBe('即将触发');
    expect(formatCountdown(500)).toBe('即将触发');
    expect(formatCountdown(42_000)).toBe('42 秒');
  });

  it('formats minutes with trailing seconds', () => {
    expect(formatCountdown(3 * 60_000 + 12_000)).toBe('3 分 12 秒');
    expect(formatCountdown(5 * 60_000)).toBe('5 分钟');
  });

  it('formats hours and days', () => {
    expect(formatCountdown(60 * 60_000 + 5 * 60_000)).toBe('1 小时 5 分');
    expect(formatCountdown(2 * 3600_000)).toBe('2 小时');
    expect(formatCountdown(25 * 3600_000)).toBe('1 天');
  });

  it('clamps negative remainders', () => {
    expect(formatCountdown(-1000)).toBe('即将触发');
  });
});

describe('formatElapsed', () => {
  it('keeps existing behavior', () => {
    expect(formatElapsed(900)).toBe('900ms');
    expect(formatElapsed(1500)).toBe('1.5s');
    expect(formatElapsed(90_000)).toBe('1m 30s');
  });
});

describe('buildLoopBadge', () => {
  it('renders interval, countdown and fire count', () => {
    const nextFireAt = 1_700_000_000_000;
    expect(buildLoopBadge('1 小时', 3, nextFireAt, nextFireAt - 192_000)).toBe('⏰ 每 1 小时 · 下次 3 分 12 秒 · 第 3 次');
  });

  it('falls back to 即将触发 when the next fire is imminent', () => {
    const nextFireAt = 1_700_000_000_000;
    expect(buildLoopBadge('10 秒', 1, nextFireAt, nextFireAt - 200)).toContain('下次 即将触发');
  });
});

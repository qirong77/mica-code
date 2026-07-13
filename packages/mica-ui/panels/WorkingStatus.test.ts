import { describe, expect, it } from 'vitest';
import { getContextUsageColorIndex } from './WorkingStatus.js';

describe('getContextUsageColorIndex', () => {
  it('uses the scheme B absolute token thresholds for a 1m context window', () => {
    const windowSize = 1_000_000;

    expect(getContextUsageColorIndex(79_999, windowSize)).toBe(0);
    expect(getContextUsageColorIndex(80_000, windowSize)).toBe(1);
    expect(getContextUsageColorIndex(112_000, windowSize)).toBe(2);
    expect(getContextUsageColorIndex(160_000, windowSize)).toBe(3);
    expect(getContextUsageColorIndex(208_000, windowSize)).toBe(4);
  });

  it('preserves ratio-based warnings when they produce a higher level', () => {
    const windowSize = 256_000;

    expect(getContextUsageColorIndex(76_800, windowSize)).toBe(1);
    expect(getContextUsageColorIndex(115_200, windowSize)).toBe(2);
    expect(getContextUsageColorIndex(153_600, windowSize)).toBe(3);
    expect(getContextUsageColorIndex(204_800, windowSize)).toBe(4);
  });

  it('uses the higher level when ratio and absolute token thresholds differ', () => {
    expect(getContextUsageColorIndex(160_000, 1_000_000)).toBe(3);
    expect(getContextUsageColorIndex(160_000, 200_000)).toBe(4);
  });
});

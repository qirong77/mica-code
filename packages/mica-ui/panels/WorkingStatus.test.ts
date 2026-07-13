import { describe, expect, it } from 'vitest';
import { getContextRatioColorIndex, getContextTokenColorIndex } from './WorkingStatus.js';

describe('context usage color levels', () => {
  it('colors the token count using absolute token thresholds', () => {
    expect(getContextTokenColorIndex(79_999)).toBe(0);
    expect(getContextTokenColorIndex(80_000)).toBe(1);
    expect(getContextTokenColorIndex(120_000)).toBe(2);
    expect(getContextTokenColorIndex(200_000)).toBe(3);
    expect(getContextTokenColorIndex(300_000)).toBe(4);
  });

  it('colors ctx using context-window ratio thresholds', () => {
    const windowSize = 1_000_000;

    expect(getContextRatioColorIndex(399_999, windowSize)).toBe(0);
    expect(getContextRatioColorIndex(400_000, windowSize)).toBe(1);
    expect(getContextRatioColorIndex(500_000, windowSize)).toBe(2);
    expect(getContextRatioColorIndex(600_000, windowSize)).toBe(3);
    expect(getContextRatioColorIndex(700_000, windowSize)).toBe(4);
  });

  it('keeps token and ratio levels independent', () => {
    expect(getContextTokenColorIndex(300_000)).toBe(4);
    expect(getContextRatioColorIndex(300_000, 1_000_000)).toBe(0);
  });
});

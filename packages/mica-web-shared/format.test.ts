import { describe, expect, it } from 'vitest';
import { formatTokens } from './format.js';

describe('formatTokens', () => {
  it('formats invalid, small, and compact values consistently', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(123.4)).toBe('123');
    expect(formatTokens(12_345)).toBe('12.3K');
    expect(formatTokens(1_234_567)).toBe('1.2M');
  });

  it('supports the desktop precision without duplicating the formatter', () => {
    expect(formatTokens(1_234_567, { millionDecimals: 2 })).toBe('1.23M');
  });
});

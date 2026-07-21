import { describe, expect, it } from 'vitest';
import { getMainScreenHeight } from './mainScreenLayout.js';

describe('getMainScreenHeight', () => {
  it.each([2, 3, 24, 80])('reserves a row in a %i-row terminal', (rows) => {
    expect(getMainScreenHeight(rows)).toBe(rows - 1);
    expect(getMainScreenHeight(rows)).toBeLessThan(rows);
  });

  it('uses an empty frame when no safe main-screen row is available', () => {
    expect(getMainScreenHeight(1)).toBe(0);
    expect(getMainScreenHeight(0)).toBe(0);
    expect(getMainScreenHeight(Number.NaN)).toBe(23);
  });
});

import { describe, expect, it } from 'vitest';
import { getBottomPanelHeight } from './useLogViewHeight.js';

describe('getBottomPanelHeight', () => {
  it.each([
    { rows: 24, bottomDistance: 0, cursorRow: null, expected: 8 },
    { rows: 24, bottomDistance: 12, cursorRow: null, expected: 10 },
    { rows: 24, bottomDistance: 4, cursorRow: null, expected: 5 },
    { rows: 24, bottomDistance: 3, cursorRow: 6, expected: 16 },
    { rows: 40, bottomDistance: 20, cursorRow: 10, expected: 28 },
    { rows: 24, bottomDistance: 18, cursorRow: 23, expected: 5 },
  ])('prefers the physical cursor row when available: $cursorRow', ({ rows, bottomDistance, cursorRow, expected }) => {
    expect(getBottomPanelHeight(rows, bottomDistance, cursorRow)).toBe(expected);
  });
});

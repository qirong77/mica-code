import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  buildMonthGrid,
  clampIsoDate,
  isIsoDate,
  monthOfIso,
  moveIsoDate,
  shiftMonth,
  todayIso,
} from './dateFieldModel.js';

describe('date field model', () => {
  it('accepts only real dates', () => {
    expect(isIsoDate('2026-11-03')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-11-03')).toBe(false);
    expect(isIsoDate('2026-11-3')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('does day arithmetic across month and year boundaries', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('keeps today on the local calendar, not UTC', () => {
    const local = new Date(2026, 10, 3, 23, 30);
    expect(todayIso(local)).toBe('2026-11-03');
  });

  it('starts the grid on Monday and fills six weeks', () => {
    const grid = buildMonthGrid(2026, 11);
    expect(grid).toHaveLength(42);
    // 2026-11-01 是周日，所以第一格是 10 月 26 日（周一）
    expect(grid[0]).toEqual({ iso: '2026-10-26', inMonth: false });
    expect(grid[6]).toEqual({ iso: '2026-11-01', inMonth: true });
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(30);
    expect(grid[41]!.iso).toBe('2026-12-06');
  });

  it('moves months in both directions', () => {
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(monthOfIso('2026-11-03')).toEqual({ year: 2026, month: 11 });
  });

  it('clamps to the allowed range and refuses to walk past it', () => {
    expect(clampIsoDate('2026-01-01', '2026-02-01')).toBe('2026-02-01');
    expect(clampIsoDate('2026-05-01', undefined, '2026-04-01')).toBe('2026-04-01');
    expect(clampIsoDate('2026-03-01', '2026-02-01', '2026-04-01')).toBe('2026-03-01');
    expect(moveIsoDate('2026-02-01', -1, '2026-02-01')).toBe('2026-02-01');
    expect(moveIsoDate('2026-02-01', 1, '2026-02-01')).toBe('2026-02-02');
    expect(moveIsoDate('2026-04-01', 1, undefined, '2026-04-01')).toBe('2026-04-01');
  });
});

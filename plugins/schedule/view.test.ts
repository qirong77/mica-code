import { describe, expect, it } from 'vitest';
import { dayLabel, describeWhen, shortDate, spanDays } from './view.js';

describe('shortDate / dayLabel', () => {
  it('drops the year and leading zeros', () => {
    expect(shortDate('2026-10-28')).toBe('10.28');
    expect(shortDate('2026-01-05')).toBe('1.5');
  });

  it('puts the weekday on the date label', () => {
    expect(dayLabel('2026-11-02')).toBe('11-02 周一');
    expect(dayLabel('2026-11-01')).toBe('11-01 周日');
  });
});

describe('describeWhen', () => {
  it('counts days to the start', () => {
    expect(describeWhen('2026-10-30', '2026-11-02', '2026-10-29')).toBe('明天开始');
    expect(describeWhen('2026-11-02', '2026-11-05', '2026-10-29')).toBe('4 天后开始');
  });

  it('says which day of a running task it is', () => {
    expect(describeWhen('2026-10-28', '2026-10-31', '2026-10-29')).toBe('进行中，第 2/4 天');
  });

  it('says how long ago a finished task ended', () => {
    expect(describeWhen('2026-10-01', '2026-10-03', '2026-10-08')).toBe('已结束 5 天');
  });

  it('counts the last day as the end day', () => {
    expect(spanDays('2026-10-01', '2026-10-01')).toBe(1);
    expect(spanDays('2026-10-01', '2026-10-07')).toBe(7);
    expect(describeWhen('2026-10-05', '2026-10-05', '2026-10-05')).toBe('进行中，第 1/1 天');
  });
});

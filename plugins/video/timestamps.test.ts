import { describe, expect, it } from 'vitest';
import { formatDuration, formatTimePoint, parseTimePoint } from './timestamps.js';

describe('parseTimePoint', () => {
  it('接受裸秒数', () => {
    expect(parseTimePoint('90')).toBe(90);
    expect(parseTimePoint('5.5')).toBe(5.5);
    expect(parseTimePoint('0')).toBe(0);
  });

  it('接受 分:秒 与 时:分:秒', () => {
    expect(parseTimePoint('1:03.5')).toBe(63.5);
    expect(parseTimePoint('4:50')).toBe(290);
    expect(parseTimePoint('01:02:03')).toBe(3723);
    expect(parseTimePoint('1:02:03.25')).toBeCloseTo(3723.25, 3);
  });

  it('容忍秒段超过 60 的写法', () => {
    expect(parseTimePoint('1:90')).toBe(150);
  });

  it('去掉两端空白', () => {
    expect(parseTimePoint('  2:10  ')).toBe(130);
  });

  it('拒绝无法理解的形式', () => {
    expect(parseTimePoint('')).toBeNull();
    expect(parseTimePoint('abc')).toBeNull();
    expect(parseTimePoint('-5')).toBeNull();
    expect(parseTimePoint('1:2:3:4')).toBeNull();
    expect(parseTimePoint('1.5:30')).toBeNull();
    expect(parseTimePoint('1:2a')).toBeNull();
  });
});

describe('formatTimePoint', () => {
  it('一小时以内用 分:秒.十分位', () => {
    expect(formatTimePoint(0)).toBe('0:00.0');
    expect(formatTimePoint(63.5)).toBe('1:03.5');
    expect(formatTimePoint(290)).toBe('4:50.0');
  });

  it('一小时以上带小时', () => {
    expect(formatTimePoint(3723)).toBe('1:02:03.0');
  });

  it('四舍五入到十分位，进位不出现 60 秒', () => {
    expect(formatTimePoint(59.97)).toBe('1:00.0');
    expect(formatTimePoint(9.96)).toBe('0:10.0');
  });

  it('与 parseTimePoint 往返一致', () => {
    for (const seconds of [0, 1.5, 63.5, 290, 3599.9, 3723.2]) {
      // 格式化只保留十分位，往返误差上限就是 0.05（避开浮点边界）。
      expect(Math.abs(parseTimePoint(formatTimePoint(seconds))! - seconds)).toBeLessThan(0.051);
    }
  });
});

describe('formatDuration', () => {
  it('省略小数', () => {
    expect(formatDuration(761.2)).toBe('12:41');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(3723)).toBe('1:02:03');
  });
});

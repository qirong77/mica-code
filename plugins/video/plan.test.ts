import { describe, expect, it } from 'vitest';
import { MAX_EXPLICIT_FRAMES, MAX_FRAMES, planFrames } from './plan.js';

const BASE = { durationSeconds: 600, defaultCount: 4 };

describe('planFrames · 均匀采样', () => {
  it('默认取居中四点，避开首尾', () => {
    const plan = planFrames({ ...BASE });
    expect(plan.frames.map((frame) => frame.seconds)).toEqual([75, 225, 375, 525]);
    expect(plan.notes).toEqual([]);
  });

  it('count 覆盖默认值', () => {
    const plan = planFrames({ ...BASE, count: 2 });
    expect(plan.frames.map((frame) => frame.seconds)).toEqual([150, 450]);
  });

  it('start/end 收窄区间', () => {
    const plan = planFrames({ ...BASE, count: 2, start: '1:00', end: '2:00' });
    expect(plan.frames.map((frame) => frame.seconds)).toEqual([75, 105]);
  });

  it('count 超上限时夹住并说明', () => {
    const plan = planFrames({ ...BASE, count: 50 });
    expect(plan.frames).toHaveLength(MAX_FRAMES);
    expect(plan.notes.join()).toContain('成本上限');
  });

  it('count 为 0 或负数时按 1 张', () => {
    expect(planFrames({ ...BASE, count: 0 }).frames).toHaveLength(1);
  });

  it('end 超出时长时夹到结尾并说明', () => {
    const plan = planFrames({ ...BASE, end: '99:00' });
    expect(plan.notes.join()).toContain('end 超出视频时长');
    expect(plan.frames.at(-1)!.seconds).toBeLessThan(600);
  });

  it('区间无效时报错', () => {
    expect(() => planFrames({ ...BASE, start: '5:00', end: '1:00' })).toThrow(/区间无效/);
  });

  it('时间写法听不懂时报错并给出期望格式', () => {
    expect(() => planFrames({ ...BASE, start: 'abc' })).toThrow(/3:20\.5/);
  });

  it('时长无效时报错', () => {
    expect(() => planFrames({ ...BASE, durationSeconds: 0 })).toThrow(/时长/);
    expect(() => planFrames({ ...BASE, durationSeconds: Number.NaN })).toThrow(/时长/);
  });
});

describe('planFrames · 点名时间点', () => {
  it('按时间排序返回', () => {
    const plan = planFrames({ ...BASE, at: ['5:00', '1:00', '3:00'] });
    expect(plan.frames.map((frame) => frame.seconds)).toEqual([60, 180, 300]);
  });

  it('忽略 count 并说明', () => {
    const plan = planFrames({ ...BASE, at: ['1:00'], count: 8 });
    expect(plan.frames).toHaveLength(1);
    expect(plan.notes.join()).toContain('count 不生效');
  });

  it('忽略 start/end 并说明', () => {
    const plan = planFrames({ ...BASE, at: ['1:00'], start: '0:30' });
    expect(plan.notes.join()).toContain('start/end 不生效');
  });

  it('超时长的时刻夹到结尾，并记下原值', () => {
    const plan = planFrames({ ...BASE, durationSeconds: 100, at: ['10:00'] });
    // 留了一点余量：`-ss` 正好等于时长时 ffmpeg 一帧都取不到。
    expect(plan.frames[0]!.seconds).toBeLessThan(100);
    expect(plan.frames[0]!.seconds).toBeGreaterThan(99);
    expect(plan.frames[0]!.requested).toBe('10:00');
    // 余量至少两帧（默认按 25fps 估），所以停在 1:39.9 而不是正好 1:40。
    expect(plan.notes.join()).toContain('10:00 → 1:39.9');
  });

  it('相邻时刻合并成一帧', () => {
    const plan = planFrames({ ...BASE, at: ['1:00', '1:00.01', '2:00'] });
    expect(plan.frames).toHaveLength(2);
    expect(plan.notes.join()).toContain('重合');
  });

  it('超过点名上限时截断并说明', () => {
    const at = Array.from({ length: 12 }, (_, index) => `${index * 10}`);
    const plan = planFrames({ ...BASE, at });
    expect(plan.frames).toHaveLength(MAX_EXPLICIT_FRAMES);
    expect(plan.notes.join()).toContain(`最多取 ${MAX_EXPLICIT_FRAMES}`);
  });

  it('有非法时间点时报错并列出它们', () => {
    expect(() => planFrames({ ...BASE, at: ['1:00', 'later'] })).toThrow(/later/);
  });

  it('空字符串数组退回均匀采样', () => {
    const plan = planFrames({ ...BASE, at: ['', '  '] });
    expect(plan.frames).toHaveLength(4);
  });
});

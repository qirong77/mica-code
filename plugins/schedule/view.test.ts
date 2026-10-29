import { describe, expect, it } from 'vitest';
import type { AgendaItem } from './parse.js';
import {
  dayLabel,
  describeWhen,
  formatRange,
  freshness,
  groupByDay,
  shortDate,
  stageTone,
  todayOf,
} from './view.js';

function item(overrides: Partial<AgendaItem>): AgendaItem {
  return {
    groupId: '1',
    groupName: '违章处置线上化',
    key: 'testing',
    label: '测试',
    start: '2026-10-28',
    end: '2026-10-30',
    range: true,
    startIn: -1,
    endIn: 1,
    span: 3,
    dayIndex: 2,
    ...overrides,
  };
}

describe('view', () => {
  it('日期按本地时区取，不跟着 UTC 跨天', () => {
    expect(todayOf(new Date(2026, 9, 29, 0, 5))).toBe('2026-10-29');
    expect(todayOf(new Date(2026, 9, 29, 23, 55))).toBe('2026-10-29');
    expect(shortDate('2026-11-02')).toBe('11.2');
    expect(dayLabel('2026-11-02')).toBe('11-02 周一');
  });

  it('连续的写区间，不连续的列日期', () => {
    expect(formatRange({ start: '2026-10-28', end: '2026-10-28', days: ['2026-10-28'], range: true })).toBe('10.28');
    expect(
      formatRange({ start: '2026-10-28', end: '2026-10-30', days: ['2026-10-28', '2026-10-30'], range: true }),
    ).toBe('10.28–10.30');
    expect(
      formatRange({ start: '2026-10-30', end: '2026-11-02', days: ['2026-10-30', '2026-11-02'], range: false }),
    ).toBe('10.30、11.2');
  });

  it('时间提示说人话', () => {
    expect(describeWhen(item({}))).toBe('第 2/3 天');
    expect(describeWhen(item({ dayIndex: 0, startIn: 0 }))).toBe('今天');
    expect(describeWhen(item({ dayIndex: 0, startIn: 1 }))).toBe('明天');
    expect(describeWhen(item({ dayIndex: 0, startIn: 3 }))).toBe('3 天后');
  });

  it('接下来的节点按天分组，同一天的上线排前面', () => {
    const groups = groupByDay([
      item({ key: 'walkthrough', start: '2026-11-02', end: '2026-11-02' }),
      item({ key: 'release', start: '2026-11-02', end: '2026-11-02' }),
      item({ key: 'dev', start: '2026-11-03', end: '2026-11-09' }),
    ]);
    expect(groups.map((group) => group.date)).toEqual(['2026-11-02', '2026-11-03']);
    expect(groups[0]!.items.map((entry) => entry.key)).toEqual(['walkthrough', 'release']);
  });

  it('阶段只分三类颜色', () => {
    expect(stageTone('release')).toBe('release');
    expect(stageTone('walkthrough')).toBe('review');
    expect(stageTone('showcase')).toBe('review');
    expect(stageTone('testing')).toBe('normal');
    expect(stageTone('unknown-stage')).toBe('normal');
  });

  it('新鲜度按分钟/小时/天说，没整理过就直说', () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    expect(freshness(0, now)).toBe('还没整理过');
    expect(freshness(now - 30_000, now)).toBe('刚刚整理');
    expect(freshness(now - 12 * 60_000, now)).toBe('12 分钟前整理');
    expect(freshness(now - 5 * 3_600_000, now)).toBe('5 小时前整理');
    expect(freshness(now - 3 * 86_400_000, now)).toBe('3 天前整理');
  });
});

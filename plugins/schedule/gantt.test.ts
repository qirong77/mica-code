import { describe, expect, it } from 'vitest';
import {
  addDays,
  axisCells,
  buildGantt,
  clampZoom,
  GROUP_ROW_HEIGHT,
  pxPerDayOf,
  STAGE_ROW_HEIGHT,
  todayScrollLeft,
  zoomAnchor,
} from './gantt.js';

function stage(key: string, start: string, end: string, days = [start, end], range = true) {
  return { key, label: key, start, end, days, range };
}

describe('buildGantt', () => {
  it('pads the axis around the stages and keeps today inside it', () => {
    const layout = buildGantt(
      [{ id: 'a', name: 'A', stages: [stage('dev', '2026-10-01', '2026-10-05')] }],
      { today: '2026-10-29' },
    );
    expect(layout.start < '2026-10-01').toBe(true);
    expect(layout.end > '2026-10-29').toBe(true);
    expect(layout.days).toBeGreaterThan(0);
    // 偏移量是相对时间轴左端算的
    const stageRow = layout.rows.find((row) => row.kind === 'stage')!;
    expect(stageRow.kind === 'stage' && stageRow.offset).toBeGreaterThan(0);
    expect(stageRow.kind === 'stage' && stageRow.span).toBe(5);
  });

  it('gives every stage its own row under its group', () => {
    const layout = buildGantt(
      [
        {
          id: 'a',
          name: 'A',
          stages: [stage('testing', '2026-10-28', '2026-10-30'), stage('release', '2026-10-29', '2026-10-29')],
        },
      ],
      { today: '2026-10-29' },
    );
    expect(layout.rows.map((row) => row.kind)).toEqual(['group', 'stage', 'stage']);
    // 行高累加，左侧标签与右侧时间轴靠同一份 top 对齐
    expect(layout.rows.map((row) => row.top)).toEqual([0, GROUP_ROW_HEIGHT, GROUP_ROW_HEIGHT + STAGE_ROW_HEIGHT]);
    expect(layout.height).toBe(GROUP_ROW_HEIGHT + STAGE_ROW_HEIGHT * 2);
  });

  it('ranks live work first, then upcoming, then finished', () => {
    const layout = buildGantt(
      [
        { id: 'done', name: '已结束', stages: [stage('dev', '2026-09-01', '2026-09-03')] },
        { id: 'next', name: '待开始', stages: [stage('dev', '2026-11-10', '2026-11-12')] },
        { id: 'live', name: '进行中', stages: [stage('testing', '2026-10-28', '2026-11-02')] },
      ],
      { today: '2026-10-29' },
    );
    const groupNames = layout.rows.filter((row) => row.kind === 'group').map((row) => row.name);
    expect(groupNames).toEqual(['进行中', '待开始', '已结束']);
  });

  it('drops groups without stages instead of drawing empty rows', () => {
    const layout = buildGantt([{ id: 'empty', name: '空', stages: [] }], { today: '2026-10-29' });
    expect(layout.rows).toEqual([]);
  });
});

describe('axis cells', () => {
  it('labels day ticks with the weekday', () => {
    const { major, minor } = axisCells('2026-10-26', 7, 'day');
    expect(minor).toHaveLength(7);
    expect(minor[0]).toMatchObject({ label: '26', sub: '一' });
    expect(major[0]).toMatchObject({ label: '10 月', offset: 0 });
  });

  it('starts week ticks on mondays', () => {
    const { minor } = axisCells('2026-10-29', 21, 'week');
    const first = minor[0]!;
    // 2026-10-29 是周四，轴左端的第一个周刻度必须退回到周一 10-26
    expect(first.offset).toBe(0);
    expect(first.label).toBe('10.26');
    expect(minor.map((cell) => cell.span).reduce((sum, span) => sum + span, 0)).toBe(21);
  });

  it('groups month ticks by year', () => {
    const { major, minor } = axisCells('2026-11-15', 60, 'month');
    expect(major[0]!.label).toBe('2026 年');
    expect(minor[0]!.label).toBe('11 月');
    expect(minor[1]!.label).toBe('12 月');
    expect(major.reduce((sum, cell) => sum + cell.span, 0)).toBe(60);
    expect(minor.reduce((sum, cell) => sum + cell.span, 0)).toBe(60);
  });
});

describe('zoom helpers', () => {
  it('clamps zoom into range', () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(9)).toBe(3);
  });

  it('keeps the day under the cursor in place', () => {
    const pxPerDay = pxPerDayOf('day', 1);
    const anchor = 300;
    const scrollLeft = 400;
    const dayAtAnchor = (scrollLeft + anchor) / pxPerDay;
    const next = zoomAnchor({
      start: '2026-10-01',
      scrollLeft,
      pxPerDay,
      scale: 'day',
      zoom: 2,
      anchorX: anchor,
      viewportWidth: 1000,
    });
    expect((next.scrollLeft + anchor) / pxPerDayOf('day', 2)).toBeCloseTo(dayAtAnchor, 6);
  });

  it('scrolls today to roughly a third of the viewport', () => {
    const pxPerDay = 20;
    const left = todayScrollLeft('2026-10-01', '2026-10-31', pxPerDay, 900);
    expect(left).toBe(30 * pxPerDay - 300);
  });

  it('counts days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

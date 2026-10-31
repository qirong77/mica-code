import { describe, expect, it } from 'vitest';
import { addDays } from './dates.js';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  axisCells,
  buildGantt,
  clampZoom,
  pxPerDayOf,
  rowHeight,
  todayScrollLeft,
  zoomAnchor,
} from './gantt.js';
import type { ScheduleTask } from './schedule.js';

function task(id: string, start: string, end: string, color: ScheduleTask['color'] = 'blue', name = id): ScheduleTask {
  return { id, name, start, end, color, note: '' };
}

describe('buildGantt', () => {
  it('pads the axis around the tasks and keeps today inside it', () => {
    const layout = buildGantt([task('dev', '2026-10-01', '2026-10-05')], { today: '2026-10-29' });
    expect(layout.start < '2026-10-01').toBe(true);
    expect(layout.end > '2026-10-29').toBe(true);
    expect(layout.days).toBeGreaterThan(0);
    const bar = layout.rows[0]!.bars[0]!;
    expect(bar.offset).toBeGreaterThan(0);
    expect(bar.span).toBe(5);
  });

  it('groups tasks by color and keeps the palette order, not the urgency order', () => {
    const layout = buildGantt(
      [
        task('done', '2026-09-01', '2026-09-03', 'amber'),
        task('next', '2026-11-10', '2026-11-12', 'blue'),
        task('live', '2026-10-28', '2026-11-02', 'slate'),
      ],
      { today: '2026-10-29' },
    );
    // COLOR_KEYS = blue / violet / emerald / amber / rose / cyan / slate
    expect(layout.rows.map((row) => row.color)).toEqual(['blue', 'amber', 'slate']);
    expect(layout.rows.map((row) => row.bars[0]!.taskId)).toEqual(['next', 'done', 'live']);
  });

  it('splits overlaps inside one color into lanes and shares a lane for sequential work', () => {
    const overlapping = buildGantt(
      [task('testing', '2026-10-28', '2026-10-30'), task('release', '2026-10-29', '2026-10-29')],
      { today: '2026-10-29' },
    );
    expect(overlapping.rows).toHaveLength(1);
    expect(overlapping.rows[0]!.lanes).toBe(2);
    expect(overlapping.rows[0]!.bars.map((bar) => bar.lane)).toEqual([0, 1]);

    const sequential = buildGantt(
      [task('dev', '2026-10-20', '2026-10-24'), task('testing', '2026-10-25', '2026-10-27')],
      { today: '2026-10-29' },
    );
    expect(sequential.rows[0]!.lanes).toBe(1);
  });

  it('never puts two colors on one row', () => {
    const layout = buildGantt(
      [task('a', '2026-10-20', '2026-10-24', 'blue'), task('b', '2026-10-21', '2026-10-25', 'rose')],
      { today: '2026-10-29' },
    );
    expect(layout.rows).toHaveLength(2);
    expect(layout.rows.map((row) => row.lanes)).toEqual([1, 1]);
  });

  it('has no rows when there are no tasks, but still gives a usable axis around today', () => {
    const layout = buildGantt([], { today: '2026-10-29' });
    expect(layout.rows).toEqual([]);
    expect(layout.start < '2026-10-29' && layout.end > '2026-10-29').toBe(true);
    expect(rowHeight(1)).toBe(40);
    expect(rowHeight(2)).toBe(72);
  });

  it('drops a task with an invalid date instead of breaking the row', () => {
    const layout = buildGantt([task('bad', '2026-02-30', '2026-03-02'), task('ok', '2026-10-01', '2026-10-02')], {
      today: '2026-10-29',
    });
    expect(layout.rows[0]!.bars.map((bar) => bar.taskId)).toEqual(['ok']);
  });
});

describe('axis cells', () => {
  it('labels day ticks with the weekday', () => {
    const { major, minor } = axisCells('2026-10-26', 7, 'day');
    expect(minor).toHaveLength(7);
    expect(minor[0]).toMatchObject({ label: '26', sub: '一' });
    expect(major[0]).toMatchObject({ label: '2026 年 10 月', offset: 0 });
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
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
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

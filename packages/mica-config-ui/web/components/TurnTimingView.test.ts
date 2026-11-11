import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { summarizeTurnTiming, type TurnTimingState } from '@packages/mica-common/turnTiming.js';
import { sortTimingItems, TurnTimingView } from './TurnTimingView.js';

function fixture(): TurnTimingState {
  return {
    startedAt: 1000,
    endedAt: 10000,
    lastAt: 10000,
    openIndex: -1,
    outcome: 'completed',
    segments: [
      { kind: 'wait', start: 1000, end: 2000 },
      { kind: 'generate', start: 2000, end: 3000, chars: 20 },
      { kind: 'tool', start: 3000, end: 8000, tool: 'run_shell', status: 'completed' },
      { kind: 'wait', start: 8000, end: 10000, tail: true },
    ],
  };
}

/** 分段选择是 Arco `Radio.Group`，选中态落在 label 的 `arco-radio-checked` 上而不是 `aria-pressed`。 */
function segmentedOptions(html: string): { label: string; checked: boolean }[] {
  const pattern =
    /<label class="arco-radio-button([^"]*)">[\s\S]*?<span class="arco-radio-button-inner">([^<]*)<\/span>/g;
  return [...html.matchAll(pattern)].map((match) => ({
    label: match[2]!,
    checked: match[1]!.split(' ').includes('arco-radio-checked'),
  }));
}

describe('TurnTimingView sorting', () => {
  it('defaults to chronological order and offers both sorting modes', () => {
    const html = renderToStaticMarkup(
      createElement(TurnTimingView, {
        rounds: [{ id: '1000', state: fixture() }],
      }),
    );
    expect(html).toContain('aria-label="执行过程排序"');
    expect(segmentedOptions(html)).toEqual([
      { label: '按时间', checked: true },
      { label: '按耗时', checked: false },
    ]);
    expect(html).toContain('aria-label="按时间顺序的执行过程"');
    const list = html.slice(html.indexOf('<ol'));
    expect(list.indexOf('等待首字')).toBeLessThan(list.indexOf('输出 20 字符'));
    expect(list.indexOf('输出 20 字符')).toBeLessThan(list.indexOf('run_shell'));
    expect(list).toContain('最慢');
  });

  it('ranks slowest first, keeps ties chronological and preserves original identity and offsets', () => {
    const timing = summarizeTurnTiming(fixture())!;
    const original = [...timing.timeline];
    const rows = sortTimingItems(timing, 'duration');
    expect(rows.map(({ index }) => index)).toEqual([2, 3, 0, 1]);
    expect(rows.map(({ item }) => item.durationMs)).toEqual([5000, 2000, 1000, 1000]);
    expect(rows[0]!.item.offsetMs).toBe(2000);
    expect(rows[0]!.index).toBe(timing.slowestIndex);
    expect(timing.timeline).toEqual(original);
    expect(sortTimingItems(timing, 'time').map(({ index }) => index)).toEqual([0, 1, 2, 3]);
  });

  it('re-ranks a growing live segment using the current duration', () => {
    const state = fixture();
    state.endedAt = 0;
    state.outcome = null;
    state.segments = state.segments.slice(0, 3);
    state.segments[2] = { ...state.segments[2]!, end: 3000, status: 'pending' };
    state.openIndex = 2;
    const early = summarizeTurnTiming(state, 3500)!;
    const later = summarizeTurnTiming(state, 6000)!;
    expect(sortTimingItems(early, 'duration')[0]!.index).toBe(0);
    expect(sortTimingItems(later, 'duration')[0]!.index).toBe(2);
  });

  it('handles empty and single-segment timelines', () => {
    const timing = summarizeTurnTiming(fixture())!;
    expect(sortTimingItems({ ...timing, timeline: [] }, 'duration')).toEqual([]);
    const single = { ...timing, timeline: timing.timeline.slice(0, 1) };
    expect(sortTimingItems(single, 'duration')).toEqual(sortTimingItems(single, 'time'));
    const html = renderToStaticMarkup(createElement(TurnTimingView, { rounds: [] }));
    expect(html).toContain('还没有耗时记录');
    expect(html).not.toContain('执行过程排序');
  });
});

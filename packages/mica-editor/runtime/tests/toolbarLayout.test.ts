import {describe, expect, it} from 'vitest';

import {
  fitToolbarGroups,
  type ToolbarGroup,
} from '../src/playground/plugins/ToolbarPlugin/useAdaptiveToolbar';

type MeasuredGroup = ToolbarGroup & {width: number};

const group = (
  id: string,
  width: number,
  priority?: number,
  section = 'format',
): MeasuredGroup => ({id, width, priority, section});

describe('fitToolbarGroups', () => {
  it('keeps every group when wide and restores them after narrowing', () => {
    const groups = [
      group('insert', 32),
      group('format', 60, 1),
      group('link', 24, 2),
      group('more', 28),
    ];

    expect(fitToolbarGroups(groups, 150, 2, 13)).toEqual(new Set());
    expect(fitToolbarGroups(groups, 62, 2, 13)).toEqual(
      new Set(['format', 'link']),
    );
    expect(fitToolbarGroups(groups, 150, 2, 13)).toEqual(new Set());
  });

  it('uses priority instead of DOM order without mutating the input', () => {
    const groups = [
      group('least-important', 20, 20),
      group('fixed', 20),
      group('important', 40, 0),
      group('secondary', 20, 10),
    ];
    const original = groups.map(item => ({...item}));

    expect(fitToolbarGroups(groups, 62, 2, 13)).toEqual(
      new Set(['least-important', 'secondary']),
    );
    expect(groups).toEqual(original);
  });

  it('prefers earlier groups when priorities tie', () => {
    const groups = [
      group('fixed', 20),
      group('first', 30, 1),
      group('second', 30, 1),
    ];

    expect(fitToolbarGroups(groups, 52, 2, 13)).toEqual(new Set(['second']));
  });

  it('fills spare space with a smaller group after a larger one cannot fit', () => {
    const groups = [
      group('fixed', 32),
      group('wide', 100, 1),
      group('small', 16, 2),
    ];

    expect(fitToolbarGroups(groups, 50, 2, 13)).toEqual(new Set(['wide']));
  });

  it('does not displace a higher-priority group to show more lower-priority groups', () => {
    const groups = [
      group('fixed', 20),
      group('important', 50, 0),
      group('secondary', 30, 1),
      group('extra', 30, 2),
    ];

    expect(fitToolbarGroups(groups, 84, 2, 13)).toEqual(
      new Set(['secondary', 'extra']),
    );
  });

  it('adds section spacing on top of the gap between visible groups', () => {
    const groups = [
      group('fixed', 20, undefined, 'text'),
      group('same-section', 20, 1, 'text'),
      group('next-section', 20, 2, 'color'),
    ];

    expect(fitToolbarGroups(groups, 77, 2, 13)).toEqual(new Set());
    expect(fitToolbarGroups(groups, 76, 2, 13)).toEqual(
      new Set(['next-section']),
    );
    expect(fitToolbarGroups(groups, 64, 2, 0)).toEqual(new Set());
  });

  it('computes spacing from visible neighbors after hiding intervening groups', () => {
    const groups = [
      group('start', 20, undefined, 'text'),
      group('hidden-middle', 100, 2, 'color'),
      group('end', 20, undefined, 'text'),
      group('tail', 10, 1, 'insert'),
    ];

    expect(fitToolbarGroups(groups, 67, 2, 13)).toEqual(
      new Set(['hidden-middle']),
    );
  });

  it('does not charge a leading gap when earlier groups are hidden', () => {
    const groups = [
      group('too-wide', 100, 0, 'text'),
      group('first-visible', 30, 1, 'insert'),
    ];

    expect(fitToolbarGroups(groups, 30, 2, 13)).toEqual(new Set(['too-wide']));
  });

  it('recomputes overflow when groups are added or removed', () => {
    const initial = [group('fixed', 20), group('secondary', 20, 1)];
    const expanded = [...initial, group('important', 30, 0)];

    expect(fitToolbarGroups(initial, 62, 2, 13)).toEqual(new Set());
    expect(fitToolbarGroups(expanded, 62, 2, 13)).toEqual(
      new Set(['secondary']),
    );
    expect(fitToolbarGroups(initial, 62, 2, 13)).toEqual(new Set());
    expect(
      fitToolbarGroups(
        expanded.filter(item => item.id !== 'secondary'),
        62,
        2,
        13,
      ),
    ).toEqual(new Set());
  });

  it('keeps only required groups when even their widths exceed the budget', () => {
    const groups = [
      group('insert', 32, undefined, 'insert'),
      group('optional', 12, 0, 'format'),
      group('more', 28, undefined, 'more'),
    ];

    expect(fitToolbarGroups(groups, 0, 2, 13)).toEqual(new Set(['optional']));
    expect(fitToolbarGroups(groups, 74, 2, 13)).toEqual(new Set(['optional']));
  });

  it('fits exactly at a fractional width boundary', () => {
    const groups = [group('fixed', 20.5), group('optional', 19.25, 0)];

    expect(fitToolbarGroups(groups, 41.75, 2, 13)).toEqual(new Set());
    expect(fitToolbarGroups(groups, 41.74, 2, 13)).toEqual(
      new Set(['optional']),
    );
  });

  it('handles an empty toolbar', () => {
    expect(fitToolbarGroups([], 0, 2, 13)).toEqual(new Set());
  });
});

import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { applyEdits, mergeEditChanges, type ScheduleEdit } from './edits.js';

const edit = (index: number, day: number): ScheduleEdit => ({
  id: `new:dev:${index}`,
  groupId: `g${index % 200}`,
  key: 'dev',
  added: true,
  start: `2026-10-${String(day).padStart(2, '0')}`,
  end: `2026-10-${String(day).padStart(2, '0')}`,
  at: day,
});

it('merges a large window delta without losing independent changes or mutating inputs', () => {
  const previous = Array.from({ length: 6000 }, (_, index) => edit(index, 1));
  const current = previous.map((item, index) => (index % 3 === 0 ? edit(index, 2) : item));
  const desired = previous.flatMap((item, index) =>
    index % 3 === 1 ? [edit(index, 3)] : index % 3 === 2 ? [] : [item],
  );
  const before = JSON.stringify({ current, previous, desired });
  const started = performance.now();
  const merged = mergeEditChanges(current, previous, desired);
  const mergeMs = performance.now() - started;
  const groups = Array.from({ length: 200 }, (_, index) => ({
    id: `g${index}`,
    name: '',
    author: '',
    announcedAt: 0,
    stages: [],
  }));
  const applying = performance.now();
  const applied = applyEdits(groups, merged);
  console.log(
    JSON.stringify({
      sample: '6000 edits, 200 groups',
      mergeMs: +mergeMs.toFixed(2),
      applyMs: +(performance.now() - applying).toFixed(2),
    }),
  );
  expect(merged).toHaveLength(4000);
  expect(merged.every((item) => item.at === (Number(item.id.split(':').at(-1)) % 3 === 0 ? 2 : 3))).toBe(true);
  expect(applied.reduce((sum, group) => sum + group.stages.length, 0)).toBe(4000);
  expect(JSON.stringify({ current, previous, desired })).toBe(before);
});

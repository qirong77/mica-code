import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { schedulePlansStages } from './schedule.js';

let home = '';

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeLegacy(value: unknown): string {
  const file = join(home, 'plugin-data', 'schedule', 'data.json');
  const directory = join(home, 'plugin-data', 'schedule');
  // Keep fixture setup explicit: the migration itself owns directory creation for archives/writes.
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return file;
}

describe('schedulePlansStages', () => {
  it('converts plans/stages under the schedule lock and archives the original', () => {
    home = mkdtempSync(join(tmpdir(), 'mica-evolution-schedule-'));
    const file = writeLegacy({
      version: 1,
      updatedAtMs: 123,
      updatedAt: '10-29 20:40',
      plans: [
        {
          id: 'plan-1',
          name: '钱包改版',
          note: '11 月上线',
          stages: [
            { id: 'stage-1', name: '评审', start: '2026-10-28', end: '2026-10-29' },
            { id: 'stage-2', name: '开发', start: '2026-11-01', end: '2026-11-10' },
          ],
        },
        { id: 'plan-2', name: '官网', note: '', stages: [{ id: 'stage-3', name: '设计', start: '2026-11-02' }] },
      ],
    });
    const original = readFileSync(file, 'utf8');
    const events: string[] = [];

    expect(schedulePlansStages.run({ home, log: (event) => events.push(event) })).toBe(1);
    const migrated = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(migrated).toMatchObject({ version: 1, updatedAtMs: 123, updatedAt: '10-29 20:40' });
    expect(migrated).not.toHaveProperty('plans');
    expect(migrated.tasks).toEqual([
      {
        id: 'stage-1',
        name: '钱包改版 · 评审',
        start: '2026-10-28',
        end: '2026-10-29',
        color: 'blue',
        note: '11 月上线',
      },
      { id: 'stage-2', name: '钱包改版 · 开发', start: '2026-11-01', end: '2026-11-10', color: 'blue', note: '' },
      { id: 'stage-3', name: '官网 · 设计', start: '2026-11-02', end: '2026-11-02', color: 'violet', note: '' },
    ]);
    expect(events).toEqual(['evolution:schedule-migrated']);

    const archive = join(home, 'plugin-data', 'evolution', 'legacy-schedule');
    const archived = readdirSync(archive);
    expect(archived).toHaveLength(1);
    expect(readFileSync(join(archive, archived[0]!), 'utf8')).toBe(original);
    expect(schedulePlansStages.run({ home, log: () => {} })).toBe(0);
    expect(readdirSync(archive)).toEqual(archived);
  });

  it('rejects malformed legacy data without changing the source', () => {
    home = mkdtempSync(join(tmpdir(), 'mica-evolution-schedule-'));
    const file = writeLegacy({
      version: 1,
      plans: [{ name: '坏计划', stages: [{ name: '阶段', start: '2026-02-30' }] }],
    });
    const original = readFileSync(file, 'utf8');

    expect(() => schedulePlansStages.run({ home, log: () => {} })).toThrow('日期范围不合法');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(() => readdirSync(join(home, 'plugin-data', 'evolution', 'legacy-schedule'))).toThrow();
  });

  it('leaves current tasks and unrelated files alone', () => {
    home = mkdtempSync(join(tmpdir(), 'mica-evolution-schedule-'));
    const file = writeLegacy({ version: 1, tasks: [] });
    const original = readFileSync(file, 'utf8');

    expect(schedulePlansStages.run({ home, log: () => {} })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('does not race a schedule writer holding the shared lock', () => {
    home = mkdtempSync(join(tmpdir(), 'mica-evolution-schedule-'));
    const file = writeLegacy({
      version: 1,
      plans: [{ name: '计划', stages: [{ id: 's1', name: '阶段', start: '2026-11-01' }] }],
    });
    const original = readFileSync(file, 'utf8');
    const release = acquireProcessLock(`${file}.lock`);
    expect(release).toBeTypeOf('function');

    expect(schedulePlansStages.run({ home, log: () => {} })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    release?.();
  });
});

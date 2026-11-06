import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type TestContext } from 'vitest';
import { assessmentKey, readAssessments, type FindingAssessment } from '../../harness-review/assessments.js';
import { harnessReviewAssessmentV1, MIGRATIONS } from '../migrations.js';
import { harnessReviewAssessments } from './harness-review.js';
import { DATA_MIGRATIONS } from './index.js';

const id = 'a'.repeat(64);
const updatedAt = '2026-06-01T12:00:00.000Z';
const decision = () => ({
  id,
  status: 'validated',
  note: '  Independent replay passed.\nKeep exact evidence.  ',
  updatedAt,
});

function fixture(t: TestContext) {
  const home = mkdtempSync(join(process.env.MICA_TEST_ROOT ?? tmpdir(), 'assessment-migration-'));
  const root = join(home, 'plugin-data', 'harness-review');
  const decisions = join(root, 'decisions');
  const logs: { event: string; detail?: Record<string, unknown> }[] = [];
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    root,
    decisions,
    logs,
    run: () =>
      harnessReviewAssessments.run({
        home,
        log: (event, detail) => logs.push({ event, detail }),
      }),
  };
}

function write(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

test('pure legacy conversion preserves status, note and timestamp with an explicitly unknown baseline', () => {
  for (const status of ['open', 'accepted', 'dismissed', 'validated', 'regressed']) {
    const legacy: Record<string, unknown> = { ...decision(), status };
    const original = structuredClone(legacy);
    expect(harnessReviewAssessmentV1.apply(legacy)).toBe(1);
    expect(legacy).toEqual({ ...original, version: 1, baseline: null });
    expect(harnessReviewAssessmentV1.apply(legacy)).toBe(0);
    expect(legacy).toEqual({ ...original, version: 1, baseline: null });
  }
});

test('pure migration leaves current, invalid and unrelated shapes unchanged', () => {
  const current = { ...decision(), version: 1, baseline: { runs: {} } };
  for (const document of [
    {},
    { snapshot: decision() },
    { ...decision(), version: 1, baseline: null },
    current,
    { ...decision(), baseline: {} },
    { ...decision(), extra: 'unknown field' },
    { ...decision(), id: '../escape' },
    { ...decision(), status: 'unknown' },
    { ...decision(), note: '' },
    { ...decision(), note: '  ' },
    { ...decision(), note: 'x'.repeat(8001) },
    { ...decision(), updatedAt: 'not a date' },
  ]) {
    const original = structuredClone(document);
    expect(harnessReviewAssessmentV1.apply(document)).toBe(0);
    expect(document).toEqual(original);
  }
});

test('registers only the non-session migration and does nothing when there are no decisions', (t) => {
  const { home, run } = fixture(t);
  expect(DATA_MIGRATIONS).toContain(harnessReviewAssessments);
  expect(MIGRATIONS).not.toContain(harnessReviewAssessmentV1);
  expect(run()).toBe(0);
  expect(readdirSync(home)).toEqual([]);
});

test('moves legacy hash and plugin decisions to private history, archives originals and is idempotent', async (t) => {
  const { root, decisions, run, logs } = fixture(t);
  const legacy = decision();
  const plugin = { ...decision(), id: 'plugin-background:relay:hook_poll', status: 'accepted' };
  const records = [legacy, plugin];
  for (const record of records) {
    write(join(decisions, `${assessmentKey(record.id)}.json`), JSON.stringify(record, null, 2));
  }
  expect(run()).toBe(2);
  for (const record of records) {
    const key = assessmentKey(record.id);
    const directory = join(decisions, key);
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^legacy-[a-f0-9]{64}\.json$/);
    expect(JSON.parse(readFileSync(join(directory, files[0]!), 'utf8'))).toEqual({
      ...record,
      version: 1,
      baseline: null,
    });
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(directory, files[0]!)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(decisions, `${key}.json`))).toBe(false);
    expect(readFileSync(join(decisions, `${key}.legacy-v1.json`), 'utf8')).toBe(JSON.stringify(record, null, 2));
    const warnings: string[] = [];
    expect(await readAssessments(root, record.id, warnings)).toEqual([{ ...record, version: 1, baseline: null }]);
    expect(warnings).toEqual([]);
  }
  const before = readdirSync(decisions, { recursive: true });
  expect(run()).toBe(0);
  expect(readdirSync(decisions, { recursive: true })).toEqual(before);
  expect(logs).toEqual([]);
});

test('does not duplicate matching content after a partial migration or a restored legacy file', (t) => {
  const { decisions, run } = fixture(t);
  const directory = join(decisions, id);
  const history: FindingAssessment = {
    version: 1,
    id,
    status: 'validated',
    note: decision().note,
    updatedAt,
    baseline: null,
  };
  write(join(directory, 'already-written.json'), JSON.stringify(history));
  write(join(decisions, `${id}.json`), JSON.stringify(decision()));
  expect(run()).toBe(1);
  expect(readdirSync(directory)).toEqual(['already-written.json']);
  write(
    join(decisions, `${id}.json`),
    JSON.stringify({ updatedAt, note: decision().note, status: 'validated', id }, null, 2),
  );
  expect(run()).toBe(1);
  expect(readdirSync(directory)).toEqual(['already-written.json']);
  expect(existsSync(join(decisions, `${id}.legacy-v1.json`))).toBe(true);
  expect(existsSync(join(decisions, `${id}.legacy-v1.1.json`))).toBe(true);
  expect(run()).toBe(0);
});

test('retains distinct legacy evidence and never overwrites an existing archive', (t) => {
  const { decisions, run } = fixture(t);
  const file = join(decisions, `${id}.json`);
  write(file, JSON.stringify(decision()));
  write(join(decisions, `${id}.legacy-v1.json`), 'existing archive');
  expect(run()).toBe(1);
  expect(readFileSync(join(decisions, `${id}.legacy-v1.json`), 'utf8')).toBe('existing archive');
  expect(readFileSync(join(decisions, `${id}.legacy-v1.1.json`), 'utf8')).toBe(JSON.stringify(decision()));
  const changed = { ...decision(), status: 'regressed', note: 'A different manual result.' };
  write(file, JSON.stringify(changed));
  expect(run()).toBe(1);
  expect(readdirSync(join(decisions, id))).toHaveLength(2);
  expect(existsSync(join(decisions, `${id}.legacy-v1.2.json`))).toBe(true);
  expect(run()).toBe(0);
});

test('leaves unknown, corrupt, oversized, mismatched and symlinked legacy files untouched', (t) => {
  const { home, decisions, run } = fixture(t);
  const invalid = [
    ['a'.repeat(64), '{ corrupt json'],
    ['b'.repeat(64), JSON.stringify({ ...decision(), id: 'b'.repeat(64), version: 1, baseline: null })],
    ['c'.repeat(64), JSON.stringify({ ...decision(), id: 'c'.repeat(64), status: 'unknown' })],
    ['d'.repeat(64), JSON.stringify(decision())],
    ['e'.repeat(64), ' '.repeat(256 * 1024 + 1)],
    ['f'.repeat(64), JSON.stringify({ ...decision(), id: 'f'.repeat(64), note: '' })],
    ['unknown', JSON.stringify(decision())],
    ['h-' + '1'.repeat(32), JSON.stringify({ ...decision(), id: 'plugin-background:relay:task:extra' })],
  ] as const;
  for (const [key, text] of invalid) write(join(decisions, `${key}.json`), text);
  const outside = join(home, 'outside.json');
  write(outside, JSON.stringify({ ...decision(), id: '1'.repeat(64) }));
  symlinkSync(outside, join(decisions, `${'1'.repeat(64)}.json`));
  expect(run()).toBe(0);
  for (const [key, text] of invalid) expect(readFileSync(join(decisions, `${key}.json`), 'utf8')).toBe(text);
  expect(lstatSync(join(decisions, `${'1'.repeat(64)}.json`)).isSymbolicLink()).toBe(true);
  expect(readdirSync(decisions)).toHaveLength(invalid.length + 1);
});

test('does not write through a symlinked assessment directory or remove its original decision', (t) => {
  const { home, decisions, run, logs } = fixture(t);
  const original = JSON.stringify(decision());
  write(join(decisions, `${id}.json`), original);
  const outside = join(home, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(decisions, id), 'dir');
  expect(run()).toBe(0);
  expect(readFileSync(join(decisions, `${id}.json`), 'utf8')).toBe(original);
  expect(readdirSync(outside)).toEqual([]);
  expect(logs).toHaveLength(1);
  expect(logs[0]?.event).toBe('evolution:harness-review-assessment-skipped');
});

test('does not scan a symlinked decisions root', (t) => {
  const { home, root, run } = fixture(t);
  const outside = join(home, 'outside');
  write(join(outside, `${id}.json`), JSON.stringify(decision()));
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, 'decisions'), 'dir');
  expect(run()).toBe(0);
  expect(readdirSync(outside)).toEqual([`${id}.json`]);
});

test('does not replace conflicting deterministic history and keeps the legacy source', (t) => {
  const { decisions, run, logs } = fixture(t);
  const file = join(decisions, `${id}.json`);
  const original = JSON.stringify(decision());
  write(file, original);
  expect(run()).toBe(1);
  const directory = join(decisions, id);
  const target = join(directory, readdirSync(directory)[0]!);
  writeFileSync(target, '{ preserve conflicting record');
  writeFileSync(file, original);
  expect(run()).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe('{ preserve conflicting record');
  expect(readFileSync(file, 'utf8')).toBe(original);
  expect(readdirSync(directory)).toHaveLength(1);
  expect(logs).toHaveLength(1);
});

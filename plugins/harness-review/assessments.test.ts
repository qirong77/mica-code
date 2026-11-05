import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type TestContext } from 'vitest';
import {
  assessmentKey,
  isFindingAssessment,
  readAssessments,
  writeAssessment,
  type FindingAssessment,
  type FindingStatus,
} from './assessments.js';

const id = 'a'.repeat(64);
const updatedAt = '2026-06-01T12:00:00.000Z';

function assessment(changes: Partial<FindingAssessment> = {}): FindingAssessment {
  return { version: 1, id, status: 'accepted', note: 'Manual review evidence.', updatedAt, baseline: null, ...changes };
}

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(process.env.MICA_TEST_ROOT ?? tmpdir(), 'assessments-'));
  const root = join(temporary, 'capture');
  const directory = join(root, 'decisions', assessmentKey(id));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  return { temporary, root, directory };
}

test('uses the existing decision keys and rejects IDs outside the existing whitelist', () => {
  expect(assessmentKey(id)).toBe(id);
  const pluginId = 'plugin-background:mobile-relay:hook_poll.1';
  expect(assessmentKey(pluginId)).toBe(`h-${createHash('sha256').update(pluginId).digest('hex').slice(0, 32)}`);
  for (const invalid of [
    '',
    '../escape',
    'A'.repeat(64),
    'b'.repeat(63),
    'plugin-background:relay:../poll',
    'plugin-background:relay:task:extra',
    `plugin-background:${'p'.repeat(81)}:poll`,
    `plugin-background:p:${'t'.repeat(121)}`,
  ]) {
    expect(() => assessmentKey(invalid)).toThrow('Invalid finding ID');
  }
});

test('validates version, fields, status, nonempty bounded notes and dates without coercion', () => {
  for (const status of ['open', 'accepted', 'dismissed', 'validated', 'regressed'] as FindingStatus[]) {
    expect(isFindingAssessment(assessment({ status }))).toBe(true);
  }
  expect(isFindingAssessment(assessment({ note: 'x'.repeat(8000) }))).toBe(true);
  for (const invalid of [
    null,
    [],
    { ...assessment(), version: 2 },
    { ...assessment(), extra: true },
    { ...assessment(), status: 'unknown' },
    { ...assessment(), id: '../escape' },
    { ...assessment(), note: '' },
    { ...assessment(), note: '  \n' },
    { ...assessment(), note: 'x'.repeat(8001) },
    { ...assessment(), note: 1 },
    { ...assessment(), updatedAt: '' },
    { ...assessment(), updatedAt: 'not-a-date' },
    { ...assessment(), updatedAt: 1 },
    { ...assessment(), baseline: undefined },
    { ...assessment(), baseline: {} },
  ]) {
    expect(isFindingAssessment(invalid)).toBe(false);
  }
});

test('bounds baseline run UUIDs and counts, and preserves each baseline shape', () => {
  const runId = randomUUID();
  const runs = Object.fromEntries(Array.from({ length: 2000 }, () => [randomUUID(), 0]));
  expect(isFindingAssessment(assessment({ baseline: { runs } }))).toBe(true);
  expect(isFindingAssessment(assessment({ baseline: { plugin: { count: 0, lastAt: updatedAt } } }))).toBe(true);
  for (const baseline of [
    { runs: { ...runs, [randomUUID()]: 1 } },
    { runs: { '../escape': 1 } },
    { runs: { '00000000-0000-0000-0000-000000000000': 1 } },
    { runs: [] },
    { runs: null },
    { runs: { [runId]: -1 } },
    { runs: { [runId]: 1.5 } },
    { runs: { [runId]: Number.MAX_SAFE_INTEGER + 1 } },
    { runs: { [runId]: '1' } },
    { runs: { [runId]: Infinity } },
    { plugin: { count: -1, lastAt: updatedAt } },
    { plugin: { count: 1.1, lastAt: updatedAt } },
    { plugin: { count: 1, lastAt: 'invalid' } },
    { plugin: { count: 1, lastAt: updatedAt, extra: true } },
    { plugin: { count: 1, lastAt: updatedAt }, runs: {} },
  ]) {
    expect(isFindingAssessment({ ...assessment(), baseline })).toBe(false);
  }
});

test('keeps simultaneous assessments in separate private UUID files without leftover temporaries', async (t) => {
  const { root, directory } = await fixture(t);
  await mkdir(root, { mode: 0o755 });
  await chmod(root, 0o755);
  const first = assessment({ note: 'First review', baseline: { runs: { [randomUUID()]: 2 } } });
  const second = assessment({ status: 'validated', note: 'Independent replay passed.' });
  await Promise.all([writeAssessment(root, first), writeAssessment(root, second)]);
  const files = await readdir(directory);
  expect(files).toHaveLength(2);
  for (const file of files) {
    expect(file).toMatch(/^[a-f0-9-]{36}\.json$/);
    expect((await lstat(join(directory, file))).mode & 0o777).toBe(0o600);
  }
  for (const path of [root, join(root, 'decisions'), directory]) {
    expect((await lstat(path)).mode & 0o777).toBe(0o700);
  }
  const warnings: string[] = [];
  const history = await readAssessments(root, id, warnings);
  expect(history).toHaveLength(2);
  expect(history).toEqual(expect.arrayContaining([first, second]));
  expect(warnings).toEqual([]);
});

test('supports plugin baselines and never fills unknown baselines', async (t) => {
  const { root } = await fixture(t);
  const pluginId = 'plugin-background:relay:poll';
  const plugin = assessment({ id: pluginId, baseline: { plugin: { count: 3, lastAt: updatedAt } } });
  await writeAssessment(root, plugin);
  const warnings: string[] = [];
  expect(await readAssessments(root, pluginId, warnings)).toEqual([plugin]);
  await writeAssessment(root, assessment());
  expect(await readAssessments(root, id, warnings)).toEqual([assessment()]);
  expect(warnings).toEqual([]);
});

test('sorts by actual dates ascending and uses filename order for equal instants', async (t) => {
  const { root, directory } = await fixture(t);
  await mkdir(directory, { recursive: true });
  const records = [
    ['z.json', assessment({ note: 'Later', updatedAt: '2026-06-01T13:00:00.000Z' })],
    ['c.json', assessment({ note: 'Tie second', updatedAt })],
    ['a.json', assessment({ note: 'Tie first', updatedAt: '2026-06-01T14:00:00.000+02:00' })],
    ['b.json', assessment({ note: 'Earlier', updatedAt: '2026-06-01T11:00:00.000Z' })],
  ] as const;
  await Promise.all(records.map(([name, record]) => writeFile(join(directory, name), JSON.stringify(record))));
  const warnings: string[] = [];
  expect((await readAssessments(root, id, warnings)).map((item) => item.note)).toEqual([
    'Earlier',
    'Tie first',
    'Tie second',
    'Later',
  ]);
  expect(warnings).toEqual([]);
});

test('rejects invalid write schemas and IDs before creating storage and reports IO failures', async (t) => {
  const { temporary, root } = await fixture(t);
  const bad = assessment({ id: '../escape' });
  await expect(writeAssessment(root, bad)).rejects.toThrow('Invalid finding assessment schema');
  await expect(writeAssessment(root, assessment({ note: '' }))).rejects.toThrow();
  await expect(readAssessments(root, '../escape', [])).rejects.toThrow('Invalid finding ID');
  expect(await readdir(temporary)).toEqual([]);
  await writeFile(root, 'not a directory');
  await expect(writeAssessment(root, assessment())).rejects.toThrow();
});

test('warns about corrupt, oversized, mismatched or invalid records while keeping valid JSON history', async (t) => {
  const { root, directory } = await fixture(t);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'good.json'), JSON.stringify(assessment())),
    writeFile(join(directory, 'corrupt.json'), '{ not json'),
    writeFile(join(directory, 'oversized.json'), ' '.repeat(256 * 1024 + 1)),
    writeFile(join(directory, 'mismatch.json'), JSON.stringify(assessment({ id: 'b'.repeat(64) }))),
    writeFile(join(directory, 'invalid.json'), JSON.stringify({ ...assessment(), baseline: { runs: { invalid: 1 } } })),
    writeFile(join(directory, 'ignored.txt'), '{ not json'),
  ]);
  const warnings: string[] = [];
  expect(await readAssessments(root, id, warnings)).toEqual([assessment()]);
  expect(warnings).toHaveLength(4);
  expect(warnings.join('\n')).toContain('exceeds size limit');
  for (const file of ['corrupt.json', 'mismatch.json', 'invalid.json']) {
    expect(warnings.join('\n')).toContain(file);
  }
});

test('does not follow symlinks, recurse into subdirectories, or read hidden and unsafe JSON paths', async (t) => {
  const { temporary, root, directory } = await fixture(t);
  await mkdir(directory, { recursive: true });
  const outside = join(temporary, 'outside.json');
  await writeFile(outside, JSON.stringify(assessment({ note: 'Do not read' })));
  await symlink(outside, join(directory, 'linked.json'));
  await mkdir(join(directory, 'nested.json'));
  await writeFile(join(directory, 'nested.json', 'record.json'), JSON.stringify(assessment()));
  await writeFile(join(directory, '.hidden.json'), JSON.stringify(assessment()));
  await writeFile(join(directory, 'unsafe\\path.json'), JSON.stringify(assessment()));
  const warnings: string[] = [];
  expect(await readAssessments(root, id, warnings)).toEqual([]);
  expect(warnings).toHaveLength(4);
  expect(await readFile(outside, 'utf8')).toContain('Do not read');
});

test('rejects symlinked history directories for reading and writing', async (t) => {
  const { temporary, root, directory } = await fixture(t);
  const outside = join(temporary, 'outside');
  await mkdir(outside);
  await mkdir(join(root, 'decisions'), { recursive: true });
  await symlink(outside, directory, 'dir');
  const warnings: string[] = [];
  expect(await readAssessments(root, id, warnings)).toEqual([]);
  expect(warnings.join('\n')).toContain('Invalid assessment directory path');
  await expect(writeAssessment(root, assessment())).rejects.toThrow('Invalid assessment directory path');
  expect(await readdir(outside)).toEqual([]);
});

test('warns about unsupported legacy single-file decisions without reading or mutating them', async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'decisions'), { recursive: true });
  const legacy = join(root, 'decisions', `${id}.json`);
  const text = JSON.stringify({ id, status: 'validated', note: 'Old proof', updatedAt });
  await writeFile(legacy, text);
  const warnings: string[] = [];
  expect(await readAssessments(root, id, warnings)).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('/evolution run');
  expect(await readFile(legacy, 'utf8')).toBe(text);
});

test('bounds returned history while retaining the latest verdict beyond the filename limit', async (t) => {
  const { root, directory } = await fixture(t);
  await mkdir(directory, { recursive: true });
  const data = JSON.stringify(assessment());
  await Promise.all(
    Array.from({ length: 1001 }, (_, index) =>
      writeFile(join(directory, `${String(index).padStart(4, '0')}.json`), data),
    ),
  );
  await writeFile(join(directory, 'zz-latest.json'), JSON.stringify(assessment({
    status: 'regressed', updatedAt: '2026-06-02T12:00:00.000Z', note: 'Latest verdict must remain visible.',
  })));
  const warnings: string[] = [];
  const history = await readAssessments(root, id, warnings);
  expect(history).toHaveLength(1000);
  expect(history.at(-1)?.status).toBe('regressed');
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('exceeds 1000');
  expect(warnings[0]).toContain('only the latest 1000');
});

test('missing assessment storage is empty without warnings', async (t) => {
  const { root } = await fixture(t);
  const warnings: string[] = [];
  expect(await readAssessments(root, id, warnings)).toEqual([]);
  expect(warnings).toEqual([]);
});

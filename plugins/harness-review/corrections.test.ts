import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'vitest';
import { CorrectionQueue, type CorrectionInput, type StoredCorrection } from './corrections.js';

const at = '2026-11-01T10:00:00.000Z';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(process.env.MICA_TEST_ROOT ?? tmpdir(), 'mica-corrections-'));
  const root = join(temporary, 'home', 'plugin-data', 'harness-review');
  const errors: unknown[] = [];
  const queue = new CorrectionQueue(root, (error) => errors.push(error));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  return { temporary, root, queue, errors };
}

async function pending(root: string): Promise<string[]> {
  return (await readdir(join(root, 'corrections'))).filter((name) => name.endsWith('.json'));
}

async function saveSummary(
  root: string,
  runId: string,
  events: StoredCorrection[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const corrections = { edit: 0, recall: 0, retry: 0 };
  for (const event of events) corrections[event.kind]++;
  const directory = join(root, 'runs', runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, 'summary.json'),
    JSON.stringify({
      id: runId,
      sessionId: events[0]?.sessionId ?? 'session-a',
      correctionIds: events.map((event) => event.id),
      corrections,
      ...extra,
    }),
    { mode: 0o600 },
  );
}

function event(overrides: Partial<StoredCorrection> = {}): StoredCorrection {
  return { id: randomUUID(), sessionId: 'session-a', kind: 'edit', recordedAt: at, ...overrides };
}

test('append persists a private atomic record immediately, without a recorder or next run', async (t) => {
  const { root, queue, errors } = await fixture(t);
  const before = Date.now();
  await queue.append({ sessionId: 'session-a', kind: 'edit', chars: 12, text: 'private input' } as CorrectionInput);
  const [filename] = await pending(root);
  assert.ok(filename);
  const path = join(root, 'corrections', filename);
  const stored = JSON.parse(await readFile(path, 'utf8')) as StoredCorrection;
  assert.equal(filename, `${stored.id}.json`);
  assert.match(stored.id, /^[a-f0-9-]{36}$/);
  assert.ok(Date.parse(stored.recordedAt) >= before);
  assert.deepEqual(Object.keys(stored).sort(), ['chars', 'id', 'kind', 'recordedAt', 'sessionId']);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'corrections'))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(root, 'corrections')), [filename]);
  assert.deepEqual(errors, []);
});

test('a restarted queue consumes pending events once, without mixing sessions', async (t) => {
  const { root, queue, errors } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'edit', chars: 5 });
  await queue.append({ sessionId: 'session-a', kind: 'recall' });
  await queue.append({ sessionId: 'session-b', kind: 'retry' });

  const restarted = new CorrectionQueue(root);
  const runId = randomUUID();
  const taken = await restarted.take('session-a', runId);
  assert.deepEqual(taken.map((item) => item.kind).sort(), ['edit', 'recall']);
  assert.equal(new Set(taken.map((item) => item.id)).size, 2);
  const claims = join(root, 'corrections', 'claims');
  assert.equal((await stat(claims)).mode & 0o777, 0o700);
  for (const item of taken) {
    const path = join(claims, `${item.id}.json`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ...item, runId });
  }
  await saveSummary(root, runId, taken);
  await new CorrectionQueue(root).ack(runId);
  assert.deepEqual(await new CorrectionQueue(root).take('session-a', randomUUID()), []);
  const other = await new CorrectionQueue(root).take('session-b', randomUUID());
  assert.equal(other.length, 1);
  assert.equal(other[0]!.kind, 'retry');
  assert.deepEqual(errors, []);
});

test('independent concurrent consumers never return the same event', async (t) => {
  const { root, queue } = await fixture(t);
  for (let index = 0; index < 24; index++) await queue.append({ sessionId: 'session-a', kind: 'retry' });
  const runA = randomUUID();
  const runB = randomUUID();
  const [left, right] = await Promise.all([
    new CorrectionQueue(root).take('session-a', runA),
    new CorrectionQueue(root).take('session-a', runB),
  ]);
  const all = [...left, ...right];
  assert.equal(all.length, 24);
  assert.equal(new Set(all.map((item) => item.id)).size, 24);
  for (const [events, runId] of [
    [left, runA],
    [right, runB],
  ] as const)
    for (const item of events)
      assert.equal(
        JSON.parse(await readFile(join(root, 'corrections', 'claims', `${item.id}.json`), 'utf8')).runId,
        runId,
      );
});

test('concurrent calls with the same run ID also consume only once', async (t) => {
  const { root, queue } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'recall' });
  const runId = randomUUID();
  const [left, right] = await Promise.all([
    queue.take('session-a', runId),
    new CorrectionQueue(root).take('session-a', runId),
  ]);
  assert.equal(left.length + right.length, 1);
  assert.deepEqual(await new CorrectionQueue(root).take('session-a', runId), []);
});

test('a claim without a persisted receipt is retained and warned about, never reassigned', async (t) => {
  const { root, queue } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'edit' });
  const oldRun = randomUUID();
  const [taken] = await queue.take('session-a', oldRun);
  assert.ok(taken);
  const errors: unknown[] = [];
  const restarted = new CorrectionQueue(root, (error) => errors.push(error));
  assert.deepEqual(await restarted.take('session-a', randomUUID()), []);
  assert.ok(restarted.warnings.some((warning) => warning.includes(oldRun) && warning.includes('Not reassigned')));
  assert.equal(errors.length, 1);
  await restarted.ack(oldRun);
  assert.deepEqual(await pending(root), [`${taken.id}.json`]);
  assert.equal(
    JSON.parse(await readFile(join(root, 'corrections', 'claims', `${taken.id}.json`), 'utf8')).runId,
    oldRun,
  );
});

test('a persisted receipt prevents replay after restart even if ack was interrupted', async (t) => {
  const { root, queue } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'retry' });
  const runId = randomUUID();
  const taken = await queue.take('session-a', runId);
  await saveSummary(root, runId, taken);
  const restarted = new CorrectionQueue(root);
  assert.deepEqual(await restarted.take('session-a', randomUUID()), []);
  assert.deepEqual(restarted.warnings, []);
  await restarted.ack(runId);
  assert.deepEqual(await pending(root), []);
  assert.deepEqual(await readdir(join(root, 'corrections', 'claims')), [`${taken[0]!.id}.json`]);
});

test('ack checks run ownership, exact receipt IDs, session and original record before deleting', async (t) => {
  const { root, queue, errors } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'edit' });
  const runA = randomUUID();
  const a = await queue.take('session-a', runA);
  await queue.append({ sessionId: 'session-b', kind: 'recall' });
  const runB = randomUUID();
  const b = await queue.take('session-b', runB);
  const runC = randomUUID();
  await saveSummary(root, runC, a);
  await queue.ack(runC);
  assert.equal((await pending(root)).length, 2);

  await saveSummary(root, runA, a, { correctionIds: [randomUUID()] });
  await queue.ack(runA);
  assert.equal((await pending(root)).length, 2);
  await saveSummary(root, runA, a, { sessionId: 'session-b' });
  await queue.ack(runA);
  assert.equal((await pending(root)).length, 2);
  await saveSummary(root, runA, a);
  const path = join(root, 'corrections', `${a[0]!.id}.json`);
  await writeFile(path, JSON.stringify({ ...a[0], chars: 99 }));
  await queue.ack(runA);
  assert.equal((await pending(root)).length, 2);
  await writeFile(path, JSON.stringify(a[0]));
  await queue.ack(runA);
  assert.deepEqual(await pending(root), [`${b[0]!.id}.json`]);
  assert.ok(await stat(join(root, 'corrections', 'claims', `${b[0]!.id}.json`)));
  await saveSummary(root, runB, b);
  await queue.ack(runB);
  await queue.ack(runB);
  assert.deepEqual(await pending(root), []);
  assert.ok(errors.length >= 3);
});

test('an immutable claim still prevents replay when an acknowledged pending file reappears', async (t) => {
  const { root, queue } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'edit' });
  const runId = randomUUID();
  const [taken] = await queue.take('session-a', runId);
  assert.ok(taken);
  await saveSummary(root, runId, [taken]);
  await queue.ack(runId);
  await writeFile(join(root, 'corrections', `${taken.id}.json`), JSON.stringify(taken), { mode: 0o600 });
  const restarted = new CorrectionQueue(root);
  assert.deepEqual(await restarted.take('session-a', randomUUID()), []);
  assert.deepEqual(restarted.warnings, []);
});

test('bad, oversized, unsafe and mismatched files do not block a healthy event', async (t) => {
  const { temporary, root, queue, errors } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'edit' });
  const directory = join(root, 'corrections');
  const malformed = event();
  await writeFile(join(directory, `${malformed.id}.json`), '{');
  const tooLarge = event();
  await writeFile(join(directory, `${tooLarge.id}.json`), ' '.repeat(10 * 1024 + 1));
  const invalidKind = event();
  await writeFile(join(directory, `${invalidKind.id}.json`), JSON.stringify({ ...invalidKind, kind: 'text' }));
  const longSession = event({ sessionId: 's'.repeat(301) });
  await writeFile(join(directory, `${longSession.id}.json`), JSON.stringify(longSession));
  const wrongId = event();
  await writeFile(join(directory, `${wrongId.id}.json`), JSON.stringify(event()));
  const invalidChars = event();
  await writeFile(join(directory, `${invalidChars.id}.json`), JSON.stringify({ ...invalidChars, chars: -1 }));
  const invalidDate = event();
  await writeFile(
    join(directory, `${invalidDate.id}.json`),
    JSON.stringify({ ...invalidDate, recordedAt: 'yesterday' }),
  );
  await writeFile(join(directory, 'not-a-uuid.json'), JSON.stringify(event()));
  await mkdir(join(directory, `${randomUUID()}.json`));
  const linked = event();
  const target = join(temporary, 'symlink-target');
  await writeFile(target, JSON.stringify(linked));
  await symlink(target, join(directory, `${linked.id}.json`));

  const taken = await queue.take('session-a', randomUUID());
  assert.equal(taken.length, 1);
  assert.equal(taken[0]!.kind, 'edit');
  assert.equal(errors.length, 10);
  assert.equal(queue.warnings.length, 10);
  assert.equal(await readFile(target, 'utf8'), JSON.stringify(linked));
});

test('invalid and foreign claims never allow a pending event to be stolen', async (t) => {
  const { root, queue, errors } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'edit' });
  await queue.append({ sessionId: 'session-a', kind: 'recall' });
  const files = await pending(root);
  const events = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(root, 'corrections', file), 'utf8')) as StoredCorrection),
  );
  const claims = join(root, 'corrections', 'claims');
  await mkdir(claims, { mode: 0o700 });
  await writeFile(join(claims, files[0]!), JSON.stringify({ ...events[0], runId: '../../outside' }));
  await writeFile(
    join(claims, files[1]!),
    JSON.stringify({ ...events[1], sessionId: 'session-b', runId: randomUUID() }),
  );
  assert.deepEqual(await queue.take('session-a', randomUUID()), []);
  assert.equal(errors.length, 2);
  assert.equal((await pending(root)).length, 2);
});

test('write failures reject and are surfaced through onError and warnings', async (t) => {
  const { temporary } = await fixture(t);
  const root = join(temporary, 'not-a-directory');
  await writeFile(root, 'blocked');
  const errors: unknown[] = [];
  const queue = new CorrectionQueue(root, (error) => errors.push(error));
  await assert.rejects(queue.append({ sessionId: 'session-a', kind: 'edit' }));
  assert.equal(errors.length, 1);
  assert.equal(queue.warnings.length, 1);
  assert.equal(await readFile(root, 'utf8'), 'blocked');
});

test('missing directories are empty but other scan errors reject instead of silently returning empty', async (t) => {
  const { root, queue, errors } = await fixture(t);
  assert.deepEqual(await queue.take('session-a', randomUUID()), []);
  assert.deepEqual(errors, []);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'corrections'), 'blocked');
  await assert.rejects(queue.take('session-a', randomUUID()), /directory/);
  assert.equal(errors.length, 1);
});

test('invalid arguments are rejected without creating files and error callbacks are isolated', async (t) => {
  const { root, queue, errors } = await fixture(t);
  for (const input of [
    { sessionId: '', kind: 'edit' },
    { sessionId: 's'.repeat(301), kind: 'recall' },
    { sessionId: 'session-a', kind: 'invalid' },
    { sessionId: 'session-a', kind: 'edit', chars: -1 },
    { sessionId: 'session-a', kind: 'edit', chars: 1.5 },
    { sessionId: 'session-a', kind: 'edit', chars: Infinity },
  ])
    await assert.rejects(queue.append(input as CorrectionInput));
  await assert.rejects(queue.take('session-a', '../outside'), /UUID/);
  await assert.rejects(queue.ack('../outside'), /UUID/);
  await assert.rejects(queue.take('', randomUUID()), /session/);
  assert.equal(errors.length, 9);
  await assert.rejects(stat(root), { code: 'ENOENT' });
  const throwing = new CorrectionQueue(root, () => {
    throw new Error('reporter failed');
  });
  await assert.rejects(throwing.append({ sessionId: '', kind: 'edit' }), /Invalid correction/);
  assert.equal(throwing.warnings.length, 1);
});

test('a summary without exact correction receipts, or a helper/delegation summary, cannot authorize ack', async (t) => {
  const { root, queue } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'edit' });
  const runId = randomUUID();
  const taken = await queue.take('session-a', runId);
  for (const extra of [
    { correctionIds: undefined },
    { correctionIds: ['../outside'] },
    { correctionIds: [taken[0]!.id, taken[0]!.id] },
    { corrections: { edit: 0, recall: 0, retry: 0 } },
    { helper: { kind: 'compaction' } },
    { delegation: { type: 'implementation' } },
  ]) {
    await saveSummary(root, runId, taken, extra);
    await assert.rejects(queue.ack(runId), /persisted correction receipt/);
    assert.deepEqual(await pending(root), [`${taken[0]!.id}.json`]);
  }
  const restarted = new CorrectionQueue(root);
  assert.deepEqual(await restarted.take('session-a', randomUUID()), []);
  assert.equal(restarted.warnings.length, 1);
});

test('append restores private permissions on existing directories', async (t) => {
  const { root, queue } = await fixture(t);
  await queue.append({ sessionId: 'session-a', kind: 'recall' });
  await chmod(root, 0o755);
  await chmod(join(root, 'corrections'), 0o755);
  await queue.append({ sessionId: 'session-a', kind: 'retry' });
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'corrections'))).mode & 0o777, 0o700);
});

test('take bounds a pending scan to 2000 entries and warns when more remain', async (t) => {
  const { root, queue } = await fixture(t);
  const directory = join(root, 'corrections');
  await mkdir(directory, { recursive: true });
  for (let start = 0; start < 2001; start += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, 2001 - start) }, async () => {
        const stored = event({ sessionId: 'session-b' });
        await writeFile(join(directory, `${stored.id}.json`), JSON.stringify(stored), { mode: 0o600 });
      }),
    );
  assert.deepEqual(await queue.take('session-a', randomUUID()), []);
  assert.ok(queue.warnings.some((warning) => warning.includes('2000')));
});

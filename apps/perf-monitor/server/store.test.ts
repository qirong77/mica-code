import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, rename, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelemetryStore, downsample, groupFor, parseCpuMemory, redact, validDay } from './store';
import type { TrendPoint } from '../shared/types';

const roots: string[] = [];
const day = '2020-01-02';
const filename = 'resource-20200102.jsonl';
const processRow = {
  pid: 42,
  pp: 1,
  n: 'bun',
  fp: 120,
  rss: 95,
  fpd: 10,
  cpu: 120,
  th: 9,
  rt: 2,
  fd: 20,
  ni: 0,
  pi: 4,
  imx: 0,
};
const sample = (ts = '2020-01-02T12:00:00', extra = {}) => ({
  ts,
  schema: 2,
  k: 'sample',
  dt: 60,
  sys: { swap_used_mb: 400, swap_total_mb: 1024, pressure: 2, free_mb: 80, uptime_h: 3, load: [4, 5, 6] },
  agg: { count: 300, footprint_mb: 8000, cpu_pct: 200, threads: 2500 },
  procs: [processRow],
  ...extra,
});
const jsonLines = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const memLine = (time: string, gpu = 25) => `${time} MEM swap=500/1024M free=80M compress=100M wired=200M gpu=${gpu}%`;
async function fixture(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'mica-perf-store-'));
  roots.push(root);
  await writeFile(join(root, filename), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { root, store: new TelemetryStore(root) };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('telemetry ingestion', () => {
  test('reads real schema without treating missing metrics as zero', async () => {
    const { store } = await fixture([sample()]);
    const v = await store.view(day, '24h');
    expect(v.latest?.sys.disk).toBeNull();
    expect(v.latest?.sys.swapin_mb_s).toBeNull();
    expect(v.latest?.procs[0].cpu).toBe(120);
    expect(v.sampleCount).toBe(1);
    expect(v.windowStart).toBe(new Date(`${day}T00:00:00`).getTime());
    expect(v.windowEnd).toBe(new Date(`${day}T12:00:00`).getTime());
    expect(await store.days()).toEqual([day]);
  });
  test('preserves schema 2 I/O and keeps older CPU and I/O unknown', async () => {
    const { store } = await fixture([
      sample('2020-01-02T12:00:00', { schema: 1 }),
      sample('2020-01-02T12:01:00', { procs: [{ ...processRow, read_mb_s: 3.5, write_mb_s: 1.25 }] }),
    ]);
    const v = await store.view(day, '24h');
    expect(v.history.map((p) => p.processCpu)).toEqual([null, 200]);
    expect(v.latest?.procs[0].readMBs).toBe(3.5);
    expect(v.latest?.procs[0].writeMBs).toBe(1.25);
    const p = await store.process(day, 42);
    expect(p?.history.map((r) => r.cpu)).toEqual([null, 120]);
  });
  test('does not consume partial appended lines; counts corrupt completed lines', async () => {
    const { root, store } = await fixture([sample()]);
    const line = JSON.stringify(sample('2020-01-02T12:01:00'));
    await appendFile(join(root, filename), 'bad json\n' + line.slice(0, 90));
    const a = await store.view(day, '24h');
    expect(a.sampleCount).toBe(1);
    expect(a.parseErrors).toBe(1);
    await appendFile(join(root, filename), line.slice(90) + '\n');
    Reflect.set(store, 'lastRefresh', 0);
    const b = await store.view(day, '24h');
    expect(b.sampleCount).toBe(2);
    expect(b.parseErrors).toBe(1);
  });
  test('rotation does not duplicate history or lose older shards', async () => {
    const { root, store } = await fixture([sample()]);
    await store.refresh();
    await rename(join(root, filename), join(root, filename + '.1'));
    await writeFile(join(root, filename), JSON.stringify(sample('2020-01-02T12:01:00')) + '\n');
    Reflect.set(store, 'lastRefresh', 0);
    const v = await store.view(day, '24h');
    expect(v.sampleCount).toBe(2);
    expect(v.latest?.ts).toBe(new Date('2020-01-02T12:01:00').toISOString());
  });
  test('registry identifies applications and isolates reused PID generations', async () => {
    const { root, store } = await fixture([sample(), sample('2020-01-02T12:02:00')]);
    await writeFile(
      join(root, 'registry-20200102.jsonl'),
      [
        {
          ts: '2020-01-02T11:59:00',
          pid: 42,
          pp: 1,
          start: 1,
          name: 'bun',
          argv: '/bin/bun mica app-server --token=do-not-show',
        },
        { ts: '2020-01-02T12:01:00', pid: 42, pp: 1, start: 2, name: 'bun', argv: '/bin/bun another-script' },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n') + '\n',
    );
    const first = await store.process(day, 42, '42:1');
    expect(first?.process.group).toBe('Mica');
    expect(first?.history.length).toBe(1);
    expect(first?.command).not.toContain('do-not-show');
    const second = await store.process(day, 42, '42:2');
    expect(second?.history.length).toBe(1);
    const current = await store.process(day, 42);
    expect(current?.process.identity).toBe('42:2');
    expect(current?.history).toEqual(second?.history);
  });
  test('merges rotated registry shards without crossing PID generations or losing old references', async () => {
    const { root, store } = await fixture([sample()]);
    const registry = join(root, 'registry-20200102.jsonl');
    await writeFile(
      registry,
      jsonLines([
        { ts: `${day}T11:58:00`, pid: 1, name: 'launchd', start: 10 },
        {
          ts: `${day}T11:59:00`,
          pid: 42,
          start: 1,
          name: 'bun',
          argv: '/bin/bun mica --token="fake value with spaces"',
        },
      ]),
    );
    expect((await store.process(day, 42, '42:1'))?.command).toBe('/bin/bun mica --token=[REDACTED]');
    await rename(registry, registry + '.1');
    await writeFile(
      registry,
      jsonLines([{ ts: `${day}T12:01:00`, pid: 42, start: 2, name: 'bun', argv: '/bin/bun second-generation' }]),
    );
    await appendFile(
      join(root, filename),
      jsonLines([sample(`${day}T12:02:00`, { procs: [{ ...processRow, start: 1 }] }), sample(`${day}T12:04:00`)]),
    );
    const old = await store.process(day, 42, '42:1');
    expect(old?.history).toHaveLength(2);
    expect(old?.process.group).toBe('Mica');
    expect(old?.parent?.name).toBe('launchd');
    expect(old?.command).toContain('/bin/bun mica');
    expect(old?.command).not.toContain('fake value');
    const current = await store.process(day, 42);
    expect(current?.process.identity).toBe('42:2');
    expect(current?.history.map((r) => r.ts)).toEqual([Date.parse(`${day}T12:04:00`)]);
    expect(current?.command).toBe('/bin/bun second-generation');
    await rename(registry + '.1', registry + '.2');
    await rename(registry, registry + '.1');
    await writeFile(
      registry,
      jsonLines([{ ts: `${day}T12:05:00`, pid: 42, start: 3, name: 'bun', argv: '/bin/bun third-generation' }]),
    );
    await appendFile(join(root, filename), jsonLines([sample(`${day}T12:06:00`)]));
    expect((await store.process(day, 42))?.process.identity).toBe('42:3');
    const preserved = await store.process(day, 42, '42:1');
    expect(preserved?.history).toEqual(old?.history);
    expect(preserved?.command).toBe(old?.command);
    expect((await store.process(day, 42, '42:2'))?.history).toHaveLength(1);
    const shards = Reflect.get(store, 'registries') as Map<string, { ino: number; offset: number }>;
    expect(shards.size).toBe(3);
    expect(new Set([...shards.values()].map((s) => s.ino)).size).toBe(3);
    expect([...shards.values()].every((s) => s.offset > 0)).toBe(true);
  });
  test('default process history selects the latest generation by timestamp across shards', async () => {
    const { root, store } = await fixture([sample(`${day}T12:04:00`, { procs: [{ ...processRow, start: 2 }] })]);
    await writeFile(
      join(root, filename + '.1'),
      jsonLines([
        sample(`${day}T12:00:00`, { procs: [{ ...processRow, start: 1 }] }),
        sample(`${day}T12:03:00`, { procs: [{ ...processRow, start: 2 }] }),
      ]),
    );
    const p = await store.process(day, 42);
    expect(p?.process.identity).toBe('42:2');
    expect(p?.history.map((r) => r.ts)).toEqual([Date.parse(`${day}T12:03:00`), Date.parse(`${day}T12:04:00`)]);
    expect((await store.process(day, 42, '42:1'))?.history).toHaveLength(1);
  });
  test('process rotation preserves old samples and incremental rows in separate files', async () => {
    const { root, store } = await fixture([sample()]);
    expect((await store.process(day, 42))?.history).toHaveLength(1);
    await rename(join(root, filename), join(root, filename + '.1'));
    await writeFile(join(root, filename), jsonLines([sample(`${day}T12:01:00`)]));
    expect((await store.process(day, 42))?.history).toHaveLength(2);
    await appendFile(join(root, filename + '.1'), jsonLines([sample(`${day}T11:59:00`)]));
    const p = await store.process(day, 42);
    expect(p?.history.map((r) => r.ts)).toEqual(
      ['11:59:00', '12:00:00', '12:01:00'].map((t) => Date.parse(`${day}T${t}`)),
    );
    expect(await store.process(day, 42)).toBe(p);
  });
  test('keeps legacy MEM data inside collection gaps and uses the freshest source for latest', async () => {
    const { root, store } = await fixture([sample(), sample(`${day}T12:20:00`)]);
    await writeFile(
      join(root, 'cpu-20200102.log'),
      [
        memLine('12:01:00', 33),
        memLine('12:05:00'),
        memLine('12:18:29'),
        memLine('12:18:30', 77),
        memLine('12:24:00'),
      ].join('\n') + '\n',
    );
    const v = await store.view(day, '24h');
    expect(v.history.map((p) => p.ts)).toEqual(
      ['12:00:00', '12:05:00', '12:18:29', '12:20:00', '12:24:00'].map((t) => Date.parse(`${day}T${t}`)),
    );
    expect(v.history[0].gpuPct).toBe(33);
    expect(v.history[3].gpuPct).toBe(77);
    expect(v.history[1].swapMb).toBe(500);
    expect(v.history[1].processCpu).toBeNull();
    expect(v.latest?.source).toBe('cpu-text');
    expect(v.latest?.epoch).toBe(Date.parse(`${day}T12:24:00`));
    expect(v.latestOverallAt).toBe(new Date(`${day}T12:20:00`).toISOString());
  });
  test('keeps the last structured collector timestamp when newer days contain only legacy data', async () => {
    const { root, store } = await fixture([sample()]);
    for (let i = 3; i <= 12; i++)
      await writeFile(join(root, `cpu-202001${String(i).padStart(2, '0')}.log`), memLine('12:00:00') + '\n');
    const v = await store.view('2020-01-12', '24h');
    expect(v.latest?.source).toBe('cpu-text');
    expect(v.latestOverallAt).toBe(new Date(`${day}T12:00:00`).toISOString());
    expect((await store.view('2020-01-03', '24h')).sampleCount).toBe(1);
  });
  test('loads advertised old days and historical 7d windows while releasing old day caches', async () => {
    const { root, store } = await fixture([]);
    for (let i = 1; i <= 24; i++) {
      const d = `2020-01-${String(i).padStart(2, '0')}`;
      const suffix = d.replaceAll('-', '');
      await writeFile(join(root, `resource-${suffix}.jsonl`), jsonLines([sample(`${d}T12:00:00`)]));
      await writeFile(join(root, `cpu-${suffix}.log`), memLine('11:59:00') + '\n');
      await writeFile(
        join(root, `registry-${suffix}.jsonl`),
        jsonLines([{ ts: `${d}T11:00:00`, pid: 42, start: i, argv: 'bun fake-fixture' }]),
      );
    }
    expect(await store.days()).toHaveLength(24);
    const cache = Reflect.get(store, 'files') as Map<string, unknown>;
    const cpuCache = Reflect.get(store, 'cpuFiles') as Map<string, unknown>;
    const registryCache = Reflect.get(store, 'registries') as Map<string, unknown>;
    expect(cache.size).toBe(8);
    const newest = cache.get('resource-20200124.jsonl');
    const old = await store.view('2020-01-05', '24h');
    expect(old.sampleCount).toBe(1);
    expect(old.latest?.epoch).toBe(Date.parse('2020-01-05T12:00:00'));
    const historical = await store.view('2020-01-09', '7d');
    expect(historical.sampleCount).toBe(8);
    expect(historical.windowStart).toBe(Date.parse('2020-01-02T12:00:00'));
    expect(historical.windowEnd).toBe(Date.parse('2020-01-09T12:00:00'));
    expect(historical.latestOverallAt).toBe(new Date('2020-01-24T12:00:00').toISOString());
    expect(cache.size).toBe(16);
    expect(cache.has('resource-20200101.jsonl')).toBe(false);
    await store.view('2020-01-16', '7d');
    expect(cache.size).toBe(16);
    expect(cpuCache.size).toBe(16);
    expect(registryCache.size).toBe(16);
    expect(cache.has('resource-20200102.jsonl')).toBe(false);
    expect(cpuCache.has('cpu-20200102.log')).toBe(false);
    expect(registryCache.has('registry-20200102.jsonl')).toBe(false);
    expect(cache.get('resource-20200124.jsonl')).toBe(newest);
    Reflect.set(store, 'lastRefresh', 0);
    await store.view('2020-01-16', '7d');
    expect(cache.get('resource-20200124.jsonl')).toBe(newest);
    expect(cache.size).toBe(16);
  });
  test('shares process flights and parses only appended complete records until a source is replaced', async () => {
    const { root, store } = await fixture([sample()]);
    const firstFlight = store.process(day, 42);
    expect(store.process(day, 42)).toBe(firstFlight);
    const first = await firstFlight;
    expect(await store.process(day, 42)).toBe(first);
    const cache = Reflect.get(store, 'processQueries');
    const query = cache.get(JSON.stringify([day, 42, null]));
    const file = query.files.get(filename);
    const observation = file.rows[0];
    const offset = file.offset;
    await appendFile(join(root, filename), jsonLines([sample(`${day}T12:01:00`)]));
    expect((await store.process(day, 42))?.history).toHaveLength(2);
    expect(file.offset).toBeGreaterThan(offset);
    expect(file.rows[0]).toBe(observation);
    const line = JSON.stringify(sample(`${day}T12:02:00`));
    const completeOffset = file.offset;
    await appendFile(join(root, filename), line.slice(0, 100));
    expect((await store.process(day, 42))?.history).toHaveLength(2);
    expect(file.offset).toBe(completeOffset);
    await appendFile(join(root, filename), line.slice(100) + '\n');
    expect((await store.process(day, 42))?.history).toHaveLength(3);
    expect(file.rows[0]).toBe(observation);
    await writeFile(join(root, filename), jsonLines([sample(`${day}T12:03:00`)]));
    expect((await store.process(day, 42))?.history.map((r) => r.ts)).toEqual([Date.parse(`${day}T12:03:00`)]);
    await writeFile(join(root, filename), jsonLines([sample(`${day}T12:04:00`)]));
    await utimes(join(root, filename), new Date(), new Date(Date.now() + 10000));
    expect((await store.process(day, 42))?.history.map((r) => r.ts)).toEqual([Date.parse(`${day}T12:04:00`)]);
    await writeFile(join(root, 'replacement'), jsonLines([sample(`${day}T12:05:00`)]));
    await rename(join(root, 'replacement'), join(root, filename));
    expect((await store.process(day, 42))?.history.map((r) => r.ts)).toEqual([Date.parse(`${day}T12:05:00`)]);
  });
  test('registry updates invalidate cached results without reparsing samples, and process LRU stays bounded', async () => {
    const { root, store } = await fixture([sample()]);
    const registry = join(root, 'registry-20200102.jsonl');
    await writeFile(registry, '');
    const before = await store.process(day, 42);
    const cache = Reflect.get(store, 'processQueries');
    const key = JSON.stringify([day, 42, null]);
    const file = cache.get(key).files.get(filename);
    const observation = file.rows[0];
    await appendFile(
      registry,
      jsonLines([{ ts: `${day}T11:59:00`, pid: 42, start: 7, argv: 'bun mica GITHUB_TOKEN="fake spaced credential"' }]),
    );
    const after = await store.process(day, 42);
    expect(after).not.toBe(before);
    expect(after?.process.identity).toBe('42:7');
    expect(after?.command).toBe('bun mica GITHUB_TOKEN=[REDACTED]');
    expect(file.rows[0]).toBe(observation);
    expect(file.rows).toHaveLength(1);
    for (let pid = 100; pid < 108; pid++) expect(await store.process(day, pid)).toBeNull();
    expect(cache.size).toBe(8);
    expect(cache.has(key)).toBe(false);
    await store.process(day, 100);
    await store.process(day, 108);
    expect(cache.size).toBe(8);
    expect(cache.has(JSON.stringify([day, 100, null]))).toBe(true);
    expect(cache.has(JSON.stringify([day, 101, null]))).toBe(false);
  });
  test('excludes startup CPU and annotates reboot and sampling gaps', async () => {
    const { store } = await fixture([sample(), sample('2020-01-02T12:08:00', { dt: 0.1, sys: { uptime_h: 0.1 } })]);
    const v = await store.view(day, '24h');
    expect(v.latest?.procs[0].cpu).toBeNull();
    expect(v.history[1].reboot).toBe(true);
    expect(v.history[1].gap).toBe(true);
  });
  test('artifact reader rejects traversal and symlinks leaving incident directory; caps preview', async () => {
    const { root, store } = await fixture([]);
    await mkdir(join(root, 'incidents'));
    const id = '20200102-120000';
    const name = `${id}.lsof-42.log`;
    await writeFile(join(root, 'incidents', name), 'x'.repeat(300000));
    const a = await store.artifact(id, name);
    expect(a?.truncated).toBe(true);
    expect(a?.content.length).toBe(256 * 1024);
    expect(await store.artifact(id, '../secret')).toBeNull();
    await symlink(join(root, filename), join(root, 'incidents', `${id}.escape.log`));
    expect(await store.artifact(id, `${id}.escape.log`)).toBeNull();
  });
});

test('peak-preserving thinning retains brief I/O spikes and reboot markers', () => {
  const rows = Array.from(
    { length: 1500 },
    (_, i) => ({ ts: i, swapOut: i === 693 ? 120 : 0, reboot: i === 411, gap: false }) as TrendPoint,
  );
  const out = downsample(rows, 200);
  expect(out.some((r) => r.swapOut === 120)).toBe(true);
  expect(out.some((r) => r.reboot)).toBe(true);
  expect(out.length).toBeLessThan(rows.length);
});
test('validates calendar days and redacts credentials', () => {
  expect(validDay('2026-02-30')).toBe(false);
  expect(validDay('2026-11-06')).toBe(true);
  expect(validDay('../secret')).toBe(false);
  expect(redact('node --password secret --api-key=secret2')).toBe('node --password [REDACTED] --api-key=[REDACTED]');
});

test('redacts bearer credentials, spaced quoted values, environment keys and GitHub token formats using fake fixtures', () => {
  const fixtures = [
    [
      'curl -H "Authorization: Bearer fake-bearer-credential" --verbose',
      'curl -H "Authorization: [REDACTED]" --verbose',
    ],
    [
      'Authorization: Bearer fake-bearer-credential\nAccept: application/json',
      'Authorization: [REDACTED]\nAccept: application/json',
    ],
    ["Authorization: Bearer 'fake quoted credential'", 'Authorization: [REDACTED]'],
    ['{"Authorization": "Bearer fake credential with spaces"}', '{"Authorization": [REDACTED]}'],
    ['bun --token="fake token with spaces" --mode safe', 'bun --token=[REDACTED] --mode safe'],
    ["bun --token 'fake token with spaces' --mode safe", 'bun --token [REDACTED] --mode safe'],
    [
      'GITHUB_TOKEN="fake github value" AWS_SECRET_ACCESS_KEY=fake-aws-value OPENAI_API_KEY=fake-openai-value',
      'GITHUB_TOKEN=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] OPENAI_API_KEY=[REDACTED]',
    ],
    ['{"CLIENT_SECRET":"fake secret with spaces"}', '{"CLIENT_SECRET":[REDACTED]}'],
    ['https://fake-user:fake-password@example.test/path', 'https://[REDACTED]@example.test/path'],
  ];
  for (const [input, expected] of fixtures) expect(redact(input)).toBe(expected);
  for (const prefix of ['ghp_', 'github_pat_', 'sk-', 'xoxb-']) {
    const fakeToken = prefix + 'FAKE_FIXTURE_ONLY_'.repeat(3);
    expect(redact(`unlabelled ${fakeToken} end`)).toBe('unlabelled [REDACTED] end');
  }
});

test('imports legacy pre-reboot MEM lines without inventing PID or byte-rate data', () => {
  const s = parseCpuMemory(
    '10:29:59  MEM swap=12391/13312M(93%) free=86M compress=7435M wired=3188M swapin=229/s(3.6MB/s) swapout=167/s gpu=57%(mem=764M)',
    day,
  );
  expect(s?.sys.swap_used_mb).toBe(12391);
  expect(s?.sys.swapin_mb_s).toBe(3.6);
  expect(s?.sys.swapout_mb_s).toBeNull();
  expect(s?.sys.pressure).toBeNull();
  expect(s?.source).toBe('cpu-text');
  expect(s?.procs).toEqual([]);
});

test('keeps a fresh process snapshot when independent MEM is only a few seconds newer', async () => {
  const { root, store } = await fixture([sample()]);
  await writeFile(join(root, 'cpu-20200102.log'), '12:00:30  MEM swap=500/1024M(49%) free=70M\n');
  const v = await store.view(day, '24h');
  expect(v.latest?.source).toBe('resource');
  expect(v.latest?.procs.length).toBe(1);
});

test('incident selection uses the same requested time window and does not include future days', async () => {
  const { root, store } = await fixture([sample()]);
  await mkdir(join(root, 'incidents'));
  for (const id of ['20200102-115959', '20200102-120001', '20200103-120001']) {
    await writeFile(join(root, 'incidents', `${id}.json`), JSON.stringify({ reason: 'pressure=2', system: {} }));
  }
  const rows = await store.incidents(undefined, {
    start: Date.parse(`${day}T12:00:00`),
    end: Date.parse(`${day}T13:00:00`),
  });
  expect(rows.map((r) => r.id)).toEqual(['20200102-120001']);
});

test('Chromium flags inside another application do not classify its helpers as Chrome', () => {
  expect(
    groupFor('D-Chat', '/Applications/D-Chat.app/Contents/Frameworks/Chromium Embedded Framework --type=renderer'),
  ).toBe('D-Chat');
  expect(groupFor('Google', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('Chrome');
});

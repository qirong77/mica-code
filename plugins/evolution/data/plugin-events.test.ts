import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { DATA_MIGRATIONS } from './index.js';
import { pluginEventIdentity } from './plugin-events.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mica-plugin-events-migration-'));
  homes.push(home);
  const root = join(home, 'plugin-data', 'harness-review');
  mkdirSync(root, { recursive: true });
  return { home, root, file: join(root, 'plugin-events.jsonl') };
}
const legacy = {
  at: '2026-11-17T00:00:00Z',
  pluginId: 'memory',
  taskId: 'curator',
  tick: 8,
  failures: 3,
  error: 'old failure',
};

it('registers v2 migration, preserves known identities, and archives both original streams once', () => {
  const { home, root, file } = fixture();
  const identified = {
    ...legacy,
    pluginVersion: '1.2.3',
    pid: 12345,
    generation: 'known-generation',
    extra: 'preserved',
  };
  const original = `${JSON.stringify(legacy)}\r\n${JSON.stringify(identified)}`;
  const rotated = `${JSON.stringify(legacy)}\n`;
  writeFileSync(file, original, { mode: 0o644 });
  writeFileSync(join(root, 'plugin-events.1.jsonl'), rotated);
  // This is deliberately not an identity source for historical events.
  mkdirSync(join(home, 'plugin-status'), { recursive: true });
  writeFileSync(join(home, 'plugin-status', 'memory.json'), '{"version":"CURRENT"}');
  expect(DATA_MIGRATIONS).toContain(pluginEventIdentity);
  expect(pluginEventIdentity.run({ home, log() {} })).toBe(3);
  const rows = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows[0]).toEqual({ ...legacy, schemaVersion: 2, pluginVersion: 'unknown', pid: null, generation: 'unknown' });
  expect(rows[1]).toEqual({ ...identified, schemaVersion: 2 });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const archive = join(home, 'plugin-data', 'evolution', 'legacy-plugin-events');
  const names = readdirSync(archive);
  expect(names).toHaveLength(2);
  expect(names.map((name) => readFileSync(join(archive, name), 'utf8')).sort()).toEqual([original, rotated].sort());
  for (const name of names) expect(statSync(join(archive, name)).mode & 0o777).toBe(0o600);
  expect(pluginEventIdentity.run({ home, log() {} })).toBe(0);
  expect(readdirSync(archive)).toEqual(names);
});

it('replaces invalid or missing historical identity with explicit unknowns, without guessing', () => {
  const { home, file } = fixture();
  writeFileSync(
    file,
    JSON.stringify({ ...legacy, pluginVersion: 'not a version', pid: 0, generation: 'bad\ngeneration' }),
  );
  expect(pluginEventIdentity.run({ home, log() {} })).toBe(1);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
    schemaVersion: 2,
    pluginVersion: 'unknown',
    pid: null,
    generation: 'unknown',
  });
});

it('defers both files while the live writer lock is held and rereads latest bytes on retry', () => {
  const { home, root, file } = fixture();
  const original = JSON.stringify(legacy);
  writeFileSync(file, original);
  writeFileSync(join(root, 'plugin-events.1.jsonl'), original);
  const release = acquireProcessLock(join(root, 'plugin-events.lock'))!;
  try {
    expect(pluginEventIdentity.run({ home, log() {} })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    const latest = { ...legacy, schemaVersion: 2, pluginVersion: '2', pid: 23456, generation: 'new' };
    writeFileSync(file, JSON.stringify(latest));
    writeFileSync(join(root, 'plugin-events.1.jsonl'), JSON.stringify(latest));
  } finally {
    release();
  }
  expect(pluginEventIdentity.run({ home, log() {} })).toBe(0);
  expect(JSON.parse(readFileSync(file, 'utf8')).generation).toBe('new');
  expect(existsSync(join(home, 'plugin-data', 'evolution'))).toBe(false);
});

it.each(['{broken', JSON.stringify({ ...legacy, schemaVersion: 3 }), JSON.stringify({ ...legacy, failures: null })])(
  'leaves the entire contiguous stream intact when a line is unsupported: %s',
  (bad) => {
    const { home, file } = fixture();
    const original = `${JSON.stringify(legacy)}\n${bad}\n${JSON.stringify(legacy)}\n`;
    writeFileSync(file, original);
    expect(pluginEventIdentity.run({ home, log() {} })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(join(home, 'plugin-data', 'evolution'))).toBe(false);
  },
);

it('bounds files and lines and never follows a stream symlink', () => {
  const { home, root, file } = fixture();
  writeFileSync(file, '');
  truncateSync(file, 8 * 1024 * 1024 + 1);
  expect(pluginEventIdentity.run({ home, log() {} })).toBe(0);
  expect(statSync(file).size).toBe(8 * 1024 * 1024 + 1);
  const oversized = JSON.stringify({ ...legacy, error: 'x'.repeat(64 * 1024) });
  writeFileSync(file, oversized);
  expect(pluginEventIdentity.run({ home, log() {} })).toBe(0);
  expect(readFileSync(file, 'utf8')).toBe(oversized);
  rmSync(file);
  const target = join(root, 'private-target');
  const original = JSON.stringify(legacy);
  writeFileSync(target, original);
  symlinkSync(target, file);
  expect(pluginEventIdentity.run({ home, log() {} })).toBe(0);
  expect(readFileSync(target, 'utf8')).toBe(original);
});

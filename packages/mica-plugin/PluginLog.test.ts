import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginLogger, pluginLogPath } from './PluginLog.js';

const tempDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MICA_PLUGIN_LOG;
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function mkTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-plugin-log-'));
  tempDirectories.push(directory);
  return directory;
}

describe('createPluginLogger', () => {
  it('writes one JSONL line per event into the given directory', () => {
    const dir = mkTempDir();
    const logger = createPluginLogger('session-rename', undefined, { dir });

    logger.info('session-rename:request', { entries: 2 });
    logger.warn('session-rename:failed', { error: 'boom' });

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^plugin-session-rename-\d{8}\.jsonl$/);

    const lines = readFileSync(join(dir, files[0]!), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      plugin: 'session-rename',
      level: 'info',
      event: 'session-rename:request',
      data: { entries: 2 },
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ level: 'warn', event: 'session-rename:failed' });
  });

  it('still forwards to the host logger', () => {
    const warn = vi.fn();
    const logger = createPluginLogger('demo', { warn }, { dir: mkTempDir() });

    logger.warn('demo:event', { a: 1 });

    expect(warn).toHaveBeenCalledWith('demo:event', { a: 1 });
  });

  it('honours MICA_PLUGIN_LOG=0 without dropping the forward', () => {
    const dir = mkTempDir();
    const info = vi.fn();
    const logger = createPluginLogger('demo', { info }, { dir });
    process.env.MICA_PLUGIN_LOG = '0';

    logger.info('demo:event');

    expect(readdirSync(dir)).toEqual([]);
    expect(info).toHaveBeenCalledOnce();
  });

  it('never throws when the directory is not writable', () => {
    const logger = createPluginLogger('demo', undefined, { dir: '/dev/null/not-a-dir' });
    expect(() => logger.error('demo:event')).not.toThrow();
  });

  it('prunes files older than the retention window', () => {
    const dir = mkTempDir();
    const stale = join(dir, 'plugin-demo-20200101.jsonl');
    writeFileSync(stale, '{}\n');
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(stale, old, old);

    createPluginLogger('demo', undefined, { dir }).info('demo:event');

    expect(readdirSync(dir)).not.toContain('plugin-demo-20200101.jsonl');
  });
});

describe('pluginLogPath', () => {
  it('returns the latest existing log across days when today has no log', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12));
    const dir = mkTempDir();
    writeFileSync(join(dir, 'plugin-demo-20261116-10.jsonl'), '{}\n');
    const latest = join(dir, 'plugin-demo-20261117.jsonl');
    writeFileSync(latest, '{}\n');

    expect(pluginLogPath('demo', { dir })).toBe(latest);
  });

  it('returns today’s existing log instead of an older day’s shard', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12));
    const dir = mkTempDir();
    writeFileSync(join(dir, 'plugin-user.my-plugin-20261117-10.jsonl'), '{}\n');
    const latest = join(dir, 'plugin-user.my-plugin-20261118.jsonl');
    writeFileSync(latest, '{}\n');

    expect(pluginLogPath('user.my-plugin', { dir })).toBe(latest);
  });

  it('sorts shards numerically so shard 10 follows shard 2', () => {
    const dir = mkTempDir();
    for (const shard of ['', '-1', '-2', '-10']) {
      writeFileSync(join(dir, `plugin-demo-20261118${shard}.jsonl`), '{}\n');
    }

    expect(pluginLogPath('demo', { dir })).toBe(join(dir, 'plugin-demo-20261118-10.jsonl'));
  });

  it('returns a full existing shard rather than a nonexistent next write path', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 18, 12));
    const dir = mkTempDir();
    const latest = join(dir, 'plugin-demo-20261118.jsonl');
    writeFileSync(latest, 'x'.repeat(2 * 1024 * 1024));

    expect(pluginLogPath('demo', { dir })).toBe(latest);
    expect(readdirSync(dir)).toEqual(['plugin-demo-20261118.jsonl']);
  });

  it('ignores other plugins, non-files, and malformed names', () => {
    const dir = mkTempDir();
    const latest = join(dir, 'plugin-demo-20261118.jsonl');
    writeFileSync(latest, '{}\n');
    for (const name of [
      'plugin-other-20261119.jsonl',
      'plugin-demo-extra-20261119.jsonl',
      'plugin-demo-20261119-0.jsonl',
      'plugin-demo-20261119-02.jsonl',
      'plugin-demo-20261119-x.jsonl',
      'plugin-demo-20261119-9007199254740992.jsonl',
      'plugin-demo-20261119.jsonl.bak',
      'plugin-demo-2026111.jsonl',
      'plugin-demo-20261301.jsonl',
      'plugin-demo-20260230.jsonl',
    ])
      writeFileSync(join(dir, name), '{}\n');
    mkdirSync(join(dir, 'plugin-demo-20261120.jsonl'));
    symlinkSync(latest, join(dir, 'plugin-demo-20261121.jsonl'));

    expect(pluginLogPath('demo', { dir })).toBe(latest);
  });

  it('returns the existing directory without creating an empty log', () => {
    const dir = mkTempDir();

    expect(pluginLogPath('demo', { dir })).toBe(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('creates a missing log directory without creating an empty log', () => {
    const dir = join(mkTempDir(), 'logs');

    expect(pluginLogPath('demo', { dir })).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

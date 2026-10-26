import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginLogger, pluginLogPath } from './PluginLog.js';

const tempDirectories: string[] = [];

afterEach(() => {
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
  it('describes today’s file before anything was written', () => {
    const path = pluginLogPath('user.my-plugin', { dir: mkTempDir() });
    expect(path).toMatch(/plugin-user\.my-plugin-\d{8}\.jsonl$/);
  });
});

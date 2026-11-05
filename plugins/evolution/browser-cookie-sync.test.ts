import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { browserCookieSyncExtension } from './data/browser-cookie-sync.js';
import { DATA_MIGRATIONS } from './data/index.js';

const homes: string[] = [];

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'mica-evolution-cookie-'));
  homes.push(root);
  return root;
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf-8');
}

function run(root: string): number {
  return browserCookieSyncExtension.run({ home: root, log: () => {} });
}

function files(root: string) {
  const data = join(root, 'plugin-data', 'browser-cookie-sync');
  return {
    settings: join(root, 'plugin-settings', 'browser-cookie-sync.json'),
    state: join(data, 'state.json'),
    status: join(data, 'data.json'),
    data,
  };
}

afterEach(() => {
  for (const root of homes.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('browser-cookie-sync extension migration', () => {
  it('is registered with the non-session migrations', () => {
    expect(DATA_MIGRATIONS).toContain(browserCookieSyncExtension);
  });

  it('archives v1 files byte-for-byte without deleting settings and is idempotent', () => {
    const root = home();
    const { settings, state, status } = files(root);
    const originals = [
      [
        settings,
        '{\n  "browser": "chrome", "profile": "Default", "toMica": "true", "toChrome": "false", "writeWhileRunning": "false", "everyMinutes": "5", "custom": "keep"\n}\n',
      ],
      [state, '{ "lastRun": { "at": 123 }, "custom": [1, 2] }\n'],
      [
        status,
        '{ "lastRun": "yesterday", "counts": "4", "access": "ready", "attention": { "text": "old" }, "target": "Chrome / Default" }\n',
      ],
    ] as const;
    for (const [file, content] of originals) write(file, content);

    expect(run(root)).toBe(3);
    for (const [file, content] of originals) {
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(file.replace(/\.json$/, '.legacy-v1.json'), 'utf-8')).toBe(content);
    }
    expect(run(root)).toBe(0);
  });

  it.each(['browser', 'profile', 'toMica', 'toChrome', 'writeWhileRunning', 'everyMinutes'])(
    'recognizes a partial v1 settings file containing %s',
    (key) => {
      const root = home();
      const { settings } = files(root);
      write(settings, JSON.stringify({ [key]: 'old value' }));
      expect(run(root)).toBe(1);
      expect(existsSync(settings.replace(/\.json$/, '.legacy-v1.json'))).toBe(true);
      expect(run(root)).toBe(0);
    },
  );

  it('preserves new connection data, token, extension and unknown files while archiving old state', () => {
    const root = home();
    const { settings, state, status, data } = files(root);
    const untouched = [
      [settings, '{ "futureSetting": "keep" }\n'],
      [status, '{ "target": { "text": "connected", "tone": "ok" } }\n'],
      [join(data, 'token'), 'new-service-token'],
      [join(data, 'extension-v2', 'manifest.json'), '{ "version": "2.0.0" }'],
      [join(data, 'service.json'), '{ "port": 19387 }'],
    ] as const;
    for (const [file, content] of untouched) write(file, content);
    write(state, '{ "lastRun": 123 }');

    expect(run(root)).toBe(1);
    for (const [file, content] of untouched) expect(readFileSync(file, 'utf-8')).toBe(content);
    expect(run(root)).toBe(0);
  });

  it('preserves new connection data and unknown fields mixed with legacy status', () => {
    const root = home();
    const { status, data } = files(root);
    const target = { text: 'connected', tone: 'ok' };
    const original = JSON.stringify({ target, lastRun: 'old run', access: 'old access', future: 2 });
    write(status, original);

    expect(run(root)).toBe(1);
    expect(JSON.parse(readFileSync(status, 'utf-8'))).toEqual({ target, future: 2 });
    expect(readFileSync(join(data, 'data.legacy-v1.json'), 'utf-8')).toBe(original);
    expect(run(root)).toBe(0);
  });

  it('archives a target-only v1 profile string, not a v2 connection object', () => {
    const root = home();
    const { status, data } = files(root);
    write(status, '{ "target": "Chrome / Default" }');
    expect(run(root)).toBe(1);
    expect(existsSync(status)).toBe(false);
    expect(readFileSync(join(data, 'data.legacy-v1.json'), 'utf-8')).toBe('{ "target": "Chrome / Default" }');
    expect(run(root)).toBe(0);
  });

  it.each(['{broken', 'null', '[]', '"text"', '{}'])('does not change corrupt or unrecognized files: %s', (content) => {
    const root = home();
    const { settings, state, status } = files(root);
    for (const file of [settings, state, status]) write(file, content);
    expect(run(root)).toBe(0);
    for (const file of [settings, state, status]) expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  it('does not overwrite existing archives', () => {
    const root = home();
    const { status, data } = files(root);
    write(join(data, 'data.legacy-v1.json'), 'first archive');
    write(join(data, 'data.legacy-v1.1.json'), 'second archive');
    write(status, '{ "counts": "old counts" }\n');

    expect(run(root)).toBe(1);
    expect(readFileSync(join(data, 'data.legacy-v1.json'), 'utf-8')).toBe('first archive');
    expect(readFileSync(join(data, 'data.legacy-v1.1.json'), 'utf-8')).toBe('second archive');
    expect(readFileSync(join(data, 'data.legacy-v1.2.json'), 'utf-8')).toBe('{ "counts": "old counts" }\n');
    expect(run(root)).toBe(0);
  });

  it('still migrates recognized files when another file is corrupt', () => {
    const root = home();
    const { settings, state, status } = files(root);
    write(settings, '{broken');
    write(state, '{ "target": "old profile" }');
    write(status, '{ "target": { "text": "connected" } }');
    expect(run(root)).toBe(1);
    expect(readFileSync(settings, 'utf-8')).toBe('{broken');
    expect(readFileSync(status, 'utf-8')).toBe('{ "target": { "text": "connected" } }');
  });

  it('does not create directories when there are no legacy files', () => {
    const root = home();
    expect(run(root)).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });
});

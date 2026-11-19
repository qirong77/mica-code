import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { readPluginHealth } from '@packages/mica-plugin/PluginHealth.js';
import { DATA_MIGRATIONS } from './index.js';
import { pluginHealthIssues } from './plugin-health.js';
import { pluginHealthRuntimeHistory } from './plugin-health-runtime.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mica-health-runtime-history-'));
  homes.push(home);
  const root = join(home, 'plugin-health');
  mkdirSync(root);
  return { home, root };
}
const report = { issueKey: 'runtime', level: 'error', message: 'historical failure', at: '2026-11-17', version: '1' };
const explicit = { issueKey: 'llm:degraded', level: 'warn', message: 'still degraded', at: '2026-11-18', version: '1' };

it('archives only superseded runtime slots, preserving every independent issue and unknown metadata', () => {
  const { home, root } = fixture();
  const ids = [
    'memory',
    'web-search',
    'mobile-relay',
    'video',
    'computer-use',
    'reply-digest',
    'session-rename',
    'session-compact',
    'session-tags',
    'todo',
    'browser-cookie-sync',
    'evolution',
  ];
  const original = JSON.stringify({
    schemaVersion: 2,
    issues: { runtime: report, 'llm:degraded': explicit },
    extra: { kept: true },
  });
  for (const id of ids) writeFileSync(join(root, `${id}.json`), original, { mode: 0o644 });
  expect(DATA_MIGRATIONS).toContain(pluginHealthRuntimeHistory);
  expect(DATA_MIGRATIONS.indexOf(pluginHealthRuntimeHistory)).toBeGreaterThan(
    DATA_MIGRATIONS.indexOf(pluginHealthIssues),
  );
  expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(ids.length);
  for (const id of ids) {
    expect(JSON.parse(readFileSync(join(root, `${id}.json`), 'utf8'))).toEqual({
      schemaVersion: 2,
      issues: { 'llm:degraded': explicit },
      extra: { kept: true },
    });
    expect(readPluginHealth(id, { configDir: home, issueKey: 'runtime' })).toBeNull();
    expect(readPluginHealth(id, { configDir: home })?.level).toBe('warn');
    expect(statSync(join(root, `${id}.json`)).mode & 0o777).toBe(0o600);
  }
  const archive = join(home, 'plugin-data', 'evolution', 'legacy-plugin-health-runtime');
  const names = readdirSync(archive);
  expect(names).toHaveLength(ids.length);
  for (const name of names) {
    expect(readFileSync(join(archive, name), 'utf8')).toBe(original);
    expect(statSync(join(archive, name)).mode & 0o777).toBe(0o600);
  }
  expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(0);
  expect(readdirSync(archive)).toEqual(names);
});

it('archives recognized official manager slots, never arbitrary business or user-plugin health', () => {
  const { home, root } = fixture();
  const cases = [
    ['ssh', '钩子 turn:after 执行失败：old', true],
    ['schedule', '常驻任务 tick 失败：old', true],
    ['subagent', 'skill 未注册：old', true],
    ['commit', 'skill 目录：old', true],
    ['connections', 'legitimate runtime business report', false],
    ['user-plugin', '钩子 turn:after 执行失败：old', false],
  ] as const;
  for (const [id, message] of cases)
    writeFileSync(
      join(root, `${id}.json`),
      JSON.stringify({ schemaVersion: 2, issues: { runtime: { ...report, message } } }),
    );
  expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(4);
  for (const [id, message, removed] of cases) {
    const runtime = JSON.parse(readFileSync(join(root, `${id}.json`), 'utf8')).issues.runtime;
    expect(runtime).toEqual(removed ? undefined : { ...report, message });
  }
});

it('converts a legacy single report first, then leaves unknown history instead of a fabricated recovery', () => {
  const { home, root } = fixture();
  const path = join(root, 'video.json');
  const original = JSON.stringify({ level: 'error', message: 'ffmpeg unavailable', at: 'old', version: '1' });
  writeFileSync(path, original);
  expect(pluginHealthIssues.run({ home, log() {} })).toBe(1);
  expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(1);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 2, issues: {} });
  expect(readPluginHealth('video', { configDir: home })).toBeNull();
  expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(0);
});

it('defers active writers and only reads the latest locked document on retry', () => {
  const { home, root } = fixture();
  const path = join(root, 'memory.json');
  const original = JSON.stringify({ schemaVersion: 2, issues: { runtime: report } });
  writeFileSync(path, original);
  const release = acquireProcessLock(`${path}.lock`)!;
  const latest = JSON.stringify({ schemaVersion: 2, issues: { 'llm:degraded': explicit } });
  try {
    expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(original);
    writeFileSync(path, latest);
  } finally {
    release();
  }
  expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(latest);
  expect(existsSync(join(home, 'plugin-data', 'evolution'))).toBe(false);
});

it('does not rewrite corrupt, future, or non-runtime health shapes', () => {
  const { home, root } = fixture();
  const values = [
    '{broken',
    JSON.stringify({ schemaVersion: 3, issues: { runtime: report } }),
    JSON.stringify({ schemaVersion: 2, issues: { runtime: { ...report, issueKey: 'other' } } }),
  ];
  for (const [index, id] of ['video', 'memory', 'todo'].entries())
    writeFileSync(join(root, `${id}.json`), values[index]!);
  expect(pluginHealthRuntimeHistory.run({ home, log() {} })).toBe(0);
  for (const [index, id] of ['video', 'memory', 'todo'].entries())
    expect(readFileSync(join(root, `${id}.json`), 'utf8')).toBe(values[index]);
});

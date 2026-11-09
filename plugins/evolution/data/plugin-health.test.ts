import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clearPluginHealth, readPluginHealth, writePluginHealth } from '@packages/mica-plugin/PluginHealth.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { pluginStartupHealth } from './plugin-health.js';
import { DATA_MIGRATIONS } from './index.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mica-health-migration-'));
  homes.push(home);
  mkdirSync(join(home, 'plugin-health'));
  return home;
}

it('archives only legacy setup errors, preserving runtime health and all original bytes', () => {
  const home = fixture();
  const original = JSON.stringify({
    level: 'error',
    message: '启动失败：ctx.tools missing',
    version: '1.0.0',
    at: 'old',
  });
  const root = join(home, 'plugin-health');
  writeFileSync(join(root, 'harness-review.json'), original);
  writeFileSync(join(root, 'runtime.json'), '{"level":"error","message":"钩子 turn:after 执行失败：error"}');
  writeFileSync(join(root, 'ok.json'), '{"level":"ok","message":"working"}');
  writeFileSync(join(root, 'broken.json'), '{broken');
  expect(DATA_MIGRATIONS).toContain(pluginStartupHealth);
  expect(pluginStartupHealth.run({ home, log() {} })).toBe(1);
  expect(existsSync(join(root, 'harness-review.json'))).toBe(false);
  const archive = join(home, 'plugin-data', 'evolution', 'legacy-plugin-health');
  expect(readFileSync(join(archive, readdirSync(archive)[0]!), 'utf8')).toBe(original);
  for (const name of ['runtime', 'ok', 'broken']) expect(existsSync(join(root, `${name}.json`))).toBe(true);
  expect(pluginStartupHealth.run({ home, log() {} })).toBe(0);
});

it('defers a file with an active writer instead of removing its newer health', () => {
  const home = fixture();
  const file = join(home, 'plugin-health', 'video.json');
  writeFileSync(file, '{"level":"error","message":"启动失败：old"}');
  const release = acquireProcessLock(`${file}.lock`)!;
  try {
    expect(pluginStartupHealth.run({ home, log() {} })).toBe(0);
    writeFileSync(file, '{"level":"error","message":"runtime failure"}');
  } finally {
    release();
  }
  expect(pluginStartupHealth.run({ home, log() {} })).toBe(0);
});

it('keeps the latest runtime health update when migration acquired the lock first', async () => {
  const home = fixture();
  const file = join(home, 'plugin-health', 'video.json');
  writeFileSync(file, '{"level":"error","message":"启动失败：old"}');
  const release = acquireProcessLock(`${file}.lock`)!;
  try {
    writePluginHealth('video', { level: 'warn', message: 'first' }, { configDir: home });
    writePluginHealth('video', { level: 'error', message: 'latest runtime failure' }, { configDir: home });
  } finally {
    release();
  }
  await vi.waitFor(() =>
    expect(readPluginHealth('video', { configDir: home })?.message).toBe('latest runtime failure'),
  );
  expect(pluginStartupHealth.run({ home, log() {} })).toBe(0);

  const releaseAgain = acquireProcessLock(`${file}.lock`)!;
  try {
    writePluginHealth('video', { level: 'error', message: 'queued failure' }, { configDir: home });
    clearPluginHealth('video', { configDir: home });
  } finally {
    releaseAgain();
  }
  await vi.waitFor(() => expect(readPluginHealth('video', { configDir: home })).toBeNull());
});

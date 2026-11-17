import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createPluginHealthStore } from './PluginHealth.js';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';

it('keeps independent dependency failures when a normal operation succeeds or clears', () => {
  const store = createPluginHealthStore('issues', { configDir: process.env.MICA_HOME, version: '1' });
  store.report({ issueKey: 'llm:degraded', level: 'warn', message: 'fallback' });
  store.report({ level: 'error', message: 'business failed' });
  expect(store.read()?.message).toBe('business failed');
  store.report({ level: 'ok', message: 'business done' });
  expect(store.read()?.message).toBe('fallback');
  store.clear();
  expect(store.read()?.message).toBe('fallback');
  store.report({ issueKey: 'llm:degraded', level: 'ok', message: 'primary recovered' });
  expect(store.read()?.level).toBe('ok');
});

it('merges pending issues after another writer releases the lock', async () => {
  const store = createPluginHealthStore('pending-issues', { configDir: process.env.MICA_HOME });
  const release = acquireProcessLock(`${store.path!}.lock`)!;
  try {
    store.report({ issueKey: 'a', level: 'error', message: 'a' });
    store.report({ issueKey: 'b', level: 'warn', message: 'b' });
  } finally { release(); }
  await vi.waitFor(() => expect(store.read('b')?.message).toBe('b'));
  expect(store.read('a')?.message).toBe('a');
});

it('archives unsupported bytes if a report arrives before Evolution, without parsing legacy state', () => {
  const home = process.env.MICA_HOME!;
  const root = join(home, 'plugin-health');
  mkdirSync(root, { recursive: true });
  const original = '{"level":"warn","message":"old format"}\n';
  writeFileSync(join(root, 'early.json'), original);
  const store = createPluginHealthStore('early', { configDir: home });
  expect(store.read()).toBeNull();
  store.report({ level: 'ok', message: 'current' });
  const archived = readdirSync(join(root, 'archive')).find((name) => name.startsWith('early.json.'))!;
  expect(readFileSync(join(root, 'archive', archived), 'utf8')).toBe(original);
  expect(store.read()?.message).toBe('current');
});

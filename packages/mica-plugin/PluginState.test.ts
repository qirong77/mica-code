import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  normalizePluginState,
  readDisabledPluginIds,
  readPluginState,
  resolvePluginStatePath,
  setPluginDisabled,
  writePluginState,
} from './PluginState.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('plugin state', () => {
  it('treats a missing file as "everything enabled"', () => {
    expect(readPluginState({ path: join(mkTempDir(), 'plugins-state.json') })).toEqual({ disabled: [] });
  });

  it('round-trips disabled ids in sorted order', () => {
    const path = join(mkTempDir(), 'plugins-state.json');

    expect(setPluginDisabled('todo', true, { path })).toEqual({ disabled: ['todo'] });
    expect(setPluginDisabled('user.demo', true, { path })).toEqual({ disabled: ['todo', 'user.demo'] });
    expect(setPluginDisabled('todo', false, { path })).toEqual({ disabled: ['user.demo'] });
    expect(readDisabledPluginIds({ path })).toEqual(new Set(['user.demo']));
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ disabled: ['user.demo'] });
  });

  it('survives a corrupted state file', () => {
    const path = join(mkTempDir(), 'plugins-state.json');
    writeFileSync(path, 'not json');

    expect(readPluginState({ path })).toEqual({ disabled: [] });
    expect(writePluginState({ disabled: ['todo'] }, { path })).toEqual({ disabled: ['todo'] });
    expect(readPluginState({ path })).toEqual({ disabled: ['todo'] });
  });

  it('drops unknown shapes instead of throwing', () => {
    expect(normalizePluginState(null)).toEqual({ disabled: [] });
    expect(normalizePluginState({ disabled: ['a', 2, ' ', 'a'] })).toEqual({ disabled: ['a'] });
  });

  it('resolves the default path under MICA_HOME', () => {
    const previous = process.env.MICA_HOME;
    process.env.MICA_HOME = mkTempDir();
    try {
      expect(resolvePluginStatePath()).toBe(join(process.env.MICA_HOME, 'plugins-state.json'));
    } finally {
      if (previous === undefined) delete process.env.MICA_HOME;
      else process.env.MICA_HOME = previous;
    }
  });
});

function mkTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-plugin-state-'));
  tempDirectories.push(directory);
  return directory;
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPluginSettingsStore,
  readPluginSettings,
  resolvePluginSettingsPath,
  validatePluginSettingValues,
  writePluginSettings,
  type PluginSettingField,
} from './PluginSettings.js';

const tempDirectories: string[] = [];

function mkTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mica-plugin-settings-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fields: PluginSettingField[] = [
  { key: 'baseUrl', label: '接口地址', type: 'text' },
  { key: 'apiKey', label: 'Key', type: 'password' },
  { key: 'minIntervalSeconds', label: '间隔', type: 'number', default: '0' },
];

describe('validatePluginSettingValues', () => {
  it('pattern 不匹配时说 patternMessage，而不是把正则甩给用户', () => {
    const tokenField: PluginSettingField = {
      key: 'token',
      label: '访问口令',
      type: 'password',
      pattern: '^.{16,}$',
      patternMessage: '口令至少 16 位',
    };
    expect(validatePluginSettingValues([tokenField], { token: 'dd' })).toEqual([
      { key: 'token', label: '访问口令', message: '口令至少 16 位' },
    ]);
    expect(validatePluginSettingValues([tokenField], { token: 'a'.repeat(16) })).toEqual([]);
  });

  it('没写 patternMessage 时退回显示正则', () => {
    const field: PluginSettingField = { key: 'code', label: '编号', type: 'text', pattern: '^[0-9]+$' };
    expect(validatePluginSettingValues([field], { code: 'abc' })[0].message).toBe('需要匹配 ^[0-9]+$');
  });
});

describe('readPluginSettings', () => {
  it('falls back to defaults when nothing was saved', () => {
    expect(readPluginSettings('demo', fields, { configDir: mkTempDir() })).toEqual({
      baseUrl: '',
      apiKey: '',
      minIntervalSeconds: '0',
    });
  });

  it('keeps only declared keys and fills missing ones', () => {
    const configDir = mkTempDir();
    const file = resolvePluginSettingsPath('demo', configDir);
    mkdirSync(join(configDir, 'plugin-settings'), { recursive: true });
    writeFileSync(file, JSON.stringify({ baseUrl: 'https://x.test', stray: 'nope' }));

    expect(readPluginSettings('demo', fields, { configDir })).toEqual({
      baseUrl: 'https://x.test',
      apiKey: '',
      minIntervalSeconds: '0',
    });
  });

  it('treats a broken settings file as "all defaults" instead of failing', () => {
    const configDir = mkTempDir();
    mkdirSync(join(configDir, 'plugin-settings'), { recursive: true });
    writeFileSync(resolvePluginSettingsPath('demo', configDir), '{ not json');

    expect(readPluginSettings('demo', fields, { configDir }).baseUrl).toBe('');
  });
});

describe('writePluginSettings', () => {
  it('writes only declared keys', () => {
    const configDir = mkTempDir();

    const saved = writePluginSettings('demo', { baseUrl: 'https://x.test', stray: 'nope' }, fields, { configDir });

    expect(saved).toEqual({ baseUrl: 'https://x.test', apiKey: '', minIntervalSeconds: '0' });
    expect(readPluginSettings('demo', fields, { configDir })).toEqual(saved);
  });

  it('needs a config directory', () => {
    expect(() => writePluginSettings('demo', {}, fields, {})).toThrow('configDir');
  });
});

describe('createPluginSettingsStore', () => {
  it('picks up edits without restarting, but caches between reads', () => {
    const configDir = mkTempDir();
    const store = createPluginSettingsStore('demo', fields, { configDir });

    expect(store.get().baseUrl).toBe('');
    const first = store.get();
    expect(store.get()).toBe(first);

    writePluginSettings('demo', { baseUrl: 'https://changed.test' }, fields, { configDir });
    expect(store.get().baseUrl).toBe('https://changed.test');
  });

  it('reports no path when there is no config directory', () => {
    const store = createPluginSettingsStore('demo', fields);
    expect(store.path).toBeNull();
    expect(store.get()).toEqual({ baseUrl: '', apiKey: '', minIntervalSeconds: '0' });
  });
});

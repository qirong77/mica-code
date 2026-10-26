import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PluginSettingsValidationError,
  readPluginSettings,
  validatePluginSettingValues,
  writePluginSettings,
  type PluginSettingField,
} from './PluginSettings.js';

const fields: PluginSettingField[] = [
  { key: 'baseUrl', label: 'baseUrl', type: 'text', format: 'url' },
  { key: 'apiKey', label: 'apiKey', type: 'password' },
  { key: 'protocol', label: 'protocol', type: 'select', options: [{ value: 'chat', label: 'Chat' }], default: 'chat' },
  { key: 'maxMessages', label: 'maxMessages', type: 'number', default: '12', min: 1, max: 50 },
  { key: 'model', label: 'model', type: 'text', required: true },
];

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'mica-plugin-settings-'));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('validatePluginSettingValues', () => {
  it('accepts a complete configuration', () => {
    expect(
      validatePluginSettingValues(fields, {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
        protocol: 'chat',
        maxMessages: '12',
        model: 'gpt-4o-mini',
      }),
    ).toEqual([]);
  });

  it('reports a missing required field', () => {
    expect(validatePluginSettingValues(fields, { model: '  ' })).toEqual([
      { key: 'model', label: 'model', message: '不能为空' },
    ]);
  });

  it('rejects a value that is not a usable URL', () => {
    expect(validatePluginSettingValues(fields, { model: 'm', baseUrl: 'api.example.com' })).toEqual([
      { key: 'baseUrl', label: 'baseUrl', message: '需要是完整的 URL，例如 https://api.openai.com/v1' },
    ]);
    expect(validatePluginSettingValues(fields, { model: 'm', baseUrl: 'ftp://x' })).toEqual([
      { key: 'baseUrl', label: 'baseUrl', message: '只支持 http/https' },
    ]);
  });

  it('enforces numeric bounds instead of silently coercing', () => {
    expect(validatePluginSettingValues(fields, { model: 'm', maxMessages: 'abc' })).toEqual([
      { key: 'maxMessages', label: 'maxMessages', message: '必须是数字' },
    ]);
    expect(validatePluginSettingValues(fields, { model: 'm', maxMessages: '0' })).toEqual([
      { key: 'maxMessages', label: 'maxMessages', message: '不能小于 1' },
    ]);
    expect(validatePluginSettingValues(fields, { model: 'm', maxMessages: '999' })).toEqual([
      { key: 'maxMessages', label: 'maxMessages', message: '不能大于 50' },
    ]);
  });

  it('rejects a select value outside its options', () => {
    expect(validatePluginSettingValues(fields, { model: 'm', protocol: 'responses' })).toEqual([
      { key: 'protocol', label: 'protocol', message: '只能是 chat' },
    ]);
  });

  it('treats an empty optional field as "use the default behaviour"', () => {
    expect(validatePluginSettingValues(fields, { model: 'm', baseUrl: '', apiKey: '' })).toEqual([]);
  });
});

describe('writePluginSettings', () => {
  it('refuses to persist an invalid configuration and says which field is wrong', () => {
    expect(() => writePluginSettings('demo', { model: '' }, fields, { configDir })).toThrow(
      PluginSettingsValidationError,
    );
    try {
      writePluginSettings('demo', { model: '', baseUrl: 'nope' }, fields, { configDir });
    } catch (error) {
      const issues = (error as PluginSettingsValidationError).issues;
      expect(issues.map((issue) => issue.key).sort()).toEqual(['baseUrl', 'model']);
      // 文案要能被页面解析回逐字段提示：首行摘要，之后每行 `key: 原因`。
      expect((error as Error).message.split('\n')[0]).toContain('设置不合法');
      expect((error as Error).message).toContain('baseUrl: ');
    }
  });

  it('writes only declared keys once the configuration is valid', () => {
    writePluginSettings('demo', { model: 'm', unknown: 'dropped' }, fields, { configDir });
    const stored = JSON.parse(readFileSync(join(configDir, 'plugin-settings', 'demo.json'), 'utf-8'));
    expect(stored).toMatchObject({ model: 'm', protocol: 'chat', maxMessages: '12' });
    expect(stored.unknown).toBeUndefined();
  });
});

describe('readPluginSettings', () => {
  it('fills defaults for missing values', () => {
    expect(readPluginSettings('demo', fields, { configDir })).toMatchObject({ protocol: 'chat', maxMessages: '12' });
  });

  it('keeps a hand-edited bad value so the page can point at it', () => {
    writePluginSettings('demo', { model: 'm' }, fields, { configDir });
    const file = join(configDir, 'plugin-settings', 'demo.json');
    const stored = JSON.parse(readFileSync(file, 'utf-8'));
    // 绕过写入校验，模拟用户直接改文件 / 旧版本留下的无效值。
    writeFileSync(file, JSON.stringify({ ...stored, maxMessages: 'abc' }));
    const values = readPluginSettings('demo', fields, { configDir });
    expect(values.maxMessages).toBe('abc');
    expect(validatePluginSettingValues(fields, values)).toEqual([
      { key: 'maxMessages', label: 'maxMessages', message: '必须是数字' },
    ]);
  });
});

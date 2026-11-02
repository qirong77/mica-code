import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import setupValidateConfig, { migrateLegacySearchSetting, validateConfig } from '../startup/validate-config.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mica-validate-config-'));
  roots.push(root);
  return root;
}

function writeConfig(root: string, extra: Record<string, unknown> = {}): string {
  const path = join(root, 'config.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        providers: [{ id: 'p', api_base: 'https://api.example.test/v1', protocol: 'openai_chat_completions' }],
        ...extra,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  return path;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('default model validation', () => {
  const provider = {
    id: 'p',
    api_base: 'https://api.example.test/v1',
    protocol: 'openai_chat_completions',
    api_key: 'test-key',
    models: ['first', 'second'],
  };

  it('accepts omitted defaults and declared static models with vendor effort names', () => {
    expect(validateConfig({ providers: [provider] }).ok).toBe(true);
    expect(
      validateConfig({
        providers: [provider],
        defaultModel: { provider: 'p', model: 'second', effort: 'vendor-max' },
      }).ok,
    ).toBe(true);
  });

  it.each([
    [null, 'defaultModel'],
    [[], 'defaultModel'],
    ['p/first', 'defaultModel'],
    [{}, 'defaultModel.provider'],
    [{ provider: 'missing', model: 'first' }, 'defaultModel.provider'],
    [{ provider: 'p' }, 'defaultModel.model'],
    [{ provider: 'p', model: 'missing' }, 'defaultModel.model'],
    [{ provider: 'p', model: 'first', effort: 'HIGH!' }, 'defaultModel.effort'],
    [{ provider: 'p', model: 'first', effort: '' }, 'defaultModel.effort'],
    [{ provider: 'p', model: 'first', effort: null }, 'defaultModel.effort'],
    [{ provider: 'p', model: 'first', effort: 1 }, 'defaultModel.effort'],
  ])('rejects invalid defaults %j at %s', (defaultModel, path) => {
    const result = validateConfig({ providers: [provider], defaultModel });
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'error', path }));
  });

  it('requires a model declared by a static provider', () => {
    const { models: _models, ...withoutModels } = provider;
    expect(
      validateConfig({
        providers: [withoutModels],
        defaultModel: { provider: 'p', model: 'first' },
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'default_model_unavailable' }));
  });

  it('allows models outside the static catalog for a dynamic provider', () => {
    expect(
      validateConfig({
        providers: [{ ...provider, get_model_url: 'https://api.example.test/v1/models' }],
        defaultModel: { provider: 'p', model: 'dynamic-model', effort: 'max' },
      }).ok,
    ).toBe(true);
  });
});

describe('legacy search setting migration', () => {
  it('moves config.json searxngUrl into the web-search plugin settings and deletes the dead key', () => {
    const root = makeRoot();
    const configPath = writeConfig(root, { searxngUrl: 'http://search.local:8080' });

    setupValidateConfig({ paths: { config: root } });

    expect(readJson(join(root, 'plugin-settings', 'web-search.json'))).toEqual({
      searxngUrl: 'http://search.local:8080',
    });
    expect(readJson(configPath).searxngUrl).toBeUndefined();
  });

  it('keeps an existing plugin setting and still removes the old config key', () => {
    const root = makeRoot();
    const configPath = writeConfig(root, { searxngUrl: 'http://old:8080' });
    const settingsPath = join(root, 'plugin-settings', 'web-search.json');
    mkdirSync(join(root, 'plugin-settings'), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ searxngUrl: 'http://new:8080' })}\n`, 'utf-8');

    migrateLegacySearchSetting(root, configPath);

    expect(readJson(settingsPath).searxngUrl).toBe('http://new:8080');
    expect(readJson(configPath).searxngUrl).toBeUndefined();
  });

  it('leaves everything alone when there is no legacy value', () => {
    const root = makeRoot();
    const configPath = writeConfig(root);

    migrateLegacySearchSetting(root, configPath);

    expect(readJson(configPath).searxngUrl).toBeUndefined();
    expect(() => readFileSync(join(root, 'plugin-settings', 'web-search.json'))).toThrow();
  });
});

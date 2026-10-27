import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, curatorProviderConfig, expandEnv, settingsFromValues } from './settings.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('settingsFromValues', () => {
  it('falls back to defaults for missing or unparsable values', () => {
    expect(settingsFromValues({})).toMatchObject({
      enabled: DEFAULT_SETTINGS.enabled,
      autoCapture: false,
      curatorMode: 'subagent',
      curatorProtocol: 'openai_chat_completions',
      minIntervalMinutes: 10,
      maxMessages: 30,
    });
    expect(settingsFromValues({ memoryCharLimit: 'abc', minIntervalMinutes: '-5' }).budgets.memory).toBe(2200);
    expect(settingsFromValues({ minIntervalMinutes: '-5' }).minIntervalMinutes).toBe(0);
  });

  it('clamps budgets to the range the settings page can express', () => {
    expect(settingsFromValues({ userCharLimit: '1' }).budgets.user).toBe(200);
    expect(settingsFromValues({ userCharLimit: '999999' }).budgets.user).toBe(20_000);
  });

  it('expands ${VAR} in the curator key so the secret can live in the environment', () => {
    vi.stubEnv('MY_CURATOR_KEY', 'sk-from-env');
    const settings = settingsFromValues({
      curatorMode: 'direct',
      curatorBaseUrl: 'https://api.example.test/v1',
      curatorApiKey: '${MY_CURATOR_KEY}',
      curatorModel: 'cheap-model',
    });

    expect(settings.curatorApiKey).toBe('sk-from-env');
    expect(curatorProviderConfig(settings)).toMatchObject({ apiKey: 'sk-from-env' });
  });

  it('treats a missing environment variable as an unconfigured provider', () => {
    const settings = settingsFromValues({
      curatorMode: 'direct',
      curatorBaseUrl: 'https://api.example.test/v1',
      curatorApiKey: '${NOT_DEFINED_ANYWHERE}',
      curatorModel: 'cheap-model',
    });

    expect(settings.curatorApiKey).toBe('');
    expect(curatorProviderConfig(settings)).toBeNull();
  });

  it('leaves a literal key untouched and reports incomplete config', () => {
    expect(expandEnv('sk-literal')).toBe('sk-literal');
    expect(curatorProviderConfig(settingsFromValues({ curatorBaseUrl: 'https://x.test/v1' }))).toBeNull();
  });
});

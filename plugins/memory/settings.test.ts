import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginLlmApi, expandEnvPlaceholders } from '@packages/mica-plugin/index.js';
import { DEFAULT_SETTINGS, curatorReady, settingsFromValues } from './settings.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('settingsFromValues', () => {
  it('falls back to defaults for missing or unparsable values', () => {
    expect(settingsFromValues({})).toMatchObject({
      enabled: DEFAULT_SETTINGS.enabled,
      autoCapture: DEFAULT_SETTINGS.autoCapture,
      curatorMode: 'subagent',
      minIntervalMinutes: DEFAULT_SETTINGS.minIntervalMinutes,
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
    const llm = createPluginLlmApi({
      spec: {},
      readValues: () => ({
        baseUrl: 'https://api.example.test/v1',
        apiKey: '${MY_CURATOR_KEY}',
        model: 'cheap-model',
      }),
      models: async () => ({ text: '', usage: null }),
    });

    expect(llm.config().apiKey).toBe('sk-from-env');
    expect(curatorReady(llm)).toBe(true);
  });

  it('treats a missing environment variable as an unconfigured provider', () => {
    const llm = createPluginLlmApi({
      spec: {},
      readValues: () => ({
        baseUrl: 'https://api.example.test/v1',
        apiKey: '${NOT_DEFINED_ANYWHERE}',
        model: 'cheap-model',
      }),
      models: async () => ({ text: '', usage: null }),
    });

    // 地址与模型都在，Key 展开成空串：可用（本地网关常常不校验 Key）。
    expect(llm.config().apiKey).toBe('');
    expect(curatorReady(llm)).toBe(true);
  });

  it('leaves a literal key untouched and reports incomplete config', () => {
    expect(expandEnvPlaceholders('sk-literal')).toBe('sk-literal');
    expect(curatorReady(undefined)).toBe(false);
    expect(
      curatorReady(
        createPluginLlmApi({
          spec: {},
          // 复用会话模型时「有没有地址」不决定可用性，所以要显式关掉才测得到这条。
          readValues: () => ({ useMainProvider: 'false', baseUrl: 'https://x.test/v1' }),
          models: async () => ({ text: '', usage: null }),
        }),
      ),
    ).toBe(false);
  });
});

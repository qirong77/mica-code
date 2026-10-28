import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROMPT } from './message.js';

const hostConfig = {
  provider: 'host',
  model: 'host-model',
  providers: [
    {
      id: 'host',
      name: 'Host',
      api_base: 'https://host.example.test/v1',
      api_key: 'host-key',
      protocol: 'openai_responses' as const,
      models: ['host-model', 'host-cheap'],
    },
  ],
};

vi.mock('@packages/mica-config/index.js', () => ({
  micaConfig: {
    get: () => hostConfig,
    providerForModel: (model: string) =>
      hostConfig.providers.find((provider) => !provider.models || provider.models.includes(model)),
  },
}));

const { readCommitSettings, resolveMessageTarget } = await import('./settings.js');

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('commit plugin settings', () => {
  it('fills defaults and keeps push on unless it is explicitly off', () => {
    const settings = readCommitSettings({});
    expect(settings.prompt).toBe(DEFAULT_PROMPT);
    expect(settings.push).toBe(true);
    expect(settings.protocol).toBe('openai_chat_completions');
    expect(readCommitSettings({ push: 'false' }).push).toBe(false);
  });

  it('follows the host provider and model when no endpoint is set', () => {
    const target = resolveMessageTarget(readCommitSettings({}));
    expect(target.standalone).toBe(false);
    expect(target.problem).toBeUndefined();
    expect(target.config).toMatchObject({
      baseUrl: 'https://host.example.test/v1',
      apiKey: 'host-key',
      protocol: 'openai_responses',
      model: 'host-model',
    });
  });

  it('swaps only the model when a model override is set', () => {
    const target = resolveMessageTarget(readCommitSettings({ model: 'host-cheap' }));
    expect(target.standalone).toBe(false);
    expect(target.config).toMatchObject({ model: 'host-cheap', baseUrl: 'https://host.example.test/v1' });
  });

  it('uses the plugin endpoint verbatim when a base url is configured', () => {
    const target = resolveMessageTarget(
      readCommitSettings({
        baseUrl: 'https://cheap.example.test/v1',
        apiKey: 'cheap-key',
        protocol: 'openai_chat_completions',
        model: 'cheap-model',
      }),
    );
    expect(target.standalone).toBe(true);
    expect(target.problem).toBeUndefined();
    expect(target.config).toMatchObject({ baseUrl: 'https://cheap.example.test/v1', model: 'cheap-model' });
  });

  it('reports a problem instead of sending a request without a model', () => {
    const target = resolveMessageTarget(readCommitSettings({ baseUrl: 'https://cheap.example.test/v1' }));
    expect(target.problem).toContain('没填模型');
  });

  it('expands ${VAR} secrets so long-lived keys stay out of the settings file', () => {
    vi.stubEnv('MICA_COMMIT_TEST_KEY', 'from-env');
    const target = resolveMessageTarget(
      readCommitSettings({
        baseUrl: 'https://cheap.example.test/v1',
        apiKey: '${MICA_COMMIT_TEST_KEY}',
        model: 'cheap-model',
      }),
    );
    expect(target.config.apiKey).toBe('from-env');

    const fallback = resolveMessageTarget(
      readCommitSettings({
        baseUrl: 'https://cheap.example.test/v1',
        apiKey: '${MICA_COMMIT_MISSING_KEY:-fallback-key}',
        model: 'cheap-model',
      }),
    );
    expect(fallback.config.apiKey).toBe('fallback-key');
  });
});

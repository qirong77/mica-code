import { describe, expect, it } from 'vitest';
import { validateConfig } from '../startup/validate-config.js';

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

});

import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearModelData,
  setModelData,
  getEffortMapFromConfig,
  getModelContextWindowSizeFromConfig,
  hasOwnEffort,
  DEFAULT_EFFORT_MAP,
} from './index.js';
import {
  getProviderEffortOptions,
  clampProviderEffort,
  resolveChatCompletionsEffortParams,
  resolveResponsesReasoningParams,
} from '../effort.js';
import type { ProviderDefinition } from '../types.js';

const baseProvider: ProviderDefinition = {
  id: 'openai',
  name: 'OpenAI',
  api_base: 'https://api.openai.com/v1',
  api_key: 'test-key',
  protocol: 'openai_chat_completions',
  models: ['gpt-5.5', 'gpt-5.4'],
};

beforeEach(() => {
  clearModelData();
});

describe('setModelData / getModelContextWindowSizeFromConfig', () => {
  it('returns default 256K for models without data', () => {
    expect(getModelContextWindowSizeFromConfig('unknown')).toBe(256000);
  });

  it('returns stored context size for models with data', () => {
    setModelData('test-model', 1000000, null);
    expect(getModelContextWindowSizeFromConfig('test-model')).toBe(1000000);
  });

  it('stores context size in K units (internally in tokens)', () => {
    setModelData('small', 128000, null);
    expect(getModelContextWindowSizeFromConfig('small')).toBe(128000);
  });
});

describe('setModelData / getEffortMapFromConfig', () => {
  it('returns default effort map for models without data', () => {
    expect(getEffortMapFromConfig('unknown')).toEqual(DEFAULT_EFFORT_MAP);
  });

  it('returns stored effort map for models with data', () => {
    setModelData('test-model', 1000000, { none: null, high: 'high', xhigh: 'xhigh' });
    expect(getEffortMapFromConfig('test-model')).toEqual({ none: null, high: 'high', xhigh: 'xhigh' });
  });

  it('returns null when effort is explicitly disabled', () => {
    setModelData('disabled-effort', 1000000, null);
    expect(getEffortMapFromConfig('disabled-effort')).toBeNull();
  });
});

describe('getProviderEffortOptions (effort.ts) with per-model data', () => {
  it('returns empty options when effort is explicitly disabled', () => {
    setModelData('no-effort-model', 256000, null);
    expect(getProviderEffortOptions(baseProvider, 'no-effort-model')).toEqual(['none']);
  });

  it('filters effort options based on per-model effort map', () => {
    setModelData('known-pro-model', 1050000, { medium: 'medium', high: 'high', xhigh: 'xhigh' });
    expect(getProviderEffortOptions(baseProvider, 'known-pro-model')).toEqual(['medium', 'high', 'xhigh']);
  });

  it('returns default options for unknown models', () => {
    expect(getProviderEffortOptions(baseProvider, 'unknown-model')).toEqual(['none', 'low', 'medium', 'high']);
  });
});

describe('clampProviderEffort with per-model data', () => {
  it('clamps effort to nearest available value when current effort is not supported', () => {
    setModelData('deepseek-v4-pro', 1000000, { none: null, high: 'high', xhigh: 'xhigh' });
    const deepseek: ProviderDefinition = {
      id: 'deepseek',
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com',
      protocol: 'openai_chat_completions',
      models: ['deepseek-v4-pro'],
    };
    expect(clampProviderEffort(deepseek, 'low', 'deepseek-v4-pro')).toBe('high');
  });
});

describe('resolveChatCompletionsEffortParams with per-model data', () => {
  it('resolves params when effort exists in map', () => {
    setModelData('reasoning-model', 1000000, { none: null, high: 'high', xhigh: 'xhigh' });
    expect(resolveChatCompletionsEffortParams(baseProvider, 'xhigh', 'reasoning-model')).toEqual({
      reasoning_effort: 'xhigh',
    });
  });

  it('uses the same OpenAI params for every compatible provider', () => {
    setModelData('deepseek-model', 1000000, { none: null, high: 'high', xhigh: 'xhigh' });
    const deepseek: ProviderDefinition = {
      id: 'deepseek',
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com',
      protocol: 'openai_chat_completions',
      models: ['deepseek-model'],
    };
    expect(resolveChatCompletionsEffortParams(deepseek, 'xhigh', 'deepseek-model')).toEqual({
      reasoning_effort: 'xhigh',
    });
  });
});

describe('resolveResponsesReasoningParams with per-model data', () => {
  it('resolves params when effort exists in map', () => {
    setModelData('reasoning-model', 1000000, { none: null, high: 'high', xhigh: 'xhigh' });
    expect(resolveResponsesReasoningParams(baseProvider, 'xhigh', 'reasoning-model')).toEqual({
      reasoning: { effort: 'xhigh' },
    });
  });

  it('returns empty for unknown models with unsupported effort', () => {
    expect(resolveResponsesReasoningParams(baseProvider, 'xhigh', 'unknown-model')).toEqual({});
  });
});

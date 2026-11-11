import { describe, expect, it, vi } from 'vitest';
import { resolveEffortParams } from './effort.js';
import { ensureModelRule, getModelEffortOptions, getModelRule, normalizeModelEffort } from './getModelRule.js';
import type { ProviderDefinition } from './types.js';

const anthropic: ProviderDefinition = {
  id: 'native',
  api_base: 'https://api.anthropic.com',
  protocol: 'anthropic_messages',
};
const google: ProviderDefinition = {
  id: 'native',
  api_base: 'https://generativelanguage.googleapis.com/v1beta',
  protocol: 'google_generative_ai',
};

const params = (provider: ProviderDefinition, model: string, effort: string) =>
  resolveEffortParams({ provider, model, effort, protocol: provider.protocol });

describe('Pi native model effort rules', () => {
  it('resolves bundled native metadata without requesting models.dev or credentials', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const rule = await ensureModelRule('claude-opus-4-6', undefined, anthropic);
      expect(rule.contextSize).toBeGreaterThan(0);
      expect(rule.supportsVision).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('uses native Anthropic effort values, keeping max and xhigh distinct', () => {
    expect(getModelEffortOptions('claude-opus-4-6', anthropic.protocol, anthropic)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(getModelEffortOptions('claude-opus-4-7', anthropic.protocol, anthropic)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(params(anthropic, 'claude-opus-4-6', 'max')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'max' },
    });
    expect(params(anthropic, 'claude-opus-4-7', 'xhigh')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
    });
    expect(params(anthropic, 'claude-opus-4-6', 'xhigh')).toEqual({});
    expect(params(anthropic, 'claude-opus-4-6', 'minimal')).toEqual({});
    expect(params(anthropic, 'claude-opus-4-6', 'none')).toEqual({ thinking: { type: 'disabled' } });
    expect(normalizeModelEffort('claude-opus-4-6', 'xhigh', anthropic)).toBe('medium');
  });

  it('uses the Google SDK payload wrapper and filters unsupported native levels', () => {
    expect(getModelEffortOptions('gemini-3-flash-preview', google.protocol, google)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(getModelEffortOptions('gemini-3.1-pro-preview', google.protocol, google)).toEqual(['low', 'medium', 'high']);
    expect(params(google, 'gemini-3-flash-preview', 'minimal')).toEqual({
      config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'MINIMAL' } },
    });
    expect(params(google, 'gemini-3.1-pro-preview', 'high')).toEqual({
      config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
    });
    expect(params(google, 'gemini-3.1-pro-preview', 'none')).toEqual({});
    expect(params(google, 'gemini-3.1-pro-preview', 'xhigh')).toEqual({});
    expect(params(google, 'gemini-3.1-pro-preview', 'max')).toEqual({});
  });

  it.each([
    [anthropic, 'claude-sonnet-4-5'],
    [google, 'gemini-2.5-flash'],
  ] as const)('does not invent effort presets for budget-based %s %s', (provider, model) => {
    expect(getModelRule(model, provider).efforts).toEqual({});
    expect(getModelEffortOptions(model, provider.protocol, provider)).toEqual([]);
    expect(getModelEffortOptions(model, provider.protocol, { ...provider, effortLevels: ['high'] })).toEqual([]);
    expect(params(provider, model, 'high')).toEqual({});
    expect(params({ ...provider, effortLevels: ['high'] }, model, 'high')).toEqual({});
  });

  it('respects providers that disable native effort', () => {
    expect(params({ ...anthropic, supportsEffort: false }, 'claude-opus-4-6', 'max')).toEqual({});
    expect(params({ ...google, supportsEffort: false }, 'gemini-3-flash-preview', 'high')).toEqual({});
  });

  it('uses native fields for private models with provider-declared levels', () => {
    const declaredAnthropic = { ...anthropic, effortLevels: ['high', 'xhigh', 'max', 'made-up'] };
    const declaredGoogle = { ...google, effortLevels: ['minimal', 'high', 'xhigh', 'max'] };
    expect(params(declaredAnthropic, 'private-model', 'max')).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'max' },
    });
    expect(params(declaredGoogle, 'private-model', 'high')).toEqual({
      config: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' } },
    });
    expect(getModelEffortOptions('private-model', declaredAnthropic.protocol, declaredAnthropic)).toEqual([
      'high',
      'xhigh',
      'max',
    ]);
    expect(getModelEffortOptions('private-model', declaredGoogle.protocol, declaredGoogle)).toEqual([
      'minimal',
      'high',
    ]);
    expect(params(declaredAnthropic, 'private-model', 'made-up')).toEqual({});
    expect(params(declaredGoogle, 'private-model', 'max')).toEqual({});
  });
});

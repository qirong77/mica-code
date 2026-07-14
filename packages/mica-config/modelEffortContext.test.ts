import { afterEach, describe, expect, it, vi } from 'vitest';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { ensureModelRule, getModelEffortOptions, getModelRule, resolveModelRequestPatch } from './getModelRule.js';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.unstubAllGlobals();
});

describe('model-effort-context', () => {
  it('loads context sizes and dynamic effort options on demand', async () => {
    mockModelsDev();
    dispose = setupModelEffortContext();
    await Promise.all(['kimi-k2.6', 'deepseek-v4-pro', 'gpt-5.5', 'grok-4.5'].map(ensureModelRule));

    expect(getModelRule('kimi-k2.6').contextSize).toBe(262144);
    expect(getModelRule('deepseek-v4-pro').contextSize).toBe(1000000);
    expect(getModelRule('gpt-5.5').contextSize).toBe(1050000);
    expect(getModelRule('grok-4.5').contextSize).toBe(500000);
    expect(getModelEffortOptions('deepseek-v4-pro')).toEqual(['none', 'high', 'xhigh']);
    expect(getModelEffortOptions('grok-4.5')).toEqual(['low', 'medium', 'high']);
  });

  it('resolves protocol-specific request patches without provider matching', async () => {
    mockModelsDev();
    dispose = setupModelEffortContext();
    await Promise.all(['kimi-k2.6', 'deepseek-v4-pro', 'gpt-5.5'].map(ensureModelRule));

    expect(resolveModelRequestPatch('kimi-k2.6', 'none', 'openai_chat_completions')).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(resolveModelRequestPatch('deepseek-v4-pro', 'xhigh', 'openai_chat_completions')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(resolveModelRequestPatch('gpt-5.5', 'medium', 'openai_responses')).toEqual({
      reasoning: { effort: 'medium' },
    });
  });
});

function mockModelsDev() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          moonshotai: {
            models: {
              'kimi-k2.6': model(262144, [{ type: 'toggle' }]),
            },
          },
          deepseek: {
            models: {
              'deepseek-v4-pro': model(1000000, [{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }]),
            },
          },
          openai: {
            models: {
              'gpt-5.5': model(1050000, [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'max'] }]),
            },
          },
          xai: {
            models: {
              'grok-4.5': model(500000, [{ type: 'effort', values: ['low', 'medium', 'high'] }]),
            },
          },
        }),
      ),
    ),
  );
}

function model(context: number, reasoning_options: unknown[]) {
  return { reasoning: true, reasoning_options, limit: { context } };
}

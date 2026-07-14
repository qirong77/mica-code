import { afterEach, describe, expect, it } from 'vitest';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { getModelEffortOptions, getModelRule, resolveModelRequestPatch } from './getModelRule.js';

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe('model-effort-context', () => {
  it('registers context sizes and dynamic effort options', () => {
    dispose = setupModelEffortContext();

    expect(getModelRule('kimi-k2.6').contextSize).toBe(262144);
    expect(getModelRule('deepseek-v4-pro').contextSize).toBe(1000000);
    expect(getModelRule('gpt-5.5').contextSize).toBe(1050000);
    expect(getModelRule('grok-4.5').contextSize).toBe(500000);
    expect(getModelEffortOptions('deepseek-v4-pro')).toEqual(['none', 'high', 'xhigh']);
    expect(getModelEffortOptions('grok-4.5')).toEqual(['low', 'medium', 'high']);
  });

  it('resolves protocol-specific request patches without provider matching', () => {
    dispose = setupModelEffortContext();

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

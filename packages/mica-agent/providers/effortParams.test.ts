import { afterEach, describe, expect, it } from 'vitest';
import { micaConfig, type ProviderDefinition, type ProviderProtocol } from '@packages/mica-config/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';

/**
 * 这些断言盯的是「真正发给上游的字段」，而不是中间变量：effort 出问题时几乎都不是
 * 配置没传到，而是到了 client 这里又被规则覆盖成别的值、换成了别名，或者干脆没发出去。
 */
const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function registerRules(rules: Parameters<typeof micaConfig.registerModelRules>[0]) {
  disposers.push(micaConfig.registerModelRules(rules));
}

function provider(protocol: ProviderProtocol, supportsEffort?: boolean): ProviderDefinition {
  return {
    id: 'gateway',
    name: 'gateway',
    api_base: 'http://127.0.0.1:1',
    protocol,
    ...(supportsEffort === undefined ? {} : { supportsEffort }),
  };
}

function chatParams(model: string, effort: string | undefined, supportsEffort?: boolean) {
  const client = new ChatCompletionsClient({
    model,
    effort: effort as never,
    provider: provider('openai_chat_completions', supportsEffort),
  });
  return (client as unknown as { reasoningParams: Record<string, unknown> }).reasoningParams;
}

function responsesParams(model: string, effort: string | undefined, supportsEffort?: boolean) {
  const client = new ResponsesClient({
    model,
    effort: effort as never,
    provider: provider('openai_responses', supportsEffort),
  });
  return (client as unknown as { reasoningParams: Record<string, unknown> }).reasoningParams;
}

/** 声明了 `low/high/max` 的真实档位；模型自己就叫 `max`，不是我们内部的 `xhigh`。 */
const MAX_LEVEL_RULE = {
  contextSize: 200000,
  defaultEffort: 'high',
  efforts: {
    low: {
      openai_chat_completions: { reasoning_effort: 'low' },
      openai_responses: { reasoning: { effort: 'low' } },
    },
    high: {
      openai_chat_completions: { reasoning_effort: 'high' },
      openai_responses: { reasoning: { effort: 'high' } },
    },
    max: {
      openai_chat_completions: { reasoning_effort: 'max' },
      openai_responses: { reasoning: { effort: 'max' } },
    },
  },
};

describe('effort wire params', () => {
  it('never sends reasoning params when the provider opts out, even for a rule with a patch', () => {
    registerRules({ 'max-model': MAX_LEVEL_RULE });

    // 旧实现先查模型补丁、查不到才看 supportsEffort，于是声明关闭的 provider 仍会收到参数。
    expect(chatParams('max-model', 'high', false)).toEqual({});
    expect(responsesParams('max-model', 'high', false)).toEqual({});
  });

  it('sends the level name the model declares, never an alias', () => {
    registerRules({ 'max-model': MAX_LEVEL_RULE });

    // `max` 就是 `max`：不能再折算成 `xhigh`，反向也一样。
    expect(chatParams('max-model', 'max')).toEqual({ reasoning_effort: 'max' });
    expect(responsesParams('max-model', 'max')).toEqual({ reasoning: { effort: 'max', summary: 'auto' } });
    expect(micaConfig.getModelEffortOptions('max-model')).toEqual(['low', 'high', 'max']);
  });

  it('does not send anything for a level the model does not declare', () => {
    registerRules({ 'max-model': MAX_LEVEL_RULE });

    expect(chatParams('max-model', 'xhigh')).toEqual({});
    expect(responsesParams('max-model', 'minimal')).toEqual({});
    expect(chatParams('max-model', undefined)).toEqual({});
  });

  it('keeps the responses summary request only when reasoning is actually sent', () => {
    registerRules({
      'responses-only-model': {
        contextSize: 400000,
        defaultEffort: 'medium',
        efforts: {
          medium: { openai_responses: { reasoning: { effort: 'medium' } } },
        },
      },
    });

    expect(responsesParams('responses-only-model', 'medium')).toEqual({
      reasoning: { effort: 'medium', summary: 'auto' },
    });
    expect(chatParams('responses-only-model', 'medium')).toEqual({});
  });
});

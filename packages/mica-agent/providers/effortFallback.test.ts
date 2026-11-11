import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { micaConfig } from '@packages/mica-config/index.js';
import { isUnsupportedReasoningError } from './effortFallback.js';

/**
 * 真实报错（krill 的 codex 网关，gpt-6.1-terra）：models.dev 声明该模型有 `none` 这一档，
 * 但这台服务端只认 low…max。压缩摘要子代理默认就是 `none`，于是整轮压缩失败。
 */
function effortRejected(level = 'none'): Error {
  return Object.assign(
    new Error(
      `400 Unsupported value: '${level}' is not supported with the 'gpt-6.1-terra' model. ` +
        "Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'.",
    ),
    { status: 400 },
  );
}

let disposers: Array<() => void> = [];

beforeEach(() => {
  disposers.push(
    micaConfig.registerModelRules({
      'krill-effort::gpt-6.1-terra': {
        contextSize: 1050000,
        defaultEffort: 'medium',
        supportsVision: true,
        efforts: {
          none: { openai_responses: { reasoning: { effort: 'none' } } },
          medium: { openai_responses: { reasoning: { effort: 'medium' } } },
          high: { openai_responses: { reasoning: { effort: 'high' } } },
        },
      },
      'test::gpt-6.1-terra': {
        contextSize: 1050000,
        defaultEffort: 'medium',
        supportsVision: true,
        efforts: {
          none: { openai_chat_completions: { reasoning_effort: 'none' } },
          medium: { openai_chat_completions: { reasoning_effort: 'medium' } },
        },
      },
    }),
  );
});

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
  disposers = [];
  micaConfig.resetRejectedEffortLevels();
  vi.spyOn(console, 'error').mockRestore();
});

describe('unsupported effort fallback', () => {
  it('recognizes the gateway rejection and leaves unrelated 400s alone', () => {
    expect(isUnsupportedReasoningError(effortRejected(), { reasoning: { effort: 'none' } })).toBe(true);
    // 同一条消息但不是 4xx：不是档位问题，别掩盖真实故障。
    expect(
      isUnsupportedReasoningError(Object.assign(effortRejected(), { status: 500 }), {
        reasoning: { effort: 'none' },
      }),
    ).toBe(false);
    // 请求里根本没带推理参数：任何报错都与档位无关。
    expect(isUnsupportedReasoningError(effortRejected(), {})).toBe(false);
    // 报错指向的是别的字段（不是我们发出去的那一档）。
    expect(
      isUnsupportedReasoningError(
        Object.assign(new Error("400 Unsupported value: 'auto' is not supported for tool_choice"), { status: 400 }),
        { reasoning: { effort: 'none' } },
      ),
    ).toBe(false);
  });

  it('stops offering and sending a level the server rejected', () => {
    const provider = {
      id: 'krill-effort',
      api_base: 'https://example.com/v1',
      protocol: 'openai_responses' as const,
    };
    const levels = () => micaConfig.getModelEffortOptions('gpt-6.1-terra', 'openai_responses', provider);

    expect(levels()).toContain('none');
    micaConfig.markEffortLevelRejected(provider, 'gpt-6.1-terra', 'none');

    // 界面不能再列一个发了也不会生效的档位。
    expect(levels()).not.toContain('none');
    expect(levels()).toContain('medium');
    expect(
      micaConfig.resolveEffortParams({
        provider,
        model: 'gpt-6.1-terra',
        effort: 'none',
        protocol: 'openai_responses',
      }),
    ).toEqual({});
    expect(
      micaConfig.resolveEffortParams({
        provider,
        model: 'gpt-6.1-terra',
        effort: 'high',
        protocol: 'openai_responses',
      }),
    ).toEqual({ reasoning: { effort: 'high' } });
  });
});

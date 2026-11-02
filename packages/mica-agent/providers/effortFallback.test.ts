import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { micaConfig, type ProviderProtocol } from '@packages/mica-config/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import { isUnsupportedReasoningError } from './effortFallback.js';
import type { ModelClientOptions } from './types.js';

const openaiMocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responsesCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  OpenAI: class MockOpenAI {
    chat = { completions: { create: openaiMocks.chatCreate } };
    responses = { create: openaiMocks.responsesCreate };
  },
}));

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
  openaiMocks.chatCreate.mockReset();
  openaiMocks.responsesCreate.mockReset();
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

  it('Responses drops the reasoning params and retries once, then remembers the level', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    openaiMocks.responsesCreate
      .mockRejectedValueOnce(effortRejected())
      .mockImplementation(() => Promise.resolve(responsesStream('ok')));

    const client = new ResponsesClient(options('openai_responses', 'krill-effort', 'none'));
    await expect(client.query('hello')).resolves.toBe('ok');

    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(2);
    expect(openaiMocks.responsesCreate.mock.calls[0]?.[0]).toMatchObject({ reasoning: { effort: 'none' } });
    // 第二次真的不带推理参数，而不是换个档位偷偷发。
    expect(Object.keys(openaiMocks.responsesCreate.mock.calls[1]?.[0] ?? {})).not.toContain('reasoning');

    // 压缩摘要每次都新建客户端：靠 mica-config 记住的拒绝记录，下一次直接不发。
    openaiMocks.responsesCreate.mockClear();
    openaiMocks.responsesCreate.mockImplementation(() => Promise.resolve(responsesStream('again')));
    const next = new ResponsesClient(options('openai_responses', 'krill-effort', 'none'));
    await expect(next.query('hello')).resolves.toBe('again');

    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
    expect(Object.keys(openaiMocks.responsesCreate.mock.calls[0]?.[0] ?? {})).not.toContain('reasoning');
  });

  it('Chat Completions drops reasoning_effort and retries once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    openaiMocks.chatCreate
      .mockRejectedValueOnce(effortRejected())
      .mockImplementation(() => Promise.resolve(chatStream('ok')));

    const client = new ChatCompletionsClient(options('openai_chat_completions', 'test', 'none'));
    await expect(client.query('hello')).resolves.toBe('ok');

    expect(openaiMocks.chatCreate).toHaveBeenCalledTimes(2);
    expect(openaiMocks.chatCreate.mock.calls[0]?.[0]).toMatchObject({ reasoning_effort: 'none' });
    expect(Object.keys(openaiMocks.chatCreate.mock.calls[1]?.[0] ?? {})).not.toContain('reasoning_effort');
  });

  it('keeps a single attempt when the model accepts the level', async () => {
    openaiMocks.responsesCreate.mockImplementation(() => Promise.resolve(responsesStream('ok')));

    const client = new ResponsesClient(options('openai_responses', 'krill-effort', 'medium'));
    await expect(client.query('hello')).resolves.toBe('ok');

    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
    expect(openaiMocks.responsesCreate.mock.calls[0]?.[0]).toMatchObject({
      reasoning: { effort: 'medium', summary: 'auto' },
    });
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

function options(protocol: ProviderProtocol, providerId: string, effort: string): ModelClientOptions {
  return {
    model: 'gpt-6.1-terra',
    effort: effort as never,
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    provider: {
      id: providerId,
      api_base: 'https://example.com/v1',
      protocol,
    },
  };
}

async function* responsesStream(text: string): AsyncGenerator<unknown> {
  yield { type: 'response.output_text.delta', delta: text };
  yield {
    type: 'response.completed',
    response: { model: 'gpt-6.1-terra', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  };
}

async function* chatStream(text: string): AsyncGenerator<unknown> {
  yield {
    model: 'gpt-6.1-terra',
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

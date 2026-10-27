import { describe, expect, it, vi } from 'vitest';

let seenSignal: AbortSignal | undefined;

vi.mock('@packages/mica-agent/index.js', () => ({
  micaAgent: {
    createSubAgent: () => ({
      // 永不 resolve：模拟一个还在吐 reasoning 的模型。
      query: (_transcript: string, options?: { signal?: AbortSignal }) => {
        seenSignal = options?.signal;
        return new Promise<string>(() => {});
      },
    }),
  },
}));

const { requestSessionTitle } = await import('./titleRequest.js');

const config = {
  baseUrl: 'https://example.test/v1',
  apiKey: 'k',
  protocol: 'openai_chat_completions' as const,
  model: 'mini',
  prompt: 'p',
};

describe('requestSessionTitle timeout', () => {
  it('aborts the in-flight request instead of leaving it running', async () => {
    await expect(requestSessionTitle(config, 'hello', { timeoutMs: 10 })).rejects.toThrow(/超时/);
    expect(seenSignal?.aborted).toBe(true);
  });
});

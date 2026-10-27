import { describe, expect, it, vi } from 'vitest';
import {
  CuratorProviderError,
  requestCuratorCompletion,
  resolveEndpoint,
  type CuratorProviderConfig,
} from './providers.js';

const chatConfig: CuratorProviderConfig = {
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-test',
  protocol: 'openai_chat_completions',
  model: 'gpt-test',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('resolveEndpoint', () => {
  it('appends the protocol path to a base URL', () => {
    expect(resolveEndpoint('https://api.example.test/v1/', 'openai_chat_completions')).toBe(
      'https://api.example.test/v1/chat/completions',
    );
    expect(resolveEndpoint('https://api.example.test/v1', 'openai_responses')).toBe(
      'https://api.example.test/v1/responses',
    );
  });

  it('keeps an address that already points at the endpoint', () => {
    expect(resolveEndpoint('https://api.example.test/v1/chat/completions', 'openai_chat_completions')).toBe(
      'https://api.example.test/v1/chat/completions',
    );
  });

  it('rejects an empty address', () => {
    expect(() => resolveEndpoint('  ', 'openai_chat_completions')).toThrow(CuratorProviderError);
  });
});

describe('requestCuratorCompletion', () => {
  it('sends a chat completions request and returns the message text', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '{"operations":[]}' } }] }));

    const text = await requestCuratorCompletion(
      chatConfig,
      { system: 'system prompt', user: 'user prompt' },
      fetchMock as unknown as typeof fetch,
    );

    expect(text).toBe('{"operations":[]}');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-test',
      stream: false,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user prompt' },
      ],
    });
    // 不带 temperature：推理模型（o 系列 / gpt-5）会直接 400，而整理模型是用户自己配的。
    expect(body).not.toHaveProperty('temperature');
  });

  it('reads content parts from a chat completion', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'part one' }] } }] }),
    );

    await expect(
      requestCuratorCompletion(chatConfig, { system: 's', user: 'u' }, fetchMock as unknown as typeof fetch),
    ).resolves.toBe('part one');
  });

  it('sends a responses request and reads output_text', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ output_text: '{"operations":[]}' }));

    const text = await requestCuratorCompletion(
      { ...chatConfig, protocol: 'openai_responses' },
      { system: 'only JSON', user: 'prompt' },
      fetchMock as unknown as typeof fetch,
    );

    expect(text).toBe('{"operations":[]}');
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-test',
      instructions: 'only JSON',
      input: 'prompt',
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('temperature');
  });

  it('falls back to output content parts when output_text is missing', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        output: [
          {
            content: [
              { type: 'output_text', text: 'line one' },
              { type: 'output_text', text: 'line two' },
            ],
          },
        ],
      }),
    );

    await expect(
      requestCuratorCompletion(
        { ...chatConfig, protocol: 'openai_responses' },
        { system: 's', user: 'u' },
        fetchMock as unknown as typeof fetch,
      ),
    ).resolves.toBe('line one\nline two');
  });

  it('surfaces HTTP failures with status and a truncated body', async () => {
    const fetchMock = vi.fn(async () => new Response('invalid api key', { status: 401 }));

    await expect(
      requestCuratorCompletion(chatConfig, { system: 's', user: 'u' }, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      name: 'CuratorProviderError',
      status: 401,
      message: expect.stringContaining('HTTP 401'),
    });
  });

  it('rejects an empty completion', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '  ' } }] }));

    await expect(
      requestCuratorCompletion(chatConfig, { system: 's', user: 'u' }, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/空内容/);
  });

  it('wraps transport failures without leaking the api key', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });

    await expect(
      requestCuratorCompletion(chatConfig, { system: 's', user: 'u' }, fetchMock as unknown as typeof fetch),
    ).rejects.toMatchObject({
      message: expect.stringContaining('connection refused'),
    });
    await expect(
      requestCuratorCompletion(chatConfig, { system: 's', user: 'u' }, fetchMock as unknown as typeof fetch),
    ).rejects.not.toMatchObject({ message: expect.stringContaining('sk-test') });
  });
});

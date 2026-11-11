import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { micaConfig } from '@packages/mica-config/index.js';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import { PiModelClient } from './PiModelClient.js';

const servers: Server[] = [];
const tools: MicaTool[] = [];
const disposers: Array<() => void> = [];
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
afterEach(async () => {
  for (const tool of tools.splice(0)) micaTools.unregisterRuntime(tool);
  while (disposers.length) disposers.pop()?.();
  micaConfig.resetRejectedEffortLevels();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  vi.restoreAllMocks();
});

describe('real pi SDK over HTTP SSE', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    '%s carries body, thinking, tools, images and replay data into the next request',
    async (protocol) => {
      const executed = vi.fn();
      registerTool(executed);
      const wire = await server((response, index) => {
        if (protocol === 'openai_chat_completions') chat(response, index === 0);
        else if (protocol === 'openai_responses') responses(response, index === 0);
        else anthropic(response, index === 0);
      });
      const client = new PiModelClient({
        model: protocol === 'anthropic_messages' ? 'claude-sonnet-4-5' : 'gpt-4.1',
        provider: {
          id: `wire-${protocol}`,
          protocol,
          api_base: protocol === 'anthropic_messages' ? wire.url.replace(/\/v1$/, '') : wire.url,
        },
        apiKey: 'local-test-key',
        systemPrompt: 'wire system',
        toolFilter: (name) => name === 'wire_probe',
      });
      const body: string[] = [];
      const thinking: string[] = [];
      const input = vi.fn();
      const start = vi.fn();
      const end = vi.fn();
      client.onText = (delta) => body.push(delta);
      client.onThinking = (delta) => thinking.push(delta);
      client.onToolInput = input;
      const answer = await client.query(
        [
          { type: 'text', text: 'inspect' },
          { type: 'image', source: { type: 'base64', data: image, media_type: 'image/png' } },
        ],
        { onRequestStart: start, onRequestEnd: end },
      );
      expect(answer).toBe('before\n\nafter');
      expect(body.join('')).toBe(answer);
      expect(thinking.join('')).toContain('think');
      expect(executed).toHaveBeenCalledExactlyOnceWith({ path: 'a.ts' });
      expect(input.mock.calls.map(([event]) => event.phase)).toEqual(expect.arrayContaining(['start', 'delta', 'end']));
      expect(wire.requests).toHaveLength(2);
      expect(start).toHaveBeenCalledTimes(2);
      expect(end).toHaveBeenCalledTimes(2);
      expect(end.mock.calls.every(([info]) => info.outcome === 'completed')).toBe(true);
      expect(JSON.stringify(wire.requests[0]!.body)).toContain(image);
      expect(client.getSnapshot().messageFormat).toBe('pi-ai-v1');
      expect(client.usageHistory[0]).toMatchObject({
        inputTokens: 20,
        cachedInputTokens: 5,
        outputTokens: 12,
        totalTokens: 32,
      });
      const replay = JSON.stringify(wire.requests[1]!.body);
      expect(replay).toContain('tool text');
      expect(replay).toContain(image);
      if (protocol === 'openai_responses') {
        expect(wire.requests[0]!.path).toBe('/v1/responses');
        expect(replay).toContain('encrypted-reasoning');
        expect(replay).toContain('function_call_output');
        const saved = client.messages.find((m): m is AssistantMessage => m.role === 'assistant');
        expect(saved?.content.find((part) => part.type === 'thinking')).toMatchObject({
          thinkingSignature: expect.stringContaining('encrypted-reasoning'),
        });
      } else if (protocol === 'anthropic_messages') {
        expect(wire.requests[0]!.path.split('?')[0]).toBe('/v1/messages');
        expect(replay).toContain('anthropic-signature');
        expect(replay).toContain('tool_result');
      } else {
        expect(wire.requests[0]!.path).toBe('/v1/chat/completions');
        expect(replay).toContain('"tool_call_id":"call_probe"');
        expect(replay).toContain('think');
      }
    },
  );
});

type Captured = { path: string; body: Record<string, unknown> };
async function server(reply: (response: ServerResponse, index: number) => void) {
  const requests: Captured[] = [];
  const instance = createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    requests.push({ path: request.url ?? '', body: JSON.parse(data) });
    response.setHeader('content-type', 'text/event-stream');
    response.setHeader('cache-control', 'no-cache');
    reply(response, requests.length - 1);
  });
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return { requests, url: `http://127.0.0.1:${address.port}/v1` };
}
function sse(response: ServerResponse, event: Record<string, unknown>, named = false) {
  response.write(`${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
}
function registerTool(executed: ReturnType<typeof vi.fn>) {
  class WireTool extends MicaTool {
    constructor() {
      super(
        'wire_probe',
        'read a test file',
        { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        { readOnly: true },
      );
    }
    async execute(args: Record<string, unknown>) {
      executed(args);
      return [
        { type: 'text' as const, text: 'tool text' },
        { type: 'image' as const, source: { type: 'base64' as const, data: image, media_type: 'image/png' as const } },
      ];
    }
    onToolUseDisplayText() {
      return 'wire probe';
    }
  }
  const tool = new WireTool();
  tools.push(tool);
  micaTools.registerRuntime(tool);
}

function chat(response: ServerResponse, withTool: boolean) {
  const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null, usage?: unknown) =>
    sse(response, {
      id: 'chatcmpl_wire',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-4.1',
      choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    });
  if (withTool) {
    chunk({ role: 'assistant', reasoning_content: 'think' });
    chunk({ content: 'before' });
    chunk({
      tool_calls: [
        { index: 0, id: 'call_probe', type: 'function', function: { name: 'wire_probe', arguments: '{"path":' } },
      ],
    });
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] });
  } else chunk({ content: 'after' });
  chunk({}, withTool ? 'tool_calls' : 'stop', {
    prompt_tokens: 20,
    completion_tokens: 12,
    total_tokens: 32,
    prompt_tokens_details: { cached_tokens: 5 },
    completion_tokens_details: { reasoning_tokens: 7 },
  });
  response.end('data: [DONE]\n\n');
}
function responses(response: ServerResponse, withTool: boolean) {
  const event = (type: string, extra: Record<string, unknown>) => sse(response, { type, ...extra }, true);
  event('response.created', { response: { id: 'resp_wire', status: 'in_progress' } });
  const reasoning = {
    type: 'reasoning',
    id: 'rs_wire',
    summary: [{ type: 'summary_text', text: 'think' }],
    encrypted_content: 'encrypted-reasoning',
  };
  const message = {
    type: 'message',
    id: withTool ? 'msg_before' : 'msg_after',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: withTool ? 'before' : 'after', annotations: [] }],
  };
  const functionCall = {
    type: 'function_call',
    id: 'fc_wire',
    call_id: 'call_probe',
    name: 'wire_probe',
    arguments: '{"path":"a.ts"}',
    status: 'completed',
  };
  let outputIndex = 0;
  if (withTool) {
    event('response.output_item.added', {
      output_index: outputIndex,
      item: { type: 'reasoning', id: reasoning.id, summary: [] },
    });
    event('response.reasoning_summary_text.delta', {
      output_index: outputIndex,
      item_id: reasoning.id,
      summary_index: 0,
      delta: 'think',
    });
    event('response.output_item.done', { output_index: outputIndex++, item: reasoning });
  }
  event('response.output_item.added', {
    output_index: outputIndex,
    item: { ...message, status: 'in_progress', content: [] },
  });
  event('response.output_text.delta', {
    output_index: outputIndex,
    content_index: 0,
    item_id: message.id,
    delta: withTool ? 'before' : 'after',
  });
  event('response.output_item.done', { output_index: outputIndex++, item: message });
  if (withTool) {
    event('response.output_item.added', { output_index: outputIndex, item: { ...functionCall, arguments: '' } });
    event('response.function_call_arguments.delta', {
      output_index: outputIndex,
      item_id: functionCall.id,
      delta: '{"path":',
    });
    event('response.function_call_arguments.delta', {
      output_index: outputIndex,
      item_id: functionCall.id,
      delta: '"a.ts"}',
    });
    event('response.output_item.done', { output_index: outputIndex, item: functionCall });
  }
  event('response.completed', {
    response: {
      id: 'resp_wire',
      status: 'completed',
      model: 'gpt-4.1',
      output: withTool ? [reasoning, message, functionCall] : [message],
      usage: {
        input_tokens: 20,
        output_tokens: 12,
        total_tokens: 32,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    },
  });
  response.end();
}
function anthropic(response: ServerResponse, withTool: boolean) {
  const event = (type: string, extra: Record<string, unknown>) => sse(response, { type, ...extra }, true);
  event('message_start', {
    message: {
      id: 'msg_wire',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 15, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  });
  let index = 0;
  if (withTool) {
    event('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
    event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: 'think' } });
    event('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'anthropic-signature' } });
    event('content_block_stop', { index: index++ });
  }
  event('content_block_start', { index, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index, delta: { type: 'text_delta', text: withTool ? 'before' : 'after' } });
  event('content_block_stop', { index: index++ });
  if (withTool) {
    event('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: 'call_probe', name: 'wire_probe', input: {} },
    });
    event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '{"path":' } });
    event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } });
    event('content_block_stop', { index });
  }
  event('message_delta', {
    delta: { stop_reason: withTool ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 12 },
  });
  event('message_stop', {});
  response.end();
}

describe('real SDK request policy', () => {
  it.each(['openai_chat_completions', 'openai_responses'] as const)(
    '%s removes rejected effort once, remembers it and keeps observations paired',
    async (protocol) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const wire = await server((response, index) => {
        if (index === 0) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                message: "Unsupported value: 'none' is not supported for reasoning effort",
                type: 'invalid_request_error',
              },
            }),
          );
        } else if (protocol === 'openai_chat_completions') chat(response, false);
        else responses(response, false);
      });
      const provider = { id: `effort-${protocol}`, protocol, api_base: wire.url };
      disposers.push(
        micaConfig.registerModelRules({
          [`${provider.id}::wire-effort`]: {
            contextSize: 200,
            defaultEffort: 'none',
            efforts: {
              none: {
                [protocol]:
                  protocol === 'openai_responses' ? { reasoning: { effort: 'none' } } : { reasoning_effort: 'none' },
              },
            },
          },
        }),
      );
      const options = {
        model: 'wire-effort',
        provider,
        effort: 'none',
        apiKey: 'local-key',
        systemPrompt: 'test',
        tools: false,
      };
      const start = vi.fn();
      const end = vi.fn();
      await expect(
        new PiModelClient(options).query('question', { onRequestStart: start, onRequestEnd: end }),
      ).resolves.toBe('after');
      const field = protocol === 'openai_responses' ? 'reasoning' : 'reasoning_effort';
      expect(wire.requests[0]!.body[field]).toEqual(
        protocol === 'openai_responses' ? { effort: 'none', summary: 'auto' } : 'none',
      );
      expect(wire.requests[1]!.body).not.toHaveProperty(field);
      await expect(new PiModelClient(options).query('another question')).resolves.toBe('after');
      expect(wire.requests[2]!.body).not.toHaveProperty(field);
      expect(wire.requests).toHaveLength(3);
      expect(start).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(micaConfig.getModelEffortOptions('wire-effort', protocol, provider)).not.toContain('none');
    },
  );

  it.each(['openai_chat_completions', 'openai_responses'] as const)(
    '%s retries the exact codexgo invalid_json response with the same request body',
    async (protocol) => {
      const wire = await server((response, index) => {
        if (index === 0) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: { code: 'invalid_json', message: '请求体必须是有效 JSON，最大 8MB', type: 'codexgo_error' },
            }),
          );
        } else if (protocol === 'openai_responses') responses(response, false);
        else chat(response, false);
      });
      const client = new PiModelClient({
        model: 'wire-codexgo',
        provider: { id: 'wire-codexgo', protocol, api_base: wire.url },
        apiKey: 'local-test-key',
        systemPrompt: 'test',
        tools: false,
      });
      const retry = vi.fn();
      const end = vi.fn();
      await expect(client.query('question', { onRetry: retry, onRequestEnd: end })).resolves.toBe('after');
      expect(wire.requests).toHaveLength(2);
      expect(wire.requests[1]).toEqual(wire.requests[0]);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempts: 2, outcome: 'completed' }));
      expect(client.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    },
  );

  it.each([400, 503])('uses the HTTP %s status from a real SDK failure for retry policy', async (status) => {
    const wire = await server((response, index) => {
      if (index === 0) {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { message: status === 503 ? 'overloaded' : 'invalid parameter', type: 'request_error' },
          }),
        );
      } else chat(response, false);
    });
    const client = new PiModelClient({
      model: 'wire-http',
      provider: { id: 'wire-http', protocol: 'openai_chat_completions', api_base: wire.url },
      apiKey: 'test-key',
      systemPrompt: 'test',
      tools: false,
    });
    const start = vi.fn();
    const end = vi.fn();
    if (status === 400) {
      await expect(client.query('question', { onRequestStart: start, onRequestEnd: end })).rejects.toMatchObject({
        status: 400,
      });
      expect(wire.requests).toHaveLength(1);
    } else {
      await expect(client.query('question', { onRequestStart: start, onRequestEnd: end })).resolves.toBe('after');
      expect(wire.requests).toHaveLength(2);
      expect(end).toHaveBeenCalledWith(expect.objectContaining({ attempts: 2, outcome: 'completed' }));
    }
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('omits user images for a text-only model while preserving the original history', async () => {
    const wire = await server((response) => chat(response, false));
    const client = new PiModelClient({
      model: 'text-only',
      provider: { id: 'text-only', protocol: 'openai_chat_completions', api_base: wire.url },
      apiKey: 'test-key',
      systemPrompt: 'test',
      supportsVision: false,
      tools: false,
    });
    await client.query([
      { type: 'text', text: 'inspect' },
      { type: 'image', source: { type: 'base64', data: image, media_type: 'image/png' } },
    ]);
    const payload = JSON.stringify(wire.requests[0]!.body);
    expect(payload).not.toContain(image);
    expect(payload).toMatch(/image omitted|图片已省略/);
    expect(JSON.stringify(client.messages)).toContain(image);
  });
});

describe('pi history replay and Google', () => {
  it('fills missing tool results through the real SDK without mutating persisted history', async () => {
    const wire = await server((response) => chat(response, false));
    const client = new PiModelClient({
      model: 'history-wire',
      provider: { id: 'history-wire', protocol: 'openai_chat_completions', api_base: wire.url },
      apiKey: 'test-key',
      systemPrompt: 'test',
      tools: false,
    });
    const oldAssistant: AssistantMessage = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'history-wire',
      model: 'history-wire',
      timestamp: 1,
      stopReason: 'toolUse',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [{ type: 'toolCall', id: 'missing', name: 'wire_probe', arguments: {} }],
    };
    client.loadSnapshot({
      ...client.getSnapshot(),
      messageFormat: 'pi-ai-v1',
      messages: [{ role: 'user', content: 'old', timestamp: 1 }, oldAssistant],
    });
    await client.query('continue');
    const sent = wire.requests[0]!.body.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>;
    expect(sent.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'missing', content: 'No result provided' },
    ]);
    expect(client.messages.some((m) => m.role === 'toolResult')).toBe(false);
  });

  it('drops orphan and duplicate tool results before replay', async () => {
    const wire = await server((response) => chat(response, false));
    const client = new PiModelClient({
      model: 'paired-wire',
      provider: { id: 'paired-wire', protocol: 'openai_chat_completions', api_base: wire.url },
      apiKey: 'test-key',
      systemPrompt: 'test',
      tools: false,
    });
    client.loadSnapshot({
      ...client.getSnapshot(),
      messageFormat: 'pi-ai-v1',
      messages: [
        { role: 'user', content: 'old', timestamp: 1 },
        {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'paired-wire',
          model: 'paired-wire',
          timestamp: 1,
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'paired', name: 'wire_probe', arguments: {} }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        {
          role: 'toolResult',
          toolCallId: 'orphan',
          toolName: 'wire_probe',
          content: [{ type: 'text', text: 'orphan result' }],
          isError: false,
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'paired',
          toolName: 'wire_probe',
          content: [{ type: 'text', text: 'first result' }],
          isError: false,
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'paired',
          toolName: 'wire_probe',
          content: [{ type: 'text', text: 'duplicate result' }],
          isError: false,
          timestamp: 1,
        },
      ],
    });
    await client.query('continue');
    const sent = wire.requests[0]!.body.messages as Array<{ role: string; tool_call_id?: string; content: unknown }>;
    expect(sent.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'paired', content: 'first result' },
    ]);
  });

  it('Google replays thought signatures, images and function responses with inclusive output usage', async () => {
    const executed = vi.fn();
    registerTool(executed);
    const wire = await server((response, index) => {
      sse(response, {
        candidates: [
          {
            index: 0,
            content: {
              role: 'model',
              parts:
                index === 0
                  ? [
                      { text: 'think', thought: true, thoughtSignature: 'Z29vZ2xlLXRoaW5raW5nLXNpZ25hdHVyZQ==' },
                      { text: 'before' },
                      {
                        functionCall: { id: 'google_call', name: 'wire_probe', args: { path: 'a.ts' } },
                        thoughtSignature: 'Z29vZ2xlLXRvb2wtc2lnbmF0dXJl',
                      },
                    ]
                  : [{ text: 'after' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          cachedContentTokenCount: 5,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 7,
          totalTokenCount: 32,
        },
      });
      response.end();
    });
    const client = new PiModelClient({
      model: 'gemini-2.5-pro',
      provider: { id: 'wire-google', protocol: 'google_generative_ai', api_base: wire.url.replace(/\/v1$/, '/v1beta') },
      apiKey: 'test-key',
      systemPrompt: 'test',
      toolFilter: (name) => name === 'wire_probe',
    });
    const thinking = vi.fn();
    client.onThinking = thinking;
    await expect(client.query('inspect')).resolves.toBe('before\n\nafter');
    expect(executed).toHaveBeenCalledExactlyOnceWith({ path: 'a.ts' });
    expect(thinking).toHaveBeenCalledWith('think');
    expect(wire.requests).toHaveLength(2);
    const replay = JSON.stringify(wire.requests[1]!.body);
    expect(replay).toContain('Z29vZ2xlLXRvb2wtc2lnbmF0dXJl');
    expect(replay).toContain('functionResponse');
    expect(replay).toContain(image);
    expect(client.usageHistory[0]).toMatchObject({
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 12,
      totalTokens: 32,
    });
  });
});

describe('real SDK reasoning and truncation', () => {
  it.each([false, true])(
    'preserves explicit Responses summary controls and honors supportsEffort=%s',
    async (supportsEffort) => {
      const wire = await server((response) => responses(response, false));
      const provider = {
        id: `wire-summary-${supportsEffort}`,
        protocol: 'openai_responses' as const,
        api_base: wire.url,
        supportsEffort,
      };
      disposers.push(
        micaConfig.registerModelRules({
          [`${provider.id}::wire-summary`]: {
            contextSize: 200,
            defaultEffort: 'low',
            efforts: {
              low: { openai_responses: { reasoning: { effort: 'low', summary: 'concise' }, temperature: 0.2 } },
            },
          },
        }),
      );
      const client = new PiModelClient({
        model: 'wire-summary',
        provider,
        effort: 'low',
        apiKey: 'test-key',
        systemPrompt: 'test',
        tools: false,
      });
      await client.query('question');
      if (supportsEffort) {
        expect(wire.requests[0]!.body).toMatchObject({
          reasoning: { effort: 'low', summary: 'concise' },
          temperature: 0.2,
          include: ['reasoning.encrypted_content'],
        });
      } else {
        expect(wire.requests[0]!.body).not.toHaveProperty('reasoning');
        expect(wire.requests[0]!.body).not.toHaveProperty('reasoning_effort');
      }
    },
  );

  it('rejects a truncated Responses SSE stream after displaying partial text', async () => {
    const wire = await server((response) => {
      sse(
        response,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_partial', role: 'assistant', content: [] },
        },
        true,
      );
      sse(response, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' }, true);
      response.end();
    });
    const client = new PiModelClient({
      model: 'wire-truncated',
      provider: { id: 'wire-truncated', protocol: 'openai_responses', api_base: wire.url },
      apiKey: 'test-key',
      systemPrompt: 'test',
      tools: false,
    });
    client.onText = vi.fn();
    await expect(client.query('question')).rejects.toThrow(/stream|terminal|completed/i);
    expect(client.onText).toHaveBeenCalledWith('partial');
    expect(wire.requests).toHaveLength(1);
    expect(client.messages).toEqual([]);
  });

  it('learns a Chat gateway without finish_reason after one rollback and sends a single final answer', async () => {
    const wire = await server((response) => {
      sse(response, {
        id: 'chatcmpl_no_finish',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'wire-no-finish',
        choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }],
      });
      response.end('data: [DONE]\n\n');
    });
    const client = new PiModelClient({
      model: 'wire-no-finish',
      provider: { id: 'wire-no-finish', protocol: 'openai_chat_completions', api_base: wire.url },
      apiKey: 'test-key',
      systemPrompt: 'test',
      tools: false,
    });
    let display = '';
    client.onText = (delta) => {
      display += delta;
    };
    client.onTextAttemptStart = vi.fn();
    client.onTextRollback = vi.fn(() => {
      display = '';
    });
    await expect(client.query('question')).resolves.toBe('answer');
    expect(display).toBe('answer');
    expect(wire.requests).toHaveLength(2);
    expect(client.onTextRollback).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { compactHistoricalToolResultText, MAX_HISTORICAL_TOOL_RESULT_CHARS } from './historyCompaction.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';

describe('compactHistoricalToolResultText', () => {
  it('keeps short tool results unchanged', () => {
    expect(compactHistoricalToolResultText('small result')).toBe('small result');
  });

  it('bounds long historical tool results and reports omitted characters', () => {
    const output = compactHistoricalToolResultText(longToolResult());

    expect(output.length).toBeLessThanOrEqual(MAX_HISTORICAL_TOOL_RESULT_CHARS);
    expect(output).toContain('历史工具结果已压缩');
    expect(output).toMatch(/省略 \d+ 字符/);
  });

  it('compacts Responses tool results when loading snapshots', () => {
    const agent = new ResponsesClient(options('openai_responses'));
    agent.loadSnapshot({
      model: 'test-model',
      messages: [
        { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: longToolResult() },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });

    expect(JSON.stringify(agent.getSnapshot().messages[1])).toContain('历史工具结果已压缩');
    expect(JSON.stringify(agent.getSnapshot().messages[1]).length).toBeLessThan(MAX_HISTORICAL_TOOL_RESULT_CHARS + 500);
  });

  it('drops non-encrypted Responses reasoning items when loading snapshots', () => {
    const agent = new ResponsesClient(options('openai_responses'));
    agent.loadSnapshot({
      model: 'test-model',
      messages: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'reasoning', id: 'rs_test', summary: [] },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          id: 'msg_test',
          content: [{ type: 'output_text', text: 'hi', annotations: [] }],
        },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });

    expect(agent.getSnapshot().messages.map((item) => item.type)).toEqual(['message', 'message']);
  });

  it('compacts Chat Completions tool results when loading snapshots', () => {
    const agent = new ChatCompletionsClient(options('openai_chat_completions'));
    agent.loadSnapshot({
      model: 'test-model',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: longToolResult() },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });

    expect(JSON.stringify(agent.getSnapshot().messages[1])).toContain('历史工具结果已压缩');
    expect(JSON.stringify(agent.getSnapshot().messages[1]).length).toBeLessThan(MAX_HISTORICAL_TOOL_RESULT_CHARS + 500);
  });

  it('repairs invalid Chat Completions image URLs in persisted history', () => {
    const agent = new ChatCompletionsClient(options('openai_chat_completions'));
    agent.loadSnapshot({
      model: 'test-model',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            { type: 'image_url', image_url: { url: '[image omitted during compact]' } },
          ],
        },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });

    const serialized = JSON.stringify(agent.getSnapshot().messages);
    expect(serialized).toContain('[image omitted from invalid historical content]');
    expect(serialized).not.toContain('"type":"image_url"');
  });

  it('repairs invalid Responses image URLs in messages and function outputs', () => {
    const agent = new ResponsesClient(options('openai_responses'));
    agent.loadSnapshot({
      model: 'test-model',
      messages: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect this' },
            { type: 'input_image', detail: 'auto', image_url: '/tmp/local-image.png' },
            { type: 'input_image', detail: 'auto', file_id: 'file_valid_image' },
          ],
        },
        { type: 'function_call', call_id: 'call-image', name: 'read_image', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call-image',
          output: [
            { type: 'input_text', text: 'loaded' },
            { type: 'input_image', detail: 'auto', image_url: '[image omitted during compact]' },
          ],
        },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });

    const serialized = JSON.stringify(agent.getSnapshot().messages);
    expect(serialized.match(/image omitted from invalid historical content/g)).toHaveLength(2);
    expect(serialized).toContain('file_valid_image');
    expect(serialized.match(/"type":"input_image"/g)).toHaveLength(1);
  });

  it('drops orphaned and duplicate tool results when loading provider history', () => {
    const chat = new ChatCompletionsClient(options('openai_chat_completions'));
    chat.loadSnapshot({
      model: 'test-model',
      messages: [
        { role: 'tool', tool_call_id: 'orphan', content: 'orphan output' },
        { role: 'user', content: 'continue' },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });
    expect(chat.getSnapshot().messages.map((message) => message.role)).toEqual(['user']);

    const responses = new ResponsesClient(options('openai_responses'));
    responses.loadSnapshot({
      model: 'test-model',
      messages: [
        { type: 'function_call_output', call_id: 'orphan', output: 'orphan output' },
        { type: 'function_call', call_id: 'valid', name: 'read_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'valid', output: 'first output' },
        { type: 'function_call_output', call_id: 'valid', output: 'duplicate output' },
      ],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    });
    expect(responses.getSnapshot().messages.map((item) => item.type)).toEqual([
      'function_call',
      'function_call_output',
    ]);
    expect(JSON.stringify(responses.getSnapshot().messages)).not.toContain('duplicate output');
  });
});

function longToolResult(): string {
  return 'x'.repeat(MAX_HISTORICAL_TOOL_RESULT_CHARS + 5000);
}

function options(protocol: ProviderProtocol): ModelClientOptions {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    provider: {
      id: 'test',
      api_base: 'https://example.com/v1',
      protocol,
    },
  };
}

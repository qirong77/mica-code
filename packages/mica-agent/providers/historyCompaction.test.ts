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

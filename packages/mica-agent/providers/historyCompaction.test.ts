import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { PiModelClient } from './PiModelClient.js';
import { PiHistoryNormalizer } from './PiHistoryNormalizer.js';
import { compactHistoricalToolResultText, MAX_HISTORICAL_TOOL_RESULT_CHARS } from './historyCompaction.js';

describe('pi historical tool results', () => {
  it('keeps short results and bounds long results with an accurate omission count', () => {
    expect(compactHistoricalToolResultText('short result')).toBe('short result');
    const source = 'x'.repeat(30_000);
    const compacted = compactHistoricalToolResultText(source);
    expect(compacted.length).toBeLessThanOrEqual(MAX_HISTORICAL_TOOL_RESULT_CHARS);
    const kept = compacted.split('\n\n')[0]!.length;
    expect(compacted).toContain(`省略 ${source.length - kept} 字符`);
    expect(compactHistoricalToolResultText(compacted)).toBe(compacted);
  });

  it('compacts a restored tool result without mutating its snapshot or losing images and signed thinking', () => {
    const client = new PiModelClient({
      model: 'history-model',
      provider: { id: 'history', protocol: 'anthropic_messages', api_base: 'http://127.0.0.1:1' },
    });
    const signed: AssistantMessage = {
      role: 'assistant',
      api: 'anthropic-messages',
      provider: 'history',
      model: 'history-model',
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
      content: [
        { type: 'thinking', thinking: 'hidden from display', thinkingSignature: 'signed-thinking' },
        { type: 'toolCall', id: 'call', name: 'read_image', arguments: { path: 'a.png' } },
      ],
    };
    const messages: Message[] = [
      { role: 'user', content: 'inspect', timestamp: 1 },
      signed,
      {
        role: 'toolResult',
        toolCallId: 'call',
        toolName: 'read_image',
        timestamp: 2,
        isError: false,
        content: [
          { type: 'text', text: 'x'.repeat(30_000) },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        ],
      },
    ];
    const original = structuredClone(messages);
    client.loadSnapshot({ ...client.getSnapshot(), messageFormat: 'pi-ai-v1', messages });
    expect(messages).toEqual(original);
    const result = client.messages[2]!;
    expect(result.role).toBe('toolResult');
    expect(JSON.stringify(result)).toContain('历史工具结果已压缩');
    expect(result.content[1]).toEqual({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' });
    expect(client.messages[1]).toEqual(signed);
    const projected = new PiHistoryNormalizer().normalize(client.messages);
    expect(projected.find((item) => item.type === 'tool_call')).toMatchObject({
      id: 'call',
      name: 'read_image',
      args: { path: 'a.png' },
    });
    expect(projected.find((item) => item.type === 'tool_result')).toMatchObject({
      id: 'call',
      name: 'read_image',
      isError: false,
    });
    expect(JSON.stringify(client.toConversationMessages())).not.toContain('signed-thinking');
    expect(JSON.stringify(client.toConversationMessages())).not.toContain('aW1hZ2U=');
  });
});

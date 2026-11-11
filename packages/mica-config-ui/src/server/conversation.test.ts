import { describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { PROVIDER_PROTOCOLS } from '@packages/mica-config/providerProtocol.js';
import { buildConfigWebConversationDetails, buildConfigWebConversationItems } from './conversation.js';

const MESSAGES: Message[] = [
  { role: 'user', content: 'inspect the project', timestamp: 1 },
  assistant([
    { type: 'text', text: 'I will read it.' },
    { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { file_path: 'README.md' } },
  ]),
  {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read_file',
    content: [{ type: 'text', text: '# Project' }],
    isError: false,
    timestamp: 3,
  },
  assistant([{ type: 'text', text: 'Done.' }]),
];

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5',
    stopReason: 'stop',
    timestamp: 2,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe('buildConfigWebConversationDetails', () => {
  it.each(PROVIDER_PROTOCOLS)('projects the same Pi messages for %s', (protocol) => {
    const details = buildConfigWebConversationDetails(
      { providerId: 'test', protocol, model: 'gpt-5', systemPrompt: 'system instructions', messages: MESSAGES },
      new Date('2026-01-02T03:04:05.000Z'),
    );

    expect(details.protocol).toBe(protocol);
    expect(details.updatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(details.items.map((item) => item.type)).toEqual([
      'system',
      'user',
      'assistant',
      'tool_call',
      'tool_result',
      'assistant',
    ]);
    expect(details.items.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(details.items[3]).toMatchObject({
      toolName: 'read_file',
      callId: 'call-1',
      content: '{\n  "file_path": "README.md"\n}',
    });
    expect(details.items[4]).toMatchObject({ toolName: 'read_file', callId: 'call-1', content: '# Project' });
  });

  it('omits thinking blocks and signatures from the visualized conversation', () => {
    const details = buildConfigWebConversationDetails({
      providerId: 'anthropic',
      protocol: 'anthropic_messages',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'system instructions',
      messages: [
        { role: 'user', content: 'Inspect this', timestamp: 1 },
        assistant([
          { type: 'thinking', thinking: 'short summary', thinkingSignature: 'private-provider-payload' },
          { type: 'text', text: 'Done.' },
        ]),
      ],
    });

    expect(details.items.map((item) => item.type)).toEqual(['system', 'user', 'assistant']);
    expect(details.items.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(details.items)).not.toContain('private-provider-payload');
    expect(JSON.stringify(details.items)).not.toContain('short summary');
  });

  it('keeps safe thinking text and a signature size hint in the context item list', () => {
    const items = buildConfigWebConversationItems({
      providerId: 'responses',
      protocol: 'openai_responses',
      model: 'gpt-5',
      systemPrompt: 'system instructions',
      messages: [
        { role: 'user', content: 'Think about this', timestamp: 1 },
        assistant([{ type: 'thinking', thinking: 'short summary', thinkingSignature: 'opaque-private-payload' }]),
        assistant([{ type: 'text', text: 'Done.' }]),
      ],
    });

    expect(items.map((item) => item.type)).toEqual(['system', 'user', 'reasoning', 'assistant']);
    expect(items[2]).toMatchObject({
      type: 'reasoning',
      content: 'short summary',
      sizeHint: 'opaque-private-payload'.length,
    });
    expect(JSON.stringify(items)).not.toContain('opaque-private-payload');
  });
});

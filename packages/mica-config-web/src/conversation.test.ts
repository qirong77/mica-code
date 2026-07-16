import { describe, expect, it } from 'vitest';
import { buildConfigWebConversationDetails } from './conversation.js';

describe('buildConfigWebConversationDetails', () => {
  it('orders the system prompt, chat messages, tool calls, and tool results', () => {
    const details = buildConfigWebConversationDetails(
      {
        providerId: 'openai',
        protocol: 'openai_chat_completions',
        model: 'gpt-5',
        systemPrompt: 'system instructions',
        messages: [
          { role: 'user', content: 'inspect the project' },
          {
            role: 'assistant',
            content: 'I will read it.',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"file_path":"README.md"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call-1', content: '# Project' },
          { role: 'assistant', content: 'Done.' },
        ],
      },
      new Date('2026-01-02T03:04:05.000Z'),
    );

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

  it('orders Responses API items and associates tool results by call id', () => {
    const details = buildConfigWebConversationDetails({
      providerId: 'responses',
      protocol: 'openai_responses',
      model: 'gpt-5',
      systemPrompt: 'system instructions',
      messages: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run tests' }] },
        {
          type: 'function_call',
          call_id: 'call-2',
          name: 'run_shell',
          arguments: '{"command":"bun test"}',
        },
        { type: 'function_call_output', call_id: 'call-2', output: 'all tests passed' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] },
      ],
    });

    expect(details.items.map((item) => item.type)).toEqual(['system', 'user', 'tool_call', 'tool_result', 'assistant']);
    expect(details.items[3]).toMatchObject({
      toolName: 'run_shell',
      callId: 'call-2',
      content: 'all tests passed',
    });
  });

  it('omits internal Responses reasoning items from the visualized conversation', () => {
    const details = buildConfigWebConversationDetails({
      providerId: 'responses',
      protocol: 'openai_responses',
      model: 'gpt-5',
      systemPrompt: 'system instructions',
      messages: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }] },
        { type: 'reasoning', id: 'rs_1', content: [], encrypted_content: 'private-provider-payload' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      ],
    });

    expect(details.items.map((item) => item.type)).toEqual(['system', 'user', 'assistant']);
    expect(details.items.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(details.items)).not.toContain('private-provider-payload');
  });
});

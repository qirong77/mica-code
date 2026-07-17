import { describe, expect, it } from 'vitest';
import { formatToolSummary, groupConversationItems } from './ChatTranscript.js';
import type { ConfigWebConversationItem } from '../../../src/shared/types.js';

describe('terminal conversation transcript', () => {
  it('pairs structured tool calls and results inside one assistant turn', () => {
    const items: ConfigWebConversationItem[] = [
      { sequence: 1, type: 'user', content: 'inspect it' },
      { sequence: 2, type: 'assistant', content: 'I will inspect the file.' },
      {
        sequence: 3,
        type: 'tool_call',
        content: '{"file_path":"README.md","offset":1,"limit":80}',
        callId: 'call-1',
        toolName: 'read_file',
      },
      { sequence: 4, type: 'tool_result', content: '# Mica', callId: 'call-1', toolName: 'read_file' },
      { sequence: 5, type: 'assistant', content: 'Done.' },
    ];

    const blocks = groupConversationItems(items);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({
      kind: 'assistant',
      steps: [
        { kind: 'text', content: 'I will inspect the file.' },
        { kind: 'tool', call: { callId: 'call-1' }, result: { content: '# Mica' } },
        { kind: 'text', content: 'Done.' },
      ],
    });
  });

  it('turns historical use_tool XML into a compact legacy tool row', () => {
    const blocks = groupConversationItems([
      {
        sequence: 1,
        type: 'assistant',
        content: 'Searching…\n<use_tool><tool_name>web_search</tool_name><query>Mica docs</query></use_tool>',
      },
    ]);

    expect(blocks[0]).toMatchObject({
      kind: 'assistant',
      steps: [
        { kind: 'text', content: 'Searching…\n' },
        {
          kind: 'tool',
          legacy: true,
          call: { toolName: 'web_search', content: '{"query":"Mica docs"}' },
        },
      ],
    });
  });

  it('formats terminal-like summaries without exposing raw JSON', () => {
    expect(formatToolSummary('run_shell', '{"command":"git status --short"}')).toBe('$ git status --short');
    expect(formatToolSummary('read_file', '{"file_path":"src/index.ts","offset":10,"limit":40}')).toBe(
      'read src/index.ts:10 +40 lines',
    );
  });
});

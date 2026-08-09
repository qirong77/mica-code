import { describe, expect, it } from 'vitest';
import { micaContext } from '@packages/mica-context/index.js';
import { toCompactedConversationDisplay } from './compactConversation.js';

const { COMPACT_BOUNDARY_PREFIX, COMPACT_SUMMARY_PREFIX } = micaContext;

describe('toCompactedConversationDisplay', () => {
  it('hides boundary metadata but keeps the checkpoint and recent messages visible', () => {
    const messages = [
      { role: 'user' as const, content: `${COMPACT_BOUNDARY_PREFIX}\n\n{"mode":"summarized"}` },
      { role: 'user' as const, content: `${COMPACT_SUMMARY_PREFIX}\n\nPreserved compact memory` },
      { role: 'user' as const, content: 'recent request' },
      { role: 'assistant' as const, content: 'recent answer' },
    ];

    expect(toCompactedConversationDisplay(messages)).toEqual(messages.slice(1));
  });

  it('does not turn a summary-only compact into an empty terminal conversation', () => {
    const messages = [
      { role: 'user' as const, content: `${COMPACT_BOUNDARY_PREFIX}\n\n{"mode":"summarized"}` },
      { role: 'user' as const, content: `${COMPACT_SUMMARY_PREFIX}\n\nOnly retained context` },
    ];

    expect(toCompactedConversationDisplay(messages)).toEqual([messages[1]]);
  });
});

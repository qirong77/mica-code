import { describe, expect, it } from 'vitest';
import { formatPendingNoticeTitle } from './Conversation.js';

describe('pending queue notice title', () => {
  it.each([
    ['after_turn', 'waiting queue ( waiting to send after current turn · shift + ← to re-edit )'],
    ['after_iteration', 'waiting queue ( waiting to send after current iteration · shift + ← to re-edit )'],
    [null, 'waiting queue ( waiting to send · shift + ← to re-edit )'],
  ] as const)('formats the %s queue mode', (queueMode, expected) => {
    expect(formatPendingNoticeTitle(queueMode)).toBe(expected);
  });
});

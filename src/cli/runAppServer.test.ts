import { describe, expect, it } from 'vitest';
import { MICA_QUEUE_NOTIFICATIONS } from '@packages/mica-runtime/index.js';
import { turnEventToQueueNotification } from './runAppServer.js';
import type { HeadlessTurnEvent } from '../runtime/HeadlessTurnExecutor.js';

const input = {
  id: 'msg-abc-123',
  text: 'second message injected',
  source: 'ui' as const,
  createdAt: 1234,
  queueMode: 'after_iteration' as const,
};

describe('turnEventToQueueNotification (mica/queue extension)', () => {
  it('maps queued to mica/queue/queued with the input and pending list', () => {
    const event: HeadlessTurnEvent = {
      type: 'queued',
      input,
      position: 1,
      pending: [input],
    };
    const result = turnEventToQueueNotification(event, 's1');
    expect(result).toEqual({
      method: MICA_QUEUE_NOTIFICATIONS.queued,
      params: {
        threadId: 's1',
        input: { id: 'msg-abc-123', text: 'second message injected', queueMode: 'after_iteration' },
        position: 1,
        pending: [{ id: 'msg-abc-123', text: 'second message injected', queueMode: 'after_iteration' }],
      },
    });
  });

  it('maps dequeue to mica/queue/dequeue with an empty pending list', () => {
    const event: HeadlessTurnEvent = { type: 'dequeue', input };
    const result = turnEventToQueueNotification(event, 's1');
    expect(result).toEqual({
      method: MICA_QUEUE_NOTIFICATIONS.dequeue,
      params: {
        threadId: 's1',
        input: { id: 'msg-abc-123', text: 'second message injected', queueMode: 'after_iteration' },
        pending: [],
      },
    });
  });

  it('maps queue:changed to mica/queue/changed with the pending list', () => {
    const event: HeadlessTurnEvent = { type: 'queue:changed', pending: [] };
    expect(turnEventToQueueNotification(event, 's1')).toEqual({
      method: MICA_QUEUE_NOTIFICATIONS.changed,
      params: { threadId: 's1', pending: [] },
    });
  });

  it('returns null for non-queue events', () => {
    expect(
      turnEventToQueueNotification({ type: 'turn:start', input: { ...input, queueMode: undefined } }, 's1'),
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { createRuntimeInput } from './RuntimeInput.js';
import { MessageQueueService } from './MessageQueueService.js';

describe('MessageQueueService', () => {
  it('waits for one complete iteration after observing an after-iteration input', () => {
    const queue = new MessageQueueService();
    const input = createRuntimeInput('follow up', 'ui', { queueMode: 'after_iteration' });

    expect(queue.enqueue(input)).toBe(true);
    expect(queue.dequeueAfterCompletedIteration()).toBeNull();
    expect(queue.list()).toEqual([input]);
    expect(queue.dequeueAfterCompletedIteration()).toBe(input);
    expect(queue.list()).toEqual([]);
  });

  it('does not age a replacement input using the removed input boundary', () => {
    const queue = new MessageQueueService();
    const first = createRuntimeInput('first', 'ui', { queueMode: 'after_iteration' });
    const replacement = createRuntimeInput('replacement', 'ui', { queueMode: 'after_iteration' });

    queue.enqueue(first);
    expect(queue.dequeueAfterCompletedIteration()).toBeNull();
    expect(queue.removeLast()).toBe(first);
    queue.enqueue(replacement);

    expect(queue.dequeueAfterCompletedIteration()).toBeNull();
    expect(queue.dequeueAfterCompletedIteration()).toBe(replacement);
  });

  it('leaves after-turn input untouched at iteration boundaries', () => {
    const queue = new MessageQueueService();
    const input = createRuntimeInput('after turn', 'ui', { queueMode: 'after_turn' });

    queue.enqueue(input);

    expect(queue.dequeueAfterCompletedIteration()).toBeNull();
    expect(queue.list()).toEqual([input]);
  });

  it('keeps an eligible input queued when a higher-priority input owns the boundary', () => {
    const queue = new MessageQueueService();
    const input = createRuntimeInput('follow up', 'ui', { queueMode: 'after_iteration' });

    queue.enqueue(input);
    expect(queue.dequeueAfterCompletedIteration(false)).toBeNull();
    expect(queue.dequeueAfterCompletedIteration(false)).toBeNull();
    expect(queue.list()).toEqual([input]);
    expect(queue.dequeueAfterCompletedIteration()).toBe(input);
  });
});

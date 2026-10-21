import { describe, expect, it } from 'vitest';
import { createRuntimeInput } from './RuntimeInput.js';
import { MessageQueueService, QUEUE_HOLD_TTL_MS } from './MessageQueueService.js';

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

  it('resets the observed boundary when the queue is cleared', () => {
    const queue = new MessageQueueService();
    const input = createRuntimeInput('follow up', 'ui', { queueMode: 'after_iteration' });

    queue.enqueue(input);
    expect(queue.dequeueAfterCompletedIteration()).toBeNull();
    queue.clear();
    queue.enqueue(input);

    expect(queue.dequeueAfterCompletedIteration()).toBeNull();
    expect(queue.dequeueAfterCompletedIteration()).toBe(input);
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

  // 客户端把排队消息撤回输入框重新编辑时先冻结它：边界恰好在同一瞬间到来也不能
  // 把用户正在改的文本发出去。
  describe('hold', () => {
    it('never injects a held input, and resumes the wait after release', () => {
      const queue = new MessageQueueService();
      const input = createRuntimeInput('edit me', 'ui', { queueMode: 'after_iteration' });

      queue.enqueue(input);
      expect(queue.holdQueued(input.id)).toBe(true);
      expect(queue.dequeueAfterCompletedIteration()).toBeNull();
      expect(queue.dequeueAfterCompletedIteration()).toBeNull();
      expect(queue.list()).toEqual([input]);

      expect(queue.releaseQueued(input.id)).toBe(true);
      // 释放后重新计时：还得再等一次完整迭代，不会立刻发出去。
      expect(queue.dequeueAfterCompletedIteration()).toBeNull();
      expect(queue.dequeueAfterCompletedIteration()).toBe(input);
    });

    it('can still be recalled while held (recall wins over the hold)', () => {
      const queue = new MessageQueueService();
      const input = createRuntimeInput('edit me', 'ui', { queueMode: 'after_iteration' });

      queue.enqueue(input);
      queue.holdQueued(input.id);

      expect(queue.removeLast()).toBe(input);
      expect(queue.list()).toEqual([]);
    });

    it('refuses to hold an id the slot no longer has', () => {
      const queue = new MessageQueueService();
      const input = createRuntimeInput('sent already', 'ui', { queueMode: 'after_iteration' });

      expect(queue.holdQueued(input.id)).toBe(false);
      queue.enqueue(input);
      expect(queue.holdQueued('other-id')).toBe(false);
      expect(queue.isHeld()).toBe(false);
    });

    // 客户端在 hold 与 recall 之间崩溃时，条目不能永远卡在队列里。
    it('expires a hold that is never released', () => {
      const queue = new MessageQueueService();
      const input = createRuntimeInput('orphaned', 'ui', { queueMode: 'after_iteration' });
      const now = Date.now();

      queue.enqueue(input);
      queue.holdQueued(input.id, 10);
      expect(queue.isHeld()).toBe(true);

      const realNow = Date.now;
      Date.now = () => now + QUEUE_HOLD_TTL_MS;
      try {
        expect(queue.isHeld()).toBe(false);
        expect(queue.dequeueAfterCompletedIteration()).toBeNull();
        expect(queue.dequeueAfterCompletedIteration()).toBe(input);
      } finally {
        Date.now = realNow;
      }
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { CompactionService } from './CompactionService.js';

const messages = Array.from({ length: 12 }, (_, index) => [
  { role: 'user', content: `Request ${index} ` + 'context '.repeat(3000) },
  { role: 'assistant', content: 'answer '.repeat(3000) },
]).flat();

describe('compaction cancellation', () => {
  it('does not start work when the signal was already cancelled', async () => {
    const summarize = vi.fn();
    await expect(new CompactionService().compact({
      messages, summarize, signal: AbortSignal.abort(), options: { force: true },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('does not retry a prompt-limit failure after cancellation', async () => {
    const controller = new AbortController();
    const summarize = vi.fn(async () => {
      controller.abort();
      throw new Error('maximum context length exceeded');
    });
    await expect(new CompactionService().compact({
      messages, summarize, signal: controller.signal, options: { force: true },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('discards a result from a summarizer that ignores cancellation', async () => {
    const controller = new AbortController();
    const summarize = vi.fn(async () => {
      controller.abort();
      return '<summary>Late result.</summary>';
    });
    await expect(new CompactionService().compact({
      messages, summarize, signal: controller.signal, options: { force: true },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});

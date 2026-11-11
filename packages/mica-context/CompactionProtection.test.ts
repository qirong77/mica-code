import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { CompactionService, CompactionNotNeededError } from './CompactionService.js';
import { assistant, image, text, toolBatch, toolCall, toolResult, user } from './testFixtures.js';

const service = new CompactionService();
function round(index: number): Message[] {
  return [
    user(`Requirement ${index}: keep this exact text. ` + 'context '.repeat(2000)),
    assistant([toolCall(`call-${index}`, 'probe', { command: 'echo test' })], { stopReason: 'toolUse' }),
    toolResult(`call-${index}`, 'probe', `UNREAD_RESULT_${index} ` + 'result '.repeat(9000)),
  ];
}

describe('pi compaction protection', () => {
  it('extends a boundary to preserve a whole parallel tool batch, including mixed images and signed blocks', async () => {
    const batch = [
      assistant([
        { type: 'thinking', thinking: 'must stay exact', thinkingSignature: 'thinking-signature' },
        { ...text('working'), textSignature: 'text-signature' },
        { ...toolCall('a', 'read_file'), thoughtSignature: 'call-signature' },
        toolCall('b', 'read_image'),
      ], { stopReason: 'toolUse', responseId: 'batch-id' }),
      toolResult('a', 'read_file', 'UNREAD_RESULT_A'),
      toolResult('b', 'read_image', [text('UNREAD_RESULT_B'), image()]),
    ];
    const messages = [...round(0), ...round(1), ...batch];
    const original = structuredClone(messages);
    const result = await service.compact({ messages, options: { toolResultsOnly: true, preserveRecentMessages: 1 } });
    expect(messages).toEqual(original);
    expect(result.messages.slice(-3)).toEqual(batch);
    expect(result.messages.at(-3)).toBe(batch[0]);
    expect(JSON.stringify(result.messages)).not.toContain('UNREAD_RESULT_1');
    expect(result.savedTokenEstimate).toBeGreaterThan(0);
  });

  it.each([false, true])('preserves a current user round above the target budget (lightweight=%s)', async (lightweightPrune) => {
    const messages = [...round(0), ...round(1), ...round(2), ...round(3)];
    const summarize = vi.fn(async () => '<summary>Earlier work is complete.</summary>');
    const result = await service.compact({
      messages, summarize,
      options: { contextWindowSize: 16_000, preserveRecentRounds: 1, force: true, lightweightPrune, forceSummary: true },
    });
    expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
    expect(JSON.stringify(result.messages)).toContain('UNREAD_RESULT_3');
    expect(summarize).toHaveBeenCalled();
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it.each(['summary', 'prune'] as const)('retains a signed parallel batch verbatim across a %s checkpoint', async (mode) => {
    const batch = [
      assistant([
        { type: 'thinking', thinking: 'keep this reasoning', thinkingSignature: 'opaque' },
        { ...text('reading'), textSignature: 'text-signature' },
        { ...toolCall('a', 'read_file'), thoughtSignature: 'call-signature' },
        toolCall('b', 'read_image'),
      ], { stopReason: 'toolUse', responseId: 'response-id' }),
      toolResult('a', 'read_file', 'UNREAD_A'),
      toolResult('b', 'read_image', [text('UNREAD_B'), image()]),
    ];
    const messages = [...round(0), ...round(1), user('current request'), ...batch];
    const before = structuredClone(messages);
    const result = await service.compact({
      messages, summarize: async () => '<summary>Earlier work.</summary>',
      options: { force: true, lightweightPrune: true, forceSummary: mode === 'summary', pruneOnly: mode === 'prune', preserveRecentMessages: 1, contextWindowSize: 100 },
    });
    expect(result.messages.slice(-3)).toEqual(batch);
    expect(result.messages.at(-3)).toBe(batch[0]);
    expect(messages).toEqual(before);
  });

  it('declines to force a summary when all rounds are protected', async () => {
    const summarize = vi.fn(async () => 'should not run');
    await expect(service.compact({ messages: [...round(0), ...round(1)], summarize, options: { force: true, preserveRecentRounds: 2 } })).rejects.toBeInstanceOf(CompactionNotNeededError);
    expect(summarize).not.toHaveBeenCalled();
  });

  it.each([false, true])('summarizes a long single-user loop while protecting the request and recent batches (lightweight=%s)', async (lightweightPrune) => {
    const messages = [...round(0), ...Array.from({ length: 80 }, (_, i) => round(i + 1).slice(1)).flat()];
    const summarize = vi.fn(async () => '<summary>Completed earlier tool work.</summary>');
    const result = await service.compact({
      messages, summarize,
      options: { contextWindowSize: 32_000, preserveRecentMessages: 8, preserveLatestUserMessage: true, lightweightPrune, forceSummary: true },
    });
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
    expect(result.messages.filter((message) => JSON.stringify(message) === JSON.stringify(messages[0]))).toHaveLength(1);
    expect(result.afterTokenEstimate).toBeLessThan(result.beforeTokenEstimate);
    expect(result.messages.length).toBeLessThan(20);
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it.each(['quick', 'summary'] as const)('protects latest user image before the recent tool window (%s)', async (mode) => {
    const request = user([text('Inspect this exact image.'), image()]);
    const messages = [request, ...Array.from({ length: 30 }, (_, i) => toolBatch(`c${i}`)).flat()];
    const result = await service.compact({
      messages, summarize: async () => '<summary>Older work.</summary>',
      options: { toolResultsOnly: mode === 'quick', forceSummary: true, lightweightPrune: true, preserveRecentMessages: 8, preserveLatestUserMessage: true },
    });
    expect(result.messages).toContainEqual(request);
    expect(result.messages.filter((message) => JSON.stringify(message) === JSON.stringify(request))).toHaveLength(1);
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
  });

  it('protects latest media without an explicit recent window even if the target cannot fit it', async () => {
    const request = user([text('CURRENT_REQUEST ' + 'context '.repeat(10_000)), image()]);
    const messages = [...round(0), ...round(1), request, ...toolBatch('recent')];
    const result = await service.compact({
      messages, summarize: async () => '<summary>Older work.</summary>',
      options: { force: true, contextWindowSize: 100, keepRecentRounds: 1, preserveLatestUserMessage: true },
    });
    expect(result.messages).toContainEqual(request);
  });

  it('prune-only preserves latest images and a complete latest round when dropping old rounds', async () => {
    const request = user([text('latest task'), image()]);
    const messages = [
      ...Array.from({ length: 30 }, (_, i) => [user(`old request ${i} ` + 'context '.repeat(1000)), assistant('answer '.repeat(1000))]).flat(),
      request, ...toolBatch('latest'),
    ];
    const result = await service.compact({ messages, options: { force: true, lightweightPrune: true, pruneOnly: true, preserveRecentRounds: 1, preserveLatestUserMessage: true } });
    expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
  });
});

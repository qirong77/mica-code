import { describe, expect, it, vi } from 'vitest';
import { CompactionService, CompactionNotNeededError } from './CompactionService.js';

const service = new CompactionService();
function chatRound(index: number) {
  return [
    { role: 'user', content: `Requirement ${index}: keep this exact text. ` + 'context '.repeat(2000) },
    { role: 'assistant', content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'probe', arguments: JSON.stringify({ command: 'echo test' }) } }] },
    { role: 'tool', tool_call_id: `call-${index}`, content: `UNREAD_RESULT_${index} ` + 'result '.repeat(9000) },
  ];
}
function responsesRound(index: number) {
  return [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Requirement ${index}: keep this exact text. ` + 'context '.repeat(2000) }] },
    { type: 'function_call', call_id: `call-${index}`, name: 'probe', arguments: '{"command":"echo test"}' },
    { type: 'function_call_output', call_id: `call-${index}`, output: `UNREAD_RESULT_${index} ` + 'result '.repeat(9000) },
  ];
}
for (const [protocol, round] of [['chat', chatRound], ['responses', responsesRound]] as const) {
  describe(`${protocol} compaction protection`, () => {
    it('preserves the newest tool batch even when the requested boundary splits the pair', async () => {
      const messages = [...round(0), ...round(1), ...round(2)];
      const original = structuredClone(messages);
      const result = await service.compact({ messages, options: { toolResultsOnly: true, preserveRecentMessages: 1 } });
      expect(messages).toEqual(original);
      expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
      expect(JSON.stringify(result.messages)).toContain('UNREAD_RESULT_2');
      expect(JSON.stringify(result.messages)).not.toContain('UNREAD_RESULT_1');
      expect(result.savedTokenEstimate).toBeGreaterThan(0);
    });

    it('never prunes or summarizes away the current user round to meet a target budget', async () => {
      const messages = [...round(0), ...round(1), ...round(2), ...round(3)];
      const summarize = vi.fn(async () => '<summary>Earlier work is complete; continue the latest request.</summary>');
      const result = await service.compact({
        messages,
        summarize,
        options: { contextWindowSize: 16_000, preserveRecentRounds: 1, force: true },
      });
      expect(result.messages.slice(-3)).toEqual(messages.slice(-3));
      expect(JSON.stringify(result.messages)).toContain('UNREAD_RESULT_3');
      expect(summarize).toHaveBeenCalled();
      expect(summarize.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('declines to force a summary when the protected history is the entire conversation', async () => {
      const summarize = vi.fn(async () => 'should not run');
      await expect(service.compact({
        messages: [...round(0), ...round(1)], summarize,
        options: { force: true, preserveRecentRounds: 2 },
      })).rejects.toBeInstanceOf(CompactionNotNeededError);
      expect(summarize).not.toHaveBeenCalled();
    });
  });
}

for (const [protocol, round] of [['chat', chatRound], ['responses', responsesRound]] as const) {
  it(`${protocol} can summarize a long single-user tool loop without changing the request or recent batches`, async () => {
    const messages = [...round(0), ...Array.from({ length: 80 }, (_, i) => round(i + 1).slice(1)).flat()];
    const summarize = vi.fn(async () => '<summary>Completed earlier tool work. Continue with the latest outputs.</summary>');
    const result = await service.compact({
      messages, summarize,
      options: { contextWindowSize: 32_000, preserveRecentMessages: 8, preserveLatestUserMessage: true },
    });
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
    expect(result.messages.filter(message => JSON.stringify(message) === JSON.stringify(messages[0]))).toHaveLength(1);
    expect(result.afterTokenEstimate).toBeLessThan(result.beforeTokenEstimate);
    expect(result.messages.length).toBeLessThan(20);
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it(`${protocol} protects the latest user media even when the request precedes the recent tool window`, async () => {
    const request = protocol === 'chat'
      ? { role: 'user', content: [{ type: 'text', text: 'Inspect this exact image.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(5000) } }] }
      : { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this exact image.' }, { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(5000) }] };
    const messages = [request, ...Array.from({ length: 30 }, (_, i) => round(i).slice(1)).flat()];
    const result = await service.compact({
      messages, options: { toolResultsOnly: true, preserveRecentMessages: 8, preserveLatestUserMessage: true },
    });
    expect(result.messages[0]).toEqual(request);
    expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
  });
}

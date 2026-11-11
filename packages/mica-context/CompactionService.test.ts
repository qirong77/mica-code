import type { Message, ToolCall } from '@earendil-works/pi-ai';
import { contentText } from '@earendil-works/pi-ai/utils/text';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTranscript, COMPACT_BOUNDARY_PREFIX, COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError, CompactionPromptTooLongError, CompactionService,
} from './CompactionService.js';
import { estimateContextTokens } from './tokenEstimate.js';
import { assistant, image, IMAGE_BASE64, makeMessages, makeToolMessages, text, toolBatch, toolCall, toolResult, user } from './testFixtures.js';

const SUMMARY = '<analysis>draft</analysis><summary>## Primary Request and Intent\n- Continue the coding task.\n\n## Immediate Next Step\n- Run tests.</summary>';
const service = new CompactionService();
const contentOf = (message: Message) => contentText(message.content);
const callsOf = (messages: Message[]): ToolCall[] => messages.flatMap((message) => message.role === 'assistant' ? message.content.filter((block) => block.type === 'toolCall') : []);

function expectPaired(messages: Message[]) {
  const calls = callsOf(messages);
  const results = messages.filter((message) => message.role === 'toolResult');
  expect(results.map((message) => message.toolCallId).sort()).toEqual(calls.map((call) => call.id).sort());
  for (const call of calls) expect(typeof call.arguments).toBe('object');
}

describe('CompactionService with pi messages', () => {
  it('writes timestamped user checkpoints, keeps recent rounds, and strips analysis', async () => {
    const messages = makeMessages(10);
    const result = await service.compact({
      messages, options: { keepRecentRounds: 3, aggressive: true },
      summarize: async (transcript, prompt) => {
        expect(prompt).toContain('Do NOT call any tools');
        expect(transcript).toContain('user request 1');
        expect(transcript).not.toContain('user request 9');
        return SUMMARY;
      },
    });
    expect(result).toMatchObject({ beforeCount: 20, afterCount: 8, summarizedCount: 14, keptCount: 6, strategy: 'summary_with_recent' });
    expect(result.messages.slice(-6)).toEqual(messages.slice(-6));
    expect(result.messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining(COMPACT_BOUNDARY_PREFIX), timestamp: expect.any(Number) });
    expect(result.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining(COMPACT_SUMMARY_PREFIX), timestamp: expect.any(Number) });
    expect(contentOf(result.messages[1]!)).not.toContain('<analysis>');
    expect(contentOf(result.messages[1]!)).toContain('## Validation');
    expect(messages).toEqual(makeMessages(10));
  });

  it('renders unified assistant blocks and named error/image results into grouped transcript', () => {
    const transcript = buildTranscript([
      user('inspect the parser'),
      assistant([
        { type: 'thinking', thinking: 'read the parser first', thinkingSignature: 'opaque' },
        text('reading the parser'),
        toolCall('a', 'read_file', { path: 'src/parser.ts' }),
        toolCall('b', 'read_file', { path: 'src/tokens.ts' }),
        toolCall('c', 'run_shell', { command: 'npm test' }),
      ]),
      toolResult('a', 'read_file', 'parser body'), toolResult('b', 'read_file', 'tokens body'),
      toolResult('c', 'run_shell', [text('tests failed'), image()], true),
    ]);
    expect(transcript).toContain('## 轮次 1');
    expect(transcript).toContain('用户：inspect the parser');
    expect(transcript).toContain('思考：\nread the parser first');
    expect(transcript).toContain('模型：\nreading the parser');
    expect(transcript).toContain('- read_file ×2: path: src/parser.ts / path: src/tokens.ts');
    expect(transcript).toContain('- run_shell ×1: command: npm test');
    expect(transcript).toContain('- read_file ×2:\n  - parser body\n  - tokens body');
    expect(transcript).toContain('[error] tests failed');
    expect(transcript).toContain('[图片]');
    expect(transcript).not.toContain(IMAGE_BASE64);
    expect(transcript).not.toContain('opaque');
  });

  it('preserves changed file hints beyond the shown calls and extracts multiline patch paths', () => {
    const calls = Array.from({ length: 12 }, (_, index) => toolCall(`c${index}`, 'read_file', { path: `src/file${index}.ts` }));
    calls.push(toolCall('patch', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: src/last.ts\n@@\n+ok\n*** End Patch' }));
    const transcript = buildTranscript([user('fix these'), assistant(calls)]);
    expect(transcript).toContain('src/file11.ts');
    expect(transcript).toContain('files: src/last.ts');
  });

  it('keeps bounded signal excerpts without repeating a one-line error JSON', () => {
    const oneLine = '{"error":"boom","path":"src/a.ts:12"}' + 'y'.repeat(3000);
    const filler = Array.from({ length: 40 }, (_, index) => `line ${index} of the log`).join('\n');
    const transcript = buildTranscript([
      user('check the logs'), assistant([toolCall('a', 'run_shell'), toolCall('b', 'run_shell')]),
      toolResult('a', 'run_shell', oneLine),
      toolResult('b', 'run_shell', `${filler}\nerror${'z'.repeat(600)} at src/b.ts:99\n${filler}`),
    ]);
    expect(transcript).toContain('--- signals ---\n    (none)');
    expect(transcript).toContain(`error${'z'.repeat(195)}…`);
    expect(transcript).not.toContain('z'.repeat(300));
  });

  it('includes the previous checkpoint across repeated and budget constrained compaction', async () => {
    const first = await service.compact({ messages: makeMessages(8), options: { keepRecentRounds: 2, aggressive: true }, summarize: async () => SUMMARY.replace('coding task', 'FIRST_COMPACT_MEMORY') });
    const summarize = vi.fn(async (transcript: string) => {
      expect(transcript).toContain('## 之前的压缩摘要');
      expect(transcript).toContain('FIRST_COMPACT_MEMORY');
      return SUMMARY;
    });
    const second = await service.compact({
      messages: [...first.messages, ...makeMessages(8, 100)], summarize,
      options: { keepRecentRounds: 2, aggressive: true, force: true, summaryInputTokenBudget: 120 },
    });
    expect(second.messages).toHaveLength(6);
    expect(summarize).toHaveBeenCalled();
  });

  it('retries a prompt limit by dropping old rounds and declines an unshrinkable input', async () => {
    const transcripts: string[] = [];
    const result = await service.compact({
      messages: makeMessages(12), options: { keepRecentRounds: 2, aggressive: true },
      summarize: async (transcript) => {
        transcripts.push(transcript);
        if (transcripts.length === 1) throw new Error('prompt too long');
        return SUMMARY;
      },
    });
    expect(result.promptTooLongRetries).toBe(1);
    expect(transcripts[1]).toContain('[earlier conversation truncated for compaction retry]');
    expect(transcripts[1]!.length).toBeLessThan(transcripts[0]!.length);
    const summarize = vi.fn(async () => { throw new Error('maximum context length exceeded'); });
    await expect(service.compact({ messages: makeMessages(2), options: { force: true, maxPromptTooLongRetries: 10 }, summarize })).rejects.toBeInstanceOf(CompactionPromptTooLongError);
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('previews a checkpoint without replacing input messages', async () => {
    const messages = makeMessages(8);
    const result = await service.compact({ messages, options: { keepRecentRounds: 2, aggressive: true, preview: true }, summarize: async () => SUMMARY });
    expect(result.preview).toBe(true);
    expect(result.messages).toEqual(messages);
    expect(result.afterCount).toBeLessThan(result.beforeCount);
  });

  it.each(['', '   ', '<summary></summary>', '<analysis>draft only</analysis>'])(
    'rejects an empty summary without mutating the original history: %j', async (empty) => {
      const messages = makeMessages(8);
      await expect(service.compact({ messages, options: { keepRecentRounds: 2, aggressive: true }, summarize: async () => empty })).rejects.toThrow('Compact summary is empty');
      expect(messages).toEqual(makeMessages(8));
    },
  );

  it('lightweight pruning retains pi structure, replaces all arguments with objects, and removes images', async () => {
    const messages = makeToolMessages(5);
    const before = structuredClone(messages);
    const summarize = vi.fn(async () => SUMMARY);
    const result = await service.compact({ messages, summarize, options: { force: true, lightweightPrune: true, contextWindowSize: 100_000 } });
    expect(result.strategy).toBe('prune_only');
    expect(summarize).not.toHaveBeenCalled();
    expectPaired(result.messages);
    for (const call of callsOf(result.messages)) expect(call.arguments).toEqual({ _truncated: true, note: 'tool arguments cleared during compact' });
    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain('[Old tool result content cleared during compact]');
    expect(serialized).toContain('[image omitted during compact]');
    expect(serialized).not.toContain('RAW_TOOL_RESULT');
    expect(serialized).not.toContain('RAW_SHELL_RESULT');
    expect(serialized).not.toContain(IMAGE_BASE64);
    expect(messages).toEqual(before);
  });

  it('clears all signatures and response ids on a rewritten assistant, preserving request metadata and usage', async () => {
    const original = assistant([
      text('working'),
      { type: 'thinking', thinking: 'reason', thinkingSignature: 'encrypted', redacted: true },
      { ...toolCall('a', 'read_file', { path: 'a.ts' }), thoughtSignature: 'tool-signature' },
    ], { responseId: 'response-a', usage: { ...assistant('').usage, input: 12345 }, stopReason: 'toolUse' });
    original.content[0] = { type: 'text', text: 'working', textSignature: 'text-signature' };
    const result = await service.compact({
      messages: [user('inspect'), original, toolResult('a', 'read_file', 'x'.repeat(5000)), user('next')],
      options: { force: true, pruneOnly: true, lightweightPrune: true },
    });
    const rewritten = result.messages.find((message) => message.role === 'assistant');
    expect(rewritten).toMatchObject({ api: original.api, provider: original.provider, model: original.model, timestamp: original.timestamp, usage: original.usage });
    expect(rewritten).not.toHaveProperty('responseId');
    expect(JSON.stringify(rewritten)).not.toMatch(/Signature|encrypted/);
    expect(original.responseId).toBe('response-a');
  });

  it('prune-only never summarizes even when context stays over budget', async () => {
    const summarize = vi.fn(async () => SUMMARY);
    const result = await service.compact({ messages: makeToolMessages(5), summarize, options: { force: true, lightweightPrune: true, pruneOnly: true, contextWindowSize: 10 } });
    expect(result.mode).toBe('pruned');
    expect(summarize).not.toHaveBeenCalled();
  });

  it('can force a model summary after lightweight pruning', async () => {
    const summarize = vi.fn(async () => SUMMARY);
    const result = await service.compact({ messages: makeToolMessages(5), summarize, options: { force: true, lightweightPrune: true, forceSummary: true, keepRecentRounds: 3, contextWindowSize: 100_000 } });
    expect(result.mode).toBe('summarized');
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('moves removed recent rounds into the summary instead of silently losing them', async () => {
    const transcripts: string[] = [];
    const result = await service.compact({
      messages: makeToolMessages(5), options: { force: true, aggressive: true, lightweightPrune: true, keepRecentRounds: 3, contextWindowSize: 10 },
      summarize: async (transcript) => { transcripts.push(transcript); return `<summary>${transcript}</summary>`; },
    });
    expect(result.strategy).toBe('summary_only_fallback');
    expect(result.keptCount).toBe(0);
    for (let turn = 1; turn <= 5; turn++) expect(transcripts.at(-1)).toContain(`user request ${turn}`);
    expect(transcripts.join('')).not.toContain(IMAGE_BASE64);
  });

  it('keeps large recent arguments as valid JSON objects when the recent budget forces pruning', async () => {
    const result = await service.compact({
      messages: [...makeMessages(6), user('large command'), assistant([toolCall('a', 'run_shell', { command: 'echo ' + 'x'.repeat(20_000) })]), toolResult('a', 'run_shell', 'done')],
      options: { force: true, aggressive: true, keepRecentRounds: 1, maxRecentTokens: 200 }, summarize: async () => SUMMARY,
    });
    expectPaired(result.messages);
    expect(JSON.stringify(result.messages)).not.toContain('x'.repeat(100));
    expect(JSON.stringify(result.messages)).not.toContain('--- head ---');
  });

  it('drops old rounds locally when messages are already clean, retaining complete recent batches', async () => {
    const placeholder = { _truncated: true, note: 'tool arguments cleared during compact' };
    const messages = Array.from({ length: 100 }, (_, index) => [
      user(`user request ${index + 1} keep this round`),
      assistant([text('a moderately long recap of findings and next steps'), toolCall(`c${index}`, 'grep_search', placeholder)]),
      toolResult(`c${index}`, 'grep_search', '[Old tool result content cleared during compact]'),
    ]).flat();
    const summarize = vi.fn(async () => SUMMARY);
    const result = await service.compact({ messages, summarize, options: { force: true, pruneOnly: true, lightweightPrune: true, contextWindowSize: 1_000_000 } });
    expect(summarize).not.toHaveBeenCalled();
    expect(result.savedRatio).toBeGreaterThan(0.5);
    expect(contentOf(result.messages[0]!)).toContain('droppedRounds');
    expect(JSON.stringify(result.messages)).toContain('user request 100 keep this round');
    expect(JSON.stringify(result.messages)).not.toContain('user request 1 keep this round');
    expectPaired(result.messages);
  });

  it('declines tiny or unchanged text histories', async () => {
    await expect(service.compact({ messages: makeMessages(1), options: { force: true }, summarize: async () => SUMMARY })).rejects.toBeInstanceOf(CompactionNotNeededError);
    await expect(service.compact({ messages: makeMessages(1), options: { force: true, lightweightPrune: true, pruneOnly: true }, summarize: async () => SUMMARY })).rejects.toBeInstanceOf(CompactionNotNeededError);
  });

  it('collapses tool batches, removes old thinking/media, keeps dialogue order, and records meaningful counts', async () => {
    const messages = [
      user('keep user text'),
      assistant([text('keep assistant text'), { type: 'thinking' as const, thinking: 'old chain', thinkingSignature: 'opaque' }, toolCall('a', 'read_file', { path: 'a.ts' }), toolCall('b', 'read_file', { path: 'b.ts' })]),
      toolResult('a', 'read_file', [text('RAW_A'), image()]), toolResult('b', 'read_file', 'RAW_B'),
      ...toolBatch('c', 'run_shell'), assistant('keep final text'), user([text('image request'), image()]),
    ];
    const before = structuredClone(messages);
    const result = await service.compact({ messages, options: { toolResultsOnly: true } });
    expect(result).toMatchObject({ toolCallsAggregated: 3, toolResultsReplaced: 3, reasoningItemsDropped: 1, mediaItemsReplaced: 2, afterCount: 6 });
    expect(result.messages.slice(0, 3).map(contentOf)).toEqual(['keep user text', 'keep assistant text', 'keep final text']);
    expect(callsOf(result.messages)).toEqual([toolCall('mica_compact', 'read_file')]);
    expect(contentOf(result.messages.at(-1)!)).toContain('Placeholder for 3 collapsed tool calls');
    expect(contentOf(result.messages.at(-1)!)).toContain('read_file × 2, run_shell × 1');
    expectPaired(result.messages);
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toMatch(/RAW_A|RAW_B|old chain|Signature/);
    expect(serialized).not.toContain(COMPACT_BOUNDARY_PREFIX);
    expect(serialized).not.toContain(IMAGE_BASE64);
    expect(messages).toEqual(before);
    expect(result.beforeTokenEstimate).toBe(estimateContextTokens(messages));
  });

  it('drops empty assistant remnants after removing calls and thinking', async () => {
    const result = await service.compact({ messages: [user('test'), ...toolBatch('a'), assistant('done')], options: { toolResultsOnly: true } });
    expect(result.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant', 'toolResult']);
    expect(contentOf(result.messages[1]!)).toBe('done');
  });

  it('puts the aggregate before the protected latest user round', async () => {
    const messages = [user('old task'), ...toolBatch('a'), assistant('old answer'), user('new task'), assistant('new answer')];
    const result = await service.compact({ messages, options: { toolResultsOnly: true, preserveLatestUserMessage: true } });
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
    expect(result.messages.at(-3)).toMatchObject({ role: 'toolResult', toolCallId: 'mica_compact' });
  });

  it('previews quick compaction without changing input', async () => {
    const messages = makeToolMessages(2);
    const result = await service.compact({ messages, options: { toolResultsOnly: true, preview: true } });
    expect(result.messages).toEqual(messages);
    expect(result.toolCallsAggregated).toBe(4);
  });

  it('keeps quick compaction idempotent and merges later tool counts without double counting', async () => {
    const first = await service.compact({ messages: [...toolBatch('a'), ...toolBatch('b')], options: { toolResultsOnly: true } });
    const original = structuredClone(first.messages);
    await expect(service.compact({ messages: first.messages, options: { toolResultsOnly: true } })).rejects.toBeInstanceOf(CompactionNotNeededError);
    expect(first.messages).toEqual(original);
    const second = await service.compact({ messages: [...first.messages, user('continue'), ...toolBatch('c', 'run_shell')], options: { toolResultsOnly: true } });
    expect(second.toolCallsAggregated).toBe(1);
    expect(second.messages).toHaveLength(3);
    expect(contentOf(second.messages.at(-1)!)).toContain('Placeholder for 3 collapsed tool calls');
    expect(contentOf(second.messages.at(-1)!)).toContain('read_file × 2, run_shell × 1');
    expectPaired(second.messages);
  });

  it('retains hidden tool-kind counts across another aggregation', async () => {
    const messages = Array.from({ length: 12 }, (_, index) => toolBatch(`c${index}`, `tool${index}`)).flat();
    const first = await service.compact({ messages, options: { toolResultsOnly: true } });
    expect(contentOf(first.messages[1]!)).toContain('+4 more kinds');
    const second = await service.compact({ messages: [...first.messages, ...toolBatch('next', 'new_tool')], options: { toolResultsOnly: true } });
    expect(contentOf(second.messages[1]!)).toContain('Placeholder for 13 collapsed tool calls');
    expect(contentOf(second.messages[1]!)).toContain('+5 more kinds');
  });

  it('counts thinking removals without inflating token savings with thinking or usage metadata', async () => {
    const plain = assistant('visible');
    const withThinking = assistant([text('visible'), { type: 'thinking', thinking: 'r'.repeat(40_000), thinkingSignature: 'opaque' }], { usage: { ...plain.usage, input: 999_999, totalTokens: 999_999 } });
    const result = await service.compact({ messages: [user('ask'), withThinking], options: { toolResultsOnly: true } });
    expect(result.reasoningItemsDropped).toBe(1);
    expect(result.beforeTokenEstimate).toBe(estimateContextTokens([user('ask'), plain]));
    expect(result.savedTokenEstimate).toBe(0);
    expect(result.messages[1]).toMatchObject({ content: [text('visible')] });
  });

  it('dialogue summary input excludes tools/thinking while preserving the actual conversation', async () => {
    const messages = [user('user request 1'), assistant([text('assistant answer 1'), toolCall('a', 'read_file', { path: 'secret.ts' }), { type: 'thinking' as const, thinking: 'HIDDEN_THINKING' }]), toolResult('a', 'read_file', 'HIDDEN_OUTPUT'), ...makeMessages(40, 1)];
    let transcript = '';
    await service.compact({ messages, options: { summaryInput: 'dialogue', keepRecentRounds: 2, summaryInputTokenBudget: 10_000 }, summarize: async (value) => { transcript = value; return SUMMARY; } });
    expect(transcript).toContain('用户：user request 1');
    expect(transcript).toContain('模型：\nassistant answer 1');
    expect(transcript).not.toMatch(/HIDDEN_|secret\.ts|read_file|工具调用|工具结果|思考：/);
  });
});

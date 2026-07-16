import { describe, expect, it, vi } from 'vitest';
import {
  COMPACT_BOUNDARY_PREFIX,
  COMPACT_SUMMARY_PREFIX,
  CompactionNotNeededError,
  CompactionService,
} from './CompactionService.js';

const FULL_SUMMARY = `<analysis>draft</analysis>
<summary>
## Primary Request and Intent
- Continue the user's coding task.

## Key Technical Concepts
- Context compaction.

## Files and Code Sections
- packages/mica-context/CompactionService.ts

## User Constraints and Preferences
- Preserve concrete evidence.

## Tool Results and Evidence
- Tests should use real resume history when available.

## Errors and Fixes
- None.

## Validation
- Pending.

## Pending Tasks
- Finish implementation.

## Current Work
- Compacting conversation history.

## Immediate Next Step
- Run tests.
</summary>`;

describe('CompactionService', () => {
  it('summarizes older rounds, keeps recent rounds verbatim, and strips analysis', async () => {
    const service = new CompactionService();
    const messages = makeMessages(10);
    const result = await service.compact({
      messages,
      options: { keepRecentRounds: 3, aggressive: true },
      summarize: async (transcript, prompt) => {
        expect(prompt).toContain('Do NOT call any tools');
        expect(transcript).toContain('user request 1');
        expect(transcript).not.toContain('user request 9');
        return FULL_SUMMARY;
      },
    });

    expect(result.beforeCount).toBe(20);
    expect(result.afterCount).toBe(8);
    expect(result.summarizedCount).toBe(14);
    expect(result.keptCount).toBe(6);
    expect(result.strategy).toBe('summary_with_recent');
    expect(result.messages[0]).toMatchObject({ role: 'user' });
    expect(contentOf(result.messages[0])).toContain(COMPACT_BOUNDARY_PREFIX);
    expect(contentOf(result.messages[1])).toContain(COMPACT_SUMMARY_PREFIX);
    expect(contentOf(result.messages[1])).not.toContain('<analysis>');
    expect(JSON.stringify(result.messages)).toContain('user request 8');
    expect(JSON.stringify(result.messages)).toContain('assistant answer 10');
  });

  it('merges a previous compact summary instead of dropping it on repeated compact', async () => {
    const service = new CompactionService();
    const first = await service.compact({
      messages: makeMessages(8),
      options: { keepRecentRounds: 2, aggressive: true },
      summarize: async () => FULL_SUMMARY.replace('Context compaction.', 'first compact memory.'),
    });

    const second = await service.compact({
      messages: [...first.messages, ...makeMessages(5, 100)],
      options: { keepRecentRounds: 2, aggressive: true },
      summarize: async (transcript) => {
        expect(transcript).toContain(COMPACT_SUMMARY_PREFIX);
        expect(transcript).toContain('first compact memory');
        return FULL_SUMMARY.replace('Context compaction.', 'second compact memory including first.');
      },
    });

    expect(second.messages).toHaveLength(6);
    expect(contentOf(second.messages[1])).toContain('second compact memory including first');
  });

  it('retries prompt-too-long compaction by dropping oldest rounds', async () => {
    const service = new CompactionService();
    let calls = 0;
    const result = await service.compact({
      messages: makeMessages(12),
      options: { keepRecentRounds: 2, aggressive: true },
      summarize: async (transcript) => {
        calls++;
        if (calls === 1) throw new Error('prompt too long');
        expect(transcript).toContain('[earlier conversation truncated for compaction retry]');
        return FULL_SUMMARY;
      },
    });

    expect(calls).toBe(2);
    expect(result.promptTooLongRetries).toBe(1);
    expect(result.strategy).toBe('summary_with_recent');
  });

  it('previews without replacing messages', async () => {
    const service = new CompactionService();
    const messages = makeMessages(8);
    const result = await service.compact({
      messages,
      options: { keepRecentRounds: 2, aggressive: true, preview: true },
      summarize: async () => FULL_SUMMARY,
    });

    expect(result.preview).toBe(true);
    expect(result.messages).toEqual(messages);
    expect(result.afterCount).toBeLessThan(result.beforeCount);
  });

  it('moves the recent boundary backward instead of orphaning Anthropic tool results', async () => {
    const service = new CompactionService();
    const result = await service.compact({
      messages: [
        { role: 'user', content: 'inspect packages/example.ts' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'packages/example.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'RAW_TOOL_RESULT' }],
        },
        { role: 'assistant', content: 'packages/example.ts currently exports a helper.' },
      ],
      options: { keepRecentRounds: 1, aggressive: true, force: true },
      summarize: async (transcript) => {
        expect(transcript).toContain('inspect packages/example.ts');
        expect(transcript).not.toContain('RAW_TOOL_RESULT');
        return FULL_SUMMARY;
      },
    });

    const serialized = JSON.stringify(result.messages);
    expect(serialized).toContain('"tool_use"');
    expect(serialized).toContain('"tool_result"');
    expect(serialized).toContain('tool-1');
  });

  it('force compacts when default recent-context guard would skip', async () => {
    const service = new CompactionService();
    const messages = makeMessages(3);
    const result = await service.compact({
      messages,
      options: { force: true, aggressive: true },
      summarize: async (transcript) => {
        expect(transcript).toContain('user request 1');
        expect(transcript).not.toContain('user request 3');
        return FULL_SUMMARY;
      },
    });

    expect(result.forced).toBe(true);
    expect(result.summarizedCount).toBe(4);
    expect(result.keptCount).toBe(2);
  });

  it('lightweight compact prunes media and every tool result before skipping summary', async () => {
    const service = new CompactionService();
    const summarize = vi.fn(async () => FULL_SUMMARY);
    const result = await service.compact({
      messages: makeToolMessages(5),
      options: {
        force: true,
        aggressive: true,
        keepRecentRounds: 3,
        lightweightPrune: true,
        contextWindowSize: 100_000,
        summarizeThresholdRatio: 0.3,
      },
      summarize,
    });

    const serialized = JSON.stringify(result.messages);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.mode).toBe('pruned');
    expect(result.strategy).toBe('prune_only');
    expect(result.summarizedCount).toBe(0);
    expect(result.contextUsageRatio ?? 1).toBeLessThanOrEqual(0.3);
    expect(serialized).toContain(COMPACT_BOUNDARY_PREFIX);
    expect(serialized).toContain('user request 5');
    expect(serialized).toContain('read_file');
    expect(serialized).toContain('run_shell');
    expect(serialized).toContain('[Old tool result content cleared during compact]');
    expect(serialized).not.toContain('RAW_TOOL_RESULT_1');
    expect(serialized).not.toContain('RAW_TOOL_RESULT_5');
    expect(serialized).not.toContain('RAW_RESPONSES_RESULT_1');
    expect(serialized).not.toContain('RAW_RESPONSES_RESULT_5');
    expect(serialized).not.toContain(IMAGE_BASE64);
  });

  it('preserves opaque Responses encrypted reasoning during lightweight prune-only compact', async () => {
    const service = new CompactionService();
    const encryptedContent = 'A'.repeat(8_000);
    const messages = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect the project' }] },
      {
        type: 'reasoning',
        id: 'rs_test',
        summary: [],
        encrypted_content: encryptedContent,
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what next?' }] },
    ];

    const result = await service.compact({
      messages,
      options: {
        force: true,
        aggressive: true,
        lightweightPrune: true,
        contextWindowSize: 100_000,
      },
      summarize: vi.fn(async () => FULL_SUMMARY),
    });

    expect(result.strategy).toBe('prune_only');
    expect(result.messages).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        id: 'rs_test',
        encrypted_content: encryptedContent,
      }),
    );
    expect(JSON.stringify(result.messages)).not.toContain('[omitted base64 data:');
  });

  it('summarizes sanitized history when lightweight compact is still above threshold', async () => {
    const service = new CompactionService();
    let summaryTranscript = '';
    const result = await service.compact({
      messages: makeToolMessages(5),
      options: {
        force: true,
        aggressive: true,
        keepRecentRounds: 3,
        lightweightPrune: true,
        contextWindowSize: 10,
        summarizeThresholdRatio: 0.3,
      },
      summarize: async (transcript) => {
        summaryTranscript = transcript;
        return FULL_SUMMARY;
      },
    });

    const serialized = JSON.stringify(result.messages);
    expect(result.mode).toBe('summarized');
    expect(result.strategy).toBe('summary_with_recent');
    expect(result.summarizedCount).toBeGreaterThan(0);
    expect(result.keptCount).toBeGreaterThan(0);
    expect(summaryTranscript).toContain('read_file');
    expect(summaryTranscript).toContain('run_shell');
    expect(summaryTranscript).toContain('[Old tool result content cleared during compact]');
    expect(summaryTranscript).not.toContain('RAW_TOOL_RESULT_1');
    expect(summaryTranscript).not.toContain('RAW_RESPONSES_RESULT_1');
    expect(summaryTranscript).not.toContain(IMAGE_BASE64);
    expect(serialized).toContain(COMPACT_SUMMARY_PREFIX);
    expect(serialized).toContain('user request 5');
    expect(serialized).not.toContain('RAW_TOOL_RESULT_5');
    expect(serialized).not.toContain('RAW_RESPONSES_RESULT_5');
    expect(serialized).not.toContain(IMAGE_BASE64);
  });

  it('lightweight compact can prune a short session without an older section to summarize', async () => {
    const service = new CompactionService();
    const summarize = vi.fn(async () => FULL_SUMMARY);
    const result = await service.compact({
      messages: makeToolMessages(2),
      options: {
        force: true,
        aggressive: true,
        keepRecentRounds: 3,
        lightweightPrune: true,
        contextWindowSize: 100_000,
        summarizeThresholdRatio: 0.3,
      },
      summarize,
    });

    const serialized = JSON.stringify(result.messages);
    expect(summarize).not.toHaveBeenCalled();
    expect(result.mode).toBe('pruned');
    expect(result.strategy).toBe('prune_only');
    expect(serialized).toContain('user request 1');
    expect(serialized).toContain('user request 2');
    expect(serialized).toContain('[Old tool result content cleared during compact]');
    expect(serialized).not.toContain('RAW_TOOL_RESULT_1');
    expect(serialized).not.toContain('RAW_TOOL_RESULT_2');
    expect(serialized).not.toContain('RAW_RESPONSES_RESULT_1');
    expect(serialized).not.toContain('RAW_RESPONSES_RESULT_2');
  });

  it('does not force compact when there is no complete recent round to keep', async () => {
    const service = new CompactionService();

    await expect(
      service.compact({
        messages: [
          { role: 'user', content: 'only request' },
          { role: 'assistant', content: 'only answer' },
        ],
        options: { force: true, aggressive: true },
        summarize: async () => FULL_SUMMARY,
      }),
    ).rejects.toBeInstanceOf(CompactionNotNeededError);
  });

});

function makeMessages(rounds: number, offset = 0): unknown[] {
  return Array.from({ length: rounds }, (_, index) => index + 1 + offset).flatMap((turn) => [
    { role: 'user', content: `user request ${turn}` },
    { role: 'assistant', content: `assistant answer ${turn}\nfile packages/example${turn}.ts` },
  ]);
}

const IMAGE_BASE64 = 'QUJD'.repeat(400);

function makeToolMessages(rounds: number): unknown[] {
  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((turn) => [
    {
      role: 'user',
      content: [
        { type: 'text', text: `user request ${turn}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_BASE64 } },
      ],
    },
    {
      role: 'assistant',
      content: `assistant answer ${turn}`,
      tool_calls: [
        {
          id: `call-${turn}`,
          type: 'function',
          function: { name: 'read_file', arguments: `{"path":"packages/example${turn}.ts"}` },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: `call-${turn}`,
      content: `RAW_TOOL_RESULT_${turn}: ${'x'.repeat(4_000)}`,
      toolUseResult: { stdout: `RAW_TOOL_RESULT_${turn}: nested payload` },
    },
    {
      type: 'function_call',
      call_id: `responses-call-${turn}`,
      name: 'run_shell',
      arguments: `{"cmd":"sed -n '1,20p' packages/example${turn}.ts"}`,
    },
    {
      type: 'function_call_output',
      call_id: `responses-call-${turn}`,
      output: `RAW_RESPONSES_RESULT_${turn}: ${'y'.repeat(4_000)}`,
    },
  ]);
}

function contentOf(message: unknown): string {
  return typeof message === 'object' && message ? String((message as Record<string, unknown>).content ?? '') : '';
}

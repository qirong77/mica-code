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

  it('feeds the summarizer a per-round transcript with merged tool calls and results', async () => {
    const service = new CompactionService();
    const transcripts: string[] = [];
    await service.compact({
      messages: [
        { role: 'user', content: 'inspect the parser' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'read the parser first' }] },
        {
          role: 'assistant',
          content: 'reading the parser',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/parser.ts"}' } },
            { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/tokens.ts"}' } },
            { id: 'c3', type: 'function', function: { name: 'run_shell', arguments: '{"command":"npm test"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'parser body' },
        { role: 'tool', tool_call_id: 'c2', content: 'tokens body' },
        { role: 'tool', tool_call_id: 'c3', content: 'tests passed' },
        { role: 'user', content: 'now fix the bug' },
        { role: 'assistant', content: 'fixed' },
      ],
      options: { keepRecentRounds: 1, aggressive: true, force: true },
      summarize: async (transcript) => {
        transcripts.push(transcript);
        return FULL_SUMMARY;
      },
    });

    const transcript = transcripts.at(-1) ?? '';
    // 一次模型回复在历史里是好几条消息，摘要输入里合成一块。
    expect(transcript).not.toContain('## Message');
    expect(transcript).toContain('## 轮次 1');
    expect(transcript).toContain('用户：inspect the parser');
    expect(transcript).toContain('模型：\nreading the parser');
    expect(transcript).toContain('思考：\nread the parser first');
    // 同类工具折成一行，参数只留指向性字段。
    expect(transcript).toContain('- read_file ×2: path: src/parser.ts / path: src/tokens.ts');
    expect(transcript).toContain('- run_shell ×1: command: npm test');
    // 所有工具结果合成一块，同类结果排在一起。
    expect(transcript).toContain('- read_file ×2:\n  - parser body\n  - tokens body');
    expect(transcript).toContain('- run_shell ×1:\n  - tests passed');
  });

  it('keeps signal lines short and skips the ones the head already shows', async () => {
    const service = new CompactionService();
    const transcripts: string[] = [];
    const oneLine = '{"error":"boom","path":"src/a.ts:12"}' + 'y'.repeat(3_000);
    const filler = Array.from({ length: 40 }, (_, index) => `line ${index} of the log`).join('\n');
    const buried = `error${'z'.repeat(600)} at src/b.ts:99`;
    await service.compact({
      messages: [
        { role: 'user', content: 'check the logs' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'run_shell', arguments: '{"command":"cat log"}' } },
            { id: 'c2', type: 'function', function: { name: 'run_shell', arguments: '{"command":"cat other"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: oneLine },
        { role: 'tool', tool_call_id: 'c2', content: `${filler}\n${buried}\n${filler}` },
        { role: 'user', content: 'and then?' },
        { role: 'assistant', content: 'done' },
      ],
      options: { keepRecentRounds: 0, aggressive: true, force: true },
      summarize: async (transcript) => {
        transcripts.push(transcript);
        return FULL_SUMMARY;
      },
    });

    const transcript = transcripts.at(-1) ?? '';
    // 一行的 JSON 结果整行就是 head，信号行再抄一遍纯属浪费。
    expect(transcript).toContain('--- signals ---\n    (none)');
    // 埋在中间的信号行保留定位信息，但按行截断，不整行搬进来。
    expect(transcript).toContain(`error${'z'.repeat(195)}…`);
    expect(transcript).not.toContain('z'.repeat(300));
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
        // 上一次的 checkpoint 以「之前的压缩摘要」成块带进来，标记前缀被剥掉。
        expect(transcript).toContain('## 之前的压缩摘要');
        expect(transcript).toContain('first compact memory');
        return FULL_SUMMARY.replace('Context compaction.', 'second compact memory including first.');
      },
    });

    expect(second.messages).toHaveLength(6);
    expect(contentOf(second.messages[1])).toContain('second compact memory including first');
  });

  it('protects the previous compact checkpoint when the next summary input is budget constrained', async () => {
    const service = new CompactionService();
    const previousCheckpoint = {
      role: 'user',
      content: `${COMPACT_SUMMARY_PREFIX}\n\nFIRST_COMPACT_MEMORY must survive`,
    };

    await service.compact({
      messages: [previousCheckpoint, ...makeMessages(8)],
      options: { keepRecentRounds: 1, aggressive: true, force: true, summaryInputTokenBudget: 120 },
      summarize: async (transcript) => {
        expect(transcript).toContain('FIRST_COMPACT_MEMORY');
        return FULL_SUMMARY;
      },
    });
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

  it.each(['', '   ', '<summary></summary>', '<analysis>nothing useful</analysis>'])(
    'rejects an empty compact summary without producing a replacement history: %j',
    async (emptySummary) => {
      const service = new CompactionService();
      const messages = makeMessages(8);

      await expect(
        service.compact({
          messages,
          options: { keepRecentRounds: 2, aggressive: true },
          summarize: async () => emptySummary,
        }),
      ).rejects.toThrow('Compact summary is empty');

      expect(messages).toEqual(makeMessages(8));
    },
  );

  it('moves the recent boundary backward instead of orphaning Anthropic tool results', async () => {
    const service = new CompactionService();
    const result = await service.compact({
      messages: [
        { role: 'user', content: 'earlier request' },
        { role: 'assistant', content: 'earlier answer' },
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
        expect(transcript).toContain('earlier request');
        expect(transcript).not.toContain('inspect packages/example.ts');
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
    assertValidJsonArguments(result.messages);
  });

  it('prune-only compact never calls the summarizer even when the context remains large', async () => {
    const service = new CompactionService();
    const summarize = vi.fn(async () => FULL_SUMMARY);
    const result = await service.compact({
      messages: makeToolMessages(5),
      options: {
        force: true,
        aggressive: true,
        lightweightPrune: true,
        pruneOnly: true,
        contextWindowSize: 10,
      },
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.mode).toBe('pruned');
    expect(result.strategy).toBe('prune_only');
    expect(JSON.stringify(result.messages)).not.toContain('RAW_TOOL_RESULT_1');
  });

  it('forces an LLM summary after lightweight pruning when requested', async () => {
    const service = new CompactionService();
    const summarize = vi.fn(async () => FULL_SUMMARY);
    const result = await service.compact({
      messages: makeToolMessages(5),
      options: {
        force: true,
        aggressive: true,
        keepRecentRounds: 3,
        lightweightPrune: true,
        forceSummary: true,
        contextWindowSize: 100_000,
        pruneOnlyThresholdRatio: 0.3,
      },
      summarize,
    });

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.mode).toBe('summarized');
    expect(result.strategy).toBe('summary_with_recent');
    expect(JSON.stringify(result.messages)).toContain(COMPACT_SUMMARY_PREFIX);
  });

  it('strips opaque Responses encrypted reasoning during lightweight prune-only compact', async () => {
    const service = new CompactionService();
    const encryptedContent = 'A'.repeat(8_000);
    const messages = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect the project' },
          { type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${IMAGE_BASE64}` },
        ],
      },
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
    // Reasoning ciphertext must not survive compaction: replaying a stale chain
    // against rewritten tool results/media makes the model stall into
    // reasoning-only turns (committed as empty responses). Dropping it here lets
    // ResponsesClient stripUnusableResponseInputItems discard the item on replay.
    expect(JSON.stringify(result.messages)).not.toContain(encryptedContent);
    expect(JSON.stringify(result.messages)).not.toContain('"encrypted_content"');
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
    expect(result.strategy).toBe('summary_only_fallback');
    expect(result.summarizedCount).toBeGreaterThan(0);
    expect(result.keptCount).toBe(0);
    expect(summaryTranscript).toContain('read_file');
    expect(summaryTranscript).toContain('run_shell');
    expect(summaryTranscript).toContain('[Old tool result content cleared during compact]');
    expect(summaryTranscript).not.toContain('RAW_TOOL_RESULT_1');
    expect(summaryTranscript).not.toContain('RAW_RESPONSES_RESULT_1');
    expect(summaryTranscript).not.toContain(IMAGE_BASE64);
    expect(summaryTranscript).toContain('user request 5');
    expect(serialized).toContain(COMPACT_SUMMARY_PREFIX);
    expect(serialized).not.toContain('RAW_TOOL_RESULT_5');
    expect(serialized).not.toContain('RAW_RESPONSES_RESULT_5');
    expect(serialized).not.toContain(IMAGE_BASE64);
  });

  it('moves reduced recent rounds into the summary instead of silently dropping them', async () => {
    const service = new CompactionService();
    const transcripts: string[] = [];
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
        transcripts.push(transcript);
        return `<summary>\n${transcript}\n</summary>`;
      },
    });

    expect(result.strategy).toBe('summary_only_fallback');
    expect(result.keptCount).toBe(0);
    const finalTranscript = transcripts.at(-1) ?? '';
    for (let turn = 1; turn <= 5; turn++) {
      expect(finalTranscript).toContain(`user request ${turn}`);
    }
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

  it('does not report prune-only success when a short text session was not changed', async () => {
    const service = new CompactionService();

    await expect(
      service.compact({
        messages: [
          { role: 'user', content: 'only request' },
          { role: 'assistant', content: 'only answer' },
        ],
        options: { force: true, aggressive: true, lightweightPrune: true, contextWindowSize: 100_000 },
        summarize: async () => FULL_SUMMARY,
      }),
    ).rejects.toBeInstanceOf(CompactionNotNeededError);
  });

  it('keeps Chat Completions and Responses tool-call arguments as valid JSON during prune-only compact', async () => {
    const service = new CompactionService();
    const hugeArgs = JSON.stringify({ command: "python3 - <<'PY'\n" + 'print("x")\n'.repeat(400) + 'PY' });
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'check image' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${IMAGE_BASE64}` },
          },
        ],
      },
      {
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: 'fc_huge_0',
            type: 'function',
            function: {
              name: 'run_shell',
              arguments: hugeArgs,
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'fc_huge_0',
        content: `RAW_TOOL_RESULT: ${'z'.repeat(5_000)}`,
      },
      {
        type: 'function_call',
        call_id: 'responses-huge',
        name: 'run_shell',
        arguments: hugeArgs,
      },
      {
        type: 'function_call_output',
        call_id: 'responses-huge',
        output: `RAW_RESPONSES_RESULT: ${'y'.repeat(5_000)}`,
      },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'done' },
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
    assertValidJsonArguments(result.messages);

    const assistant = result.messages.find(
      (message) =>
        message &&
        typeof message === 'object' &&
        (message as Record<string, unknown>).role === 'assistant' &&
        Array.isArray((message as Record<string, unknown>).tool_calls),
    ) as Record<string, unknown>;
    const toolCalls = assistant.tool_calls as Array<Record<string, unknown>>;
    const chatArgs = (toolCalls[0]!.function as Record<string, unknown>).arguments as string;
    expect(JSON.parse(chatArgs)).toEqual({
      _truncated: true,
      note: 'tool arguments cleared during compact',
    });

    const functionCall = result.messages.find(
      (message) =>
        message && typeof message === 'object' && (message as Record<string, unknown>).type === 'function_call',
    ) as Record<string, unknown>;
    expect(JSON.parse(String(functionCall.arguments))).toEqual({
      _truncated: true,
      note: 'tool arguments cleared during compact',
    });

    const imageUser = result.messages.find((message) => {
      if (!message || typeof message !== 'object') return false;
      const content = (message as Record<string, unknown>).content;
      return (
        Array.isArray(content) &&
        content.some(
          (part) =>
            part &&
            typeof part === 'object' &&
            (part as Record<string, unknown>).type === 'text' &&
            (part as Record<string, unknown>).text === '[image omitted during compact]',
        )
      );
    }) as Record<string, unknown> | undefined;
    expect(imageUser).toBeTruthy();
    const content = imageUser!.content as Array<Record<string, unknown>>;
    expect(content.some((part) => part.type === 'image_url')).toBe(false);
    expect(JSON.stringify(result.messages)).not.toContain(IMAGE_BASE64);
    expect(JSON.stringify(result.messages)).not.toContain('[truncated:');
  });

  it('repairs already-corrupted tool-call arguments into valid JSON placeholders', async () => {
    const service = new CompactionService();
    const corrupted =
      '[truncated: original 9520 chars, kept about 4000 chars]\n--- head ---\n{"command":"echo hi"' + 'x'.repeat(5_000);
    const result = await service.compact({
      messages: [
        { role: 'user', content: 'fix corrupted history' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'fc_bad_0',
              type: 'function',
              function: { name: 'run_shell', arguments: corrupted },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'fc_bad_0', content: 'ok' },
        { role: 'user', content: 'next' },
        { role: 'assistant', content: 'done' },
      ],
      options: {
        force: true,
        aggressive: true,
        lightweightPrune: true,
        contextWindowSize: 100_000,
      },
      summarize: vi.fn(async () => FULL_SUMMARY),
    });

    assertValidJsonArguments(result.messages);
    const assistant = result.messages.find(
      (message) =>
        message &&
        typeof message === 'object' &&
        (message as Record<string, unknown>).role === 'assistant' &&
        Array.isArray((message as Record<string, unknown>).tool_calls),
    ) as Record<string, unknown>;
    const args = ((assistant.tool_calls as Array<Record<string, unknown>>)[0]!.function as Record<string, unknown>)
      .arguments as string;
    expect(JSON.parse(args)).toEqual({
      _truncated: true,
      note: 'tool arguments cleared during compact',
    });
  });

  it('prune-only compact replaces every tool-call argument with a valid JSON placeholder', async () => {
    const service = new CompactionService();
    const result = await service.compact({
      messages: makeToolMessages(3),
      options: { force: true, pruneOnly: true, lightweightPrune: true, contextWindowSize: 100_000 },
      summarize: vi.fn(async () => FULL_SUMMARY),
    });

    assertValidJsonArguments(result.messages);
    expect(result.mode).toBe('pruned');
    expect(result.strategy).toBe('prune_only');
    // 无论参数大小，快速压缩后所有工具参数都替换为合法 JSON 占位符
    expect(JSON.stringify(result.messages)).not.toContain('packages/example1.ts');
    expect(JSON.stringify(result.messages)).not.toContain('RAW_TOOL_RESULT');
    const parsedArgs = collectToolArguments(result.messages).map((args) => JSON.parse(args));
    expect(parsedArgs.length).toBeGreaterThan(0);
    for (const args of parsedArgs) {
      expect(args).toEqual({ _truncated: true, note: 'tool arguments cleared during compact' });
    }
  });

  it('keeps tool-call arguments valid when recent kept messages are aggressively compacted', async () => {
    const service = new CompactionService();
    const hugeArgs = JSON.stringify({ command: 'echo ' + 'x'.repeat(20_000) });
    const messages = [
      ...makeMessages(6),
      {
        role: 'user',
        content: 'run a large shell command',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'fc_recent_0',
            type: 'function',
            function: { name: 'run_shell', arguments: hugeArgs },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'fc_recent_0',
        content: 'done',
      },
      {
        role: 'assistant',
        content: 'finished recent tool call',
      },
    ];

    const result = await service.compact({
      messages,
      options: {
        force: true,
        aggressive: true,
        keepRecentRounds: 1,
        maxRecentTokens: 200,
      },
      summarize: async () => FULL_SUMMARY,
    });

    expect(result.mode).toBe('summarized');
    assertValidJsonArguments(result.messages);
    expect(JSON.stringify(result.messages)).not.toContain('[truncated:');
  });

  it('prune-only compact drops oldest rounds locally when only small messages remain', async () => {
    const service = new CompactionService();
    const summarize = vi.fn(async () => FULL_SUMMARY);
    const messages = makeSmallCleanMessages(100);
    const result = await service.compact({
      messages,
      options: { force: true, pruneOnly: true, lightweightPrune: true, contextWindowSize: 1_000_000 },
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.mode).toBe('pruned');
    expect(result.strategy).toBe('prune_only');
    expect(result.savedTokenEstimate).toBeGreaterThan(0);
    expect(result.savedRatio).toBeGreaterThan(0.5);
    expect(result.keptCount).toBeGreaterThan(0);
    expect(result.messages[0]).toMatchObject({ role: 'user' });
    expect(contentOf(result.messages[0])).toContain(COMPACT_BOUNDARY_PREFIX);
    expect(JSON.stringify(result.messages)).toContain('droppedRounds');
    // 旧轮次被本地丢弃，最近轮次保留，且 tool call/result 配对完整
    expect(JSON.stringify(result.messages)).toContain('user request 100');
    expect(JSON.stringify(result.messages)).not.toContain('user request 1 keep this round');
    const serialized = JSON.stringify(result.messages);
    for (const message of result.messages) {
      if (!message || typeof message !== 'object') continue;
      const toolCalls = (message as Record<string, unknown>).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (call && typeof call === 'object' && typeof (call as Record<string, string>).id === 'string') {
            expect(serialized).toContain((call as Record<string, string>).id);
          }
        }
      }
    }
  });

  it('prune-only compact still refuses tiny clean sessions with nothing meaningful to drop', async () => {
    const service = new CompactionService();
    const summarize = vi.fn(async () => FULL_SUMMARY);

    await expect(
      service.compact({
        messages: makeSmallCleanMessages(2),
        options: { force: true, pruneOnly: true, lightweightPrune: true, contextWindowSize: 1_000_000 },
        summarize,
      }),
    ).rejects.toBeInstanceOf(CompactionNotNeededError);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('tool-results-only compact aggregates every tool round into one placeholder pair', async () => {
    const service = new CompactionService();
    const summarize = vi.fn(async () => FULL_SUMMARY);
    const messages = [
      { role: 'user', content: 'keep user text' },
      {
        role: 'assistant',
        content: 'keep assistant text',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"packages/example.ts"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: `RAW_TOOL_RESULT: ${'x'.repeat(4_000)}`,
        toolUseResult: { stdout: 'RAW_NESTED_TOOL_RESULT' },
      },
      { type: 'function_call', call_id: 'rc-1', name: 'run_shell', arguments: '{"cmd":"ls packages"}' },
      { type: 'function_call_output', call_id: 'rc-1', output: `RAW_RESPONSES_OUTPUT: ${'y'.repeat(4_000)}` },
      { role: 'assistant', content: 'keep second assistant text' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'keep this image' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_BASE64 } },
        ],
      },
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, contextWindowSize: 100_000 },
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.mode).toBe('pruned');
    expect(result.strategy).toBe('tool_results_only');
    // 4 条工具消息（两个调用 + 两个结果）压成一对占位调用
    expect(result.toolCallsAggregated).toBe(2);
    expect(result.toolResultsReplaced).toBe(2);
    expect(result.beforeCount).toBe(messages.length);
    expect(result.afterCount).toBe(6);
    // 对话正文原样保留、顺序不变，工具过程只剩末尾那一对
    expect(contentOf(result.messages[0])).toBe('keep user text');
    expect(contentOf(result.messages[1])).toBe('keep assistant text');
    expect(contentOf(result.messages[2])).toBe('keep second assistant text');
    expect(result.messages[4]).toMatchObject({ type: 'function_call', call_id: 'mica_compact', arguments: '{}' });
    const note = String((result.messages[5] as { output: string }).output);
    expect(note.startsWith('[Mica compact]')).toBe(true);
    expect(note).toContain('Placeholder for 2 collapsed tool calls');
    // 说明里留下「跑过哪些工具、各几次」，否则模型会重跑一遍
    expect(note).toContain('read_file × 1');
    expect(note).toContain('run_shell × 1');
    const serialized = JSON.stringify(result.messages);
    expect(serialized).not.toContain('RAW_TOOL_RESULT');
    expect(serialized).not.toContain('RAW_RESPONSES_OUTPUT');
    // 没插入 checkpoint，媒体照旧被占位符顶掉
    expect(serialized).not.toContain(COMPACT_BOUNDARY_PREFIX);
    expect(serialized).not.toContain(COMPACT_SUMMARY_PREFIX);
    expect(serialized).not.toContain(IMAGE_BASE64);
    expect(serialized).toContain('keep this image');
    expect(result.mediaItemsReplaced).toBe(1);
  });

  it('names the placeholder call after the most used tool and counts repeats', async () => {
    const service = new CompactionService();
    const call = (callId: string, name: string, args: Record<string, unknown>) => [
      { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
      { type: 'function_call_output', call_id: callId, output: `RAW ${'y'.repeat(600)}` },
    ];
    const messages: unknown[] = [
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'c1', output: `RAW ${'y'.repeat(600)}` },
      ...call('c2', 'read_file', { path: 'b.ts' }),
      ...call('c3', 'read_file', { path: 'c.ts' }),
      ...call('c4', 'bash', { command: 'bun test' }),
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, contextWindowSize: 100_000 },
    });

    expect(result.messages).toHaveLength(2);
    // 次数最多的工具当占位调用的名字：模型看到的是自己真的有的工具
    expect(result.messages[0]).toMatchObject({ type: 'function_call', name: 'read_file', arguments: '{}' });
    const note = String((result.messages[1] as { output: string }).output);
    expect(note).toContain('Placeholder for 4 collapsed tool calls');
    expect(note).toContain('read_file × 3, bash × 1');
    // 参数不再进历史：写文件正文之类的负载随工具消息一起消失
    expect(JSON.stringify(result.messages)).not.toContain('b.ts');
  });

  it('collapses Chat Completions tool rounds without losing the assistant text', async () => {
    const service = new CompactionService();
    const messages: unknown[] = [
      { role: 'user', content: '把这两个文件读一下' },
      {
        role: 'assistant',
        content: '我先读一下。',
        tool_calls: [
          { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"packages/a.ts"}' } },
          { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"packages/b.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-a', content: `RAW_A: ${'x'.repeat(2_000)}` },
      { role: 'tool', tool_call_id: 'call-b', content: `RAW_B: ${'y'.repeat(2_000)}` },
      { role: 'assistant', content: '再看一下测试' },
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, contextWindowSize: 100_000 },
    });

    expect(result.toolCallsAggregated).toBe(2);
    expect(result.afterCount).toBe(5);
    // 正文从带 tool_calls 的那条里抽出来留在原位，占位调用补在压缩区末尾
    expect(result.messages[1]).toEqual({ role: 'assistant', content: '我先读一下。' });
    expect(result.messages[2]).toEqual({ role: 'assistant', content: '再看一下测试' });
    expect(result.messages[3]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'mica_compact', function: { name: 'read_file', arguments: '{}' } }],
    });
    expect(result.messages[4]).toMatchObject({ role: 'tool', tool_call_id: 'mica_compact' });
    expect(String((result.messages[4] as { content: string }).content)).toContain('read_file × 2');
    expect(JSON.stringify(result.messages)).not.toContain('RAW_A');
    expect(JSON.stringify(result.messages)).not.toContain('RAW_B');
  });

  it('drops an empty assistant message left behind by a collapsed Chat round', async () => {
    const service = new CompactionService();
    const messages: unknown[] = [
      { role: 'user', content: '跑一下测试' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'bash', arguments: '{"command":"bun test"}' } }],
      },
      { role: 'tool', tool_call_id: 'call-a', content: `RAW: ${'x'.repeat(2_000)}` },
      { role: 'assistant', content: '测试通过' },
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, contextWindowSize: 100_000 },
    });

    expect(result.afterCount).toBe(4);
    // 正文抽出来留在原位，占位调用落在压缩区末尾
    expect(result.messages.map((message) => (message as { role?: string }).role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'tool',
    ]);
    expect(result.messages[1]).toEqual({ role: 'assistant', content: '测试通过' });
    expect(result.messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'mica_compact' }] });
  });

  it('places the aggregate before the protected latest user message', async () => {
    const service = new CompactionService();
    const messages: unknown[] = [
      { role: 'user', content: '修一下 login 的报错' },
      { role: 'assistant', content: '我先看相关文件。' },
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'read_file',
        arguments: '{"path":"packages/auth/login.ts"}',
      },
      { type: 'function_call_output', call_id: 'c1', output: `RAW: ${'y'.repeat(2_000)}` },
      { role: 'assistant', content: '问题在 session 过期分支。' },
      { role: 'user', content: '顺便跑一下测试' },
      { role: 'assistant', content: '好的' },
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, preserveLatestUserMessage: true, contextWindowSize: 100_000 },
    });

    expect(result.messages.map((message) => (message as { role?: string }).role ?? (message as { type?: string }).type)).toEqual([
      'user',
      'assistant',
      'assistant',
      'function_call',
      'function_call_output',
      'user',
      'assistant',
    ]);
    // 当前轮（最新用户消息之后）一条都不动
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
    expect(result.messages[1]).toEqual(messages[1]);
    expect(result.messages[2]).toEqual(messages[4]);
  });

  it('tool-results-only compact preview keeps the original messages', async () => {
    const service = new CompactionService();
    const messages = makeToolMessages(2);

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, preview: true, contextWindowSize: 100_000 },
      summarize: async () => FULL_SUMMARY,
    });

    expect(result.preview).toBe(true);
    expect(result.messages).toEqual(messages);
    expect(result.toolCallsAggregated).toBeGreaterThan(0);
  });

  it('tool-results-only compact drops every thinking item inside the compressed zone', async () => {
    const service = new CompactionService();
    const reasoningText = 'r'.repeat(4_000);
    const messages: unknown[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'design an architecture' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: reasoningText }],
        encrypted_content: 'encrypted-chain',
      },
      { type: 'function_call', call_id: 'rc-1', name: 'run_shell', arguments: '{"cmd":"ls packages"}' },
      { type: 'function_call_output', call_id: 'rc-1', output: `RAW_RESPONSES_OUTPUT: ${'y'.repeat(2_000)}` },
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, contextWindowSize: 100_000 },
      summarize: async () => FULL_SUMMARY,
    });

    // 调用被聚合成一条后 call_id 全变了，reasoning 条目再留着就是无效引用，整条丢弃。
    expect(result.reasoningItemsDropped).toBe(1);
    expect(result.messages.some((message) => (message as { type?: string }).type === 'reasoning')).toBe(false);
    expect(result.beforeCount).toBe(4);
    // 用户消息 + 一对占位调用
    expect(result.afterCount).toBe(3);
    expect(result.savedTokenEstimate).toBeGreaterThan(Math.ceil(reasoningText.length / 4));
  });

  it('strips Chat reasoning_content inside the compressed zone', async () => {
    const service = new CompactionService();
    const messages: unknown[] = [
      { role: 'user', content: '看看这个报错' },
      { role: 'assistant', content: '我先想一下', reasoning_content: 'THINKING_SHOULD_NOT_SURVIVE' },
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, contextWindowSize: 100_000 },
    });

    expect(result.reasoningItemsDropped).toBe(1);
    expect(JSON.stringify(result.messages)).not.toContain('THINKING_SHOULD_NOT_SURVIVE');
    expect(result.messages[1]).toEqual({ role: 'assistant', content: '我先想一下' });
  });

  it('is idempotent: a second pass over an aggregated history changes nothing', async () => {
    const service = new CompactionService();
    const messages: unknown[] = [
      { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'c1', output: `RAW ${'y'.repeat(600)}` },
      { type: 'function_call', call_id: 'c2', name: 'bash', arguments: '{"command":"bun test"}' },
      { type: 'function_call_output', call_id: 'c2', output: `RAW ${'y'.repeat(600)}` },
    ];

    const first = await service.compact({ messages, options: { toolResultsOnly: true, contextWindowSize: 100_000 } });
    expect(first.messages).toHaveLength(2);

    await expect(
      service.compact({ messages: first.messages, options: { toolResultsOnly: true, contextWindowSize: 100_000 } }),
    ).rejects.toBeInstanceOf(CompactionNotNeededError);
    // 占位调用的 call_id 与说明文本稳定：重复压缩不会让 prompt cache 前缀漂移
    expect(first.messages[0]).toMatchObject({ call_id: 'mica_compact' });
    expect(String((first.messages[1] as { output: string }).output)).toContain('bash × 1, read_file × 1');
  });

  it('merges newly collapsed calls into an aggregate left by an earlier pass', async () => {
    const service = new CompactionService();
    const aggregated: unknown[] = [
      { type: 'function_call', call_id: 'mica_compact', name: 'read_file', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'mica_compact',
        output:
          '[Mica compact] Placeholder for 2 collapsed tool calls (not a real result): read_file × 2. Outputs cleared; re-run or re-read if needed.',
      },
    ];
    const messages: unknown[] = [
      ...aggregated,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '接着来' }] },
      { type: 'function_call', call_id: 'c9', name: 'bash', arguments: '{"command":"bun test"}' },
      { type: 'function_call_output', call_id: 'c9', output: `RAW ${'y'.repeat(600)}` },
    ];

    const result = await service.compact({
      messages,
      options: { toolResultsOnly: true, contextWindowSize: 100_000 },
    });

    expect(result.toolCallsAggregated).toBe(1);
    expect(result.afterCount).toBe(3);
    const note = String((result.messages[2] as { output: string }).output);
    expect(note).toContain('Placeholder for 3 collapsed tool calls');
    expect(note).toContain('read_file × 2, bash × 1');
  });

  // 手动「模型压缩」把对话交给模型，工具过程不进摘要输入：它占九成篇幅却不进结论。
  it('sends only the user and assistant dialogue when summaryInput is dialogue', async () => {
    const service = new CompactionService();
    const messages: unknown[] = [
      { role: 'user', content: 'user request 1' },
      {
        role: 'assistant',
        content: 'assistant answer 1',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"vite.config.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'TOOL_OUTPUT_SHOULD_NOT_APPEAR' },
      { role: 'assistant', content: '', reasoning_content: 'THINKING_SHOULD_NOT_APPEAR' },
      // 历史要明显大于摘要本身，否则「压完不省」的守卫会先拦下来——这条用例测的是
      // 摘要输入只含对话，不是节省量。
      ...makeMessages(40, 1),
    ];
    let transcript = '';

    await service.compact({
      messages,
      options: { summaryInput: 'dialogue', keepRecentRounds: 2 },
      summarize: async (text) => {
        transcript = text;
        return FULL_SUMMARY;
      },
    });

    expect(transcript).toContain('用户：user request 1');
    expect(transcript).toContain('模型：\nassistant answer 1');
    expect(transcript).not.toContain('TOOL_OUTPUT_SHOULD_NOT_APPEAR');
    expect(transcript).not.toContain('THINKING_SHOULD_NOT_APPEAR');
    expect(transcript).not.toContain('read_file');
    expect(transcript).not.toContain('工具调用');
    expect(transcript).not.toContain('工具结果');
  });
});

function makeMessages(rounds: number, offset = 0): unknown[] {
  return Array.from({ length: rounds }, (_, index) => index + 1 + offset).flatMap((turn) => [
    { role: 'user', content: `user request ${turn}` },
    { role: 'assistant', content: `assistant answer ${turn}\nfile packages/example${turn}.ts` },
  ]);
}

// 大量小消息、无单条内可清理内容（工具结果已是占位符），模拟长会话的
// "消息数量大但每条都小" 场景——旧实现会误报"暂无可快速清理内容"。
function makeSmallCleanMessages(rounds: number): unknown[] {
  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((turn) => [
    { role: 'user', content: `user request ${turn} keep this round` },
    {
      role: 'assistant',
      content: `assistant answer ${turn} with a moderately long recap of findings and the next step`,
      tool_calls: [
        {
          id: `call-${turn}`,
          type: 'function',
          function: { name: 'grep_search', arguments: `{"pattern":"needle_${turn}","path":"src"}` },
        },
      ],
    },
    { role: 'tool', tool_call_id: `call-${turn}`, content: '[Old tool result content cleared during compact]' },
    {
      type: 'function_call',
      call_id: `rc-${turn}`,
      name: 'run_shell',
      arguments: `{"cmd":"rg needle_${turn}"}`,
    },
    { type: 'function_call_output', call_id: `rc-${turn}`, output: '[Old tool result content cleared during compact]' },
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

function collectToolArguments(messages: unknown[]): string[] {
  const args: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (Array.isArray(record.tool_calls)) {
      for (const toolCall of record.tool_calls) {
        if (!toolCall || typeof toolCall !== 'object') continue;
        const fn = (toolCall as Record<string, unknown>).function;
        if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).arguments === 'string') {
          args.push((fn as Record<string, string>).arguments);
        }
      }
    }
    if (record.type === 'function_call' && typeof record.arguments === 'string') {
      args.push(record.arguments);
    }
  }
  return args;
}

function assertValidJsonArguments(messages: unknown[]) {
  for (const value of collectToolArguments(messages)) {
    expect(() => JSON.parse(value)).not.toThrow();
    expect(value).not.toContain('[truncated:');
    expect(value).not.toContain('--- head ---');
  }
}

function contentOf(message: unknown): string {
  return typeof message === 'object' && message ? String((message as Record<string, unknown>).content ?? '') : '';
}

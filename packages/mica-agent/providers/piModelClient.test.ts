import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent, Message, ToolCall, Usage } from '@earendil-works/pi-ai';
import { micaConfig } from '@packages/mica-config/index.js';
import { MicaTool, micaTools, type ToolInput, type ToolResult } from '@packages/mica-tools/index.js';
import { AgentMaxTurnsError } from '../core/Agent.js';
import { PiModelClient } from './PiModelClient.js';
import { streamPiRequest, type PiRequest } from './piTransport.js';
import type { ModelClientOptions } from './types.js';

vi.mock('./piTransport.js', async (original) => ({
  ...(await original<typeof import('./piTransport.js')>()),
  streamPiRequest: vi.fn(),
}));
type Script = (request: PiRequest) => AsyncIterable<AssistantMessageEvent>;
const scripts: Script[] = [];
const requests: Array<{ context: PiRequest['context']; reasoning: PiRequest['reasoning'] }> = [];
const registered: MicaTool[] = [];
const disposers: Array<() => void> = [];
beforeEach(() => {
  scripts.length = 0;
  requests.length = 0;
  vi.mocked(streamPiRequest)
    .mockReset()
    .mockImplementation((request) => {
      requests.push(structuredClone({ context: request.context, reasoning: request.reasoning }));
      request.onPayload({ messages: request.context.messages, tools: request.context.tools });
      const script = scripts.shift();
      if (!script) throw new Error('Unexpected model request');
      return script(request);
    });
});
afterEach(() => {
  for (const entry of registered.splice(0)) micaTools.unregisterRuntime(entry);
  while (disposers.length) disposers.pop()?.();
  micaConfig.resetRejectedEffortLevels();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pi tool iterations', () => {
  it('runs reads concurrently, keeps a write barrier and returns results in call order', async () => {
    const events: string[] = [];
    const gate = rendezvous(2);
    tool('read_a', true, async () => {
      events.push('a:start');
      await gate();
      events.push('a:end');
      return 'A';
    });
    tool('read_b', true, async () => {
      events.push('b:start');
      await gate();
      events.push('b:end');
      return 'B';
    });
    tool('write_probe', false, async () => {
      events.push('write');
      return 'W';
    });
    tool('read_c', true, async () => {
      events.push('c');
      return 'C';
    });
    scripts.push(
      () => completed([call('a', 'read_a'), call('b', 'read_b'), call('w', 'write_probe'), call('c', 'read_c')]),
      () => text('done'),
    );
    const client = new PiModelClient(options());
    client.onToolCall = vi.fn();
    client.onToolResult = vi.fn();
    await expect(client.query('read then write')).resolves.toBe('done');
    expect(events.slice(0, 2)).toEqual(['a:start', 'b:start']);
    expect(events.slice(2, 4).sort()).toEqual(['a:end', 'b:end']);
    expect(events.slice(4)).toEqual(['write', 'c']);
    expect(client.onToolCall).toHaveBeenCalledTimes(4);
    expect(client.onToolResult).toHaveBeenCalledTimes(4);
    expect(
      requests[1]!.context.messages.filter((m) => m.role === 'toolResult').map((m) => [m.toolCallId, m.content]),
    ).toEqual([
      ['a', [{ type: 'text', text: 'A' }]],
      ['b', [{ type: 'text', text: 'B' }]],
      ['w', [{ type: 'text', text: 'W' }]],
      ['c', [{ type: 'text', text: 'C' }]],
    ]);
  });
  it('overlaps a wait with the following write through the model loop', async () => {
    const gate = rendezvous(2);
    const events: string[] = [];
    tool(
      'wait_probe',
      false,
      async () => {
        events.push('wait');
        await gate();
        return 'waited';
      },
      true,
    );
    tool('write_probe', false, async () => {
      events.push('write');
      await gate();
      return 'written';
    });
    scripts.push(
      () => completed([call('wait', 'wait_probe'), call('write', 'write_probe')]),
      () => text('done'),
    );
    await expect(new PiModelClient(options()).query('wait and write')).resolves.toBe('done');
    expect(events).toEqual(['wait', 'write']);
  });
  it('does not execute invalid arguments and still executes the following valid call', async () => {
    const execute = vi.fn(async () => 'valid');
    tool('probe', true, execute);
    scripts.push(
      () => completed([{ ...call('bad', 'probe'), argumentsError: 'Expected a JSON object' }, call('good', 'probe')]),
      () => text('done'),
    );
    await new PiModelClient(options()).query('run');
    expect(execute).toHaveBeenCalledTimes(1);
    const results = requests[1]!.context.messages.filter((m) => m.role === 'toolResult');
    expect(results[0]).toMatchObject({ toolCallId: 'bad', isError: true });
    expect(results[1]).toMatchObject({
      toolCallId: 'good',
      isError: false,
      content: [{ type: 'text', text: 'valid' }],
    });
  });
  it('never executes incomplete calls after the output limit', async () => {
    const execute = vi.fn(async () => 'written');
    tool('write_probe', false, execute);
    scripts.push(() => completed([call('truncated', 'write_probe')], { stopReason: 'length' }));
    const client = new PiModelClient(options());
    await expect(client.query('write')).rejects.toThrow('incomplete tool calls');
    expect(execute).not.toHaveBeenCalled();
    expect(client.messages).toEqual([]);
  });
  it('keeps multimodal tool results in pi history and images out of text callbacks', async () => {
    tool('read_image_probe', true, async () => [
      { type: 'text', text: 'screenshot' },
      { type: 'image', source: { type: 'base64', data: 'aW1hZ2U=', media_type: 'image/png' } },
    ]);
    scripts.push(
      () => completed([call('image', 'read_image_probe')]),
      () => text('done'),
    );
    const client = new PiModelClient(options());
    client.onToolResult = vi.fn();
    await client.query('inspect');
    expect(requests[1]!.context.messages.find((m) => m.role === 'toolResult')).toMatchObject({
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ],
    });
    expect(client.onToolResult).toHaveBeenCalledWith('read_image_probe', 'screenshot', 'image');
    expect(JSON.stringify(client.toConversationMessages())).not.toContain('aW1hZ2U=');
  });
});

describe('pi iteration boundaries', () => {
  it('appends queued input after the whole tool batch with the baseline prefix intact', async () => {
    tool('probe', true, async () => 'result');
    scripts.push(
      () => completed([call('first', 'probe'), call('second', 'probe')]),
      () => text('done'),
    );
    const client = new PiModelClient(options());
    const baseline: Message[] = [
      { role: 'user', content: 'earlier', timestamp: 1 },
      assistant([{ type: 'text', text: 'earlier answer' }]),
    ];
    client.loadSnapshot({ ...client.getSnapshot(), messages: baseline });
    const iteration = vi.fn(() => 'queued');
    const rewrite = vi.fn((_messages: unknown[]) => null);
    await client.query('current', { onIterationComplete: iteration, rewriteIterationMessages: rewrite });
    expect(requests[1]!.context.messages.slice(0, 3)).toEqual(requests[0]!.context.messages);
    expect(requests[1]!.context.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'toolResult',
      'toolResult',
      'user',
    ]);
    expect(requests[1]!.context.messages.at(-1)).toMatchObject({ role: 'user', content: 'queued' });
    expect(iteration).toHaveBeenCalledTimes(1);
    expect(rewrite).toHaveBeenCalledTimes(2);
    expect(rewrite.mock.calls[0]![0].some((m) => (m as Message).role === 'system')).toBe(false);
  });
  it('uses rewritten pi history for the next request and keeps system instructions', async () => {
    tool('probe', true, async () => 'result');
    scripts.push(
      () => completed([call('first', 'probe')]),
      () => text('done'),
    );
    const replacement: Message[] = [{ role: 'user', content: 'compacted with queued input', timestamp: 2 }];
    const rewrite = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(replacement);
    const client = new PiModelClient(options());
    await client.query('current', { rewriteIterationMessages: rewrite, onIterationComplete: () => 'queued' });
    expect(rewrite.mock.calls[1]![0].at(-1)).toMatchObject({ content: 'queued' });
    expect(requests[1]!.context.messages).toEqual([replacement[0]]);
    expect(requests.map((r) => r.context.systemPrompt)).toEqual(['system prompt', 'system prompt']);
    expect(client.messages[0]).toEqual(replacement[0]);
  });
  it('sends no request when an asynchronous rewrite is cancelled', async () => {
    const controller = new AbortController();
    const start = vi.fn();
    const end = vi.fn();
    await expect(
      new PiModelClient(options()).query('current', {
        signal: controller.signal,
        rewriteIterationMessages: async () => {
          controller.abort();
          return [];
        },
        onRequestStart: start,
        onRequestEnd: end,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(streamPiRequest).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
  it('enforces maxTurns before another rewrite or request and retains a tool checkpoint', async () => {
    tool('probe', false, async () => 'written');
    scripts.push(() => completed([call('one', 'probe')]));
    const rewrite = vi.fn(() => null);
    const start = vi.fn();
    const end = vi.fn();
    const client = new PiModelClient(options());
    await expect(
      client.query('write', {
        maxTurns: 1,
        rewriteIterationMessages: rewrite,
        onRequestStart: start,
        onRequestEnd: end,
      }),
    ).rejects.toBeInstanceOf(AgentMaxTurnsError);
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(client.messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'one' });
  });
  it('snapshots filtered tools once per logical request including retries', async () => {
    vi.useFakeTimers();
    tool('allowed', true, async () => 'allowed');
    tool('hidden', true, async () => 'hidden');
    scripts.push(
      async function* () {
        throw httpError(503);
      },
      () => text('done'),
    );
    const start = vi.fn();
    const end = vi.fn();
    const client = new PiModelClient({ ...options(), toolFilter: (name) => name === 'allowed' });
    const query = client.query('current', { onRequestStart: start, onRequestEnd: end });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(query).resolves.toBe('done');
    expect(requests[0]!.context.tools?.map((definition) => definition.name)).toEqual(['allowed']);
    expect(requests[1]!.context.tools).toEqual(requests[0]!.context.tools);
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', attempts: 2 }));
  });
});

describe('pi abort and snapshots', () => {
  it('rejects an SDK stream that swallows abort without committing an empty assistant', async () => {
    const controller = new AbortController();
    scripts.push(async function* () {
      controller.abort();
      yield { type: 'done', reason: 'stop', message: assistant([]) };
    });
    const client = new PiModelClient(options());
    const start = vi.fn();
    const end = vi.fn();
    await expect(
      client.query('question', { signal: controller.signal, onRequestStart: start, onRequestEnd: end }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.messages).toEqual([]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'aborted' }));
  });
  it('preserves a question exactly once after abort before any checkpoint', async () => {
    scripts.push(async function* () {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const client = new PiModelClient(options());
    await expect(client.query('question')).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.preserveAbortedTurn('question')).toBe(false);
    expect(client.preserveAbortedTurn('question')).toBe(true);
    expect(client.messages).toMatchObject([{ role: 'user', content: 'question' }]);
  });
  it('never repeats a committed question or tools when a later request is aborted', async () => {
    tool('probe', false, async () => 'written');
    scripts.push(
      () => completed([call('write', 'probe')]),
      async function* () {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      },
    );
    const client = new PiModelClient(options());
    await expect(client.query('question')).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.preserveAbortedTurn('question', 'partial answer')).toBe(true);
    expect(client.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(client.messages.filter((m) => m.role === 'toolResult')).toHaveLength(1);
    expect(client.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
    });
  });
  it('resets the committed marker on restore and skips unused conversation projection', async () => {
    scripts.push(() => text('done'));
    const client = new PiModelClient(options());
    const initial = client.getSnapshot({ includeConversation: false });
    expect(initial.messageFormat).toBe('pi-ai-v1');
    await client.query('old question');
    client.loadSnapshot(initial);
    expect(client.preserveAbortedTurn('new question')).toBe(false);
    const projection = vi.spyOn(client, 'toConversationMessages').mockImplementation(() => {
      throw new Error('unused');
    });
    expect(client.getSnapshot({ includeConversation: false }).conversationMessages).toEqual([]);
    expect(projection).not.toHaveBeenCalled();
  });
  it('recognises an uncommitted image prompt whose block order the migration changed', () => {
    const client = new PiModelClient(options());
    // 迁移写出的图片块是 `mimeType` 在前，新建输入是 `data` 在前：同一张图不能因为
    // 字段顺序被当成「新的一问」再追加一条。
    client.loadSnapshot({
      ...client.getSnapshot(),
      messages: [
        {
          role: 'user',
          timestamp: 1,
          content: [
            { type: 'text', text: 'inspect' },
            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
          ],
        },
      ],
    });
    expect(
      client.preserveAbortedTurn([
        { type: 'text', text: 'inspect' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]),
    ).toBe(true);
    expect(client.messages).toHaveLength(1);
  });

  it('recognises a quick-compacted image prompt as the same question', () => {
    const client = new PiModelClient(options());
    client.loadSnapshot({
      ...client.getSnapshot(),
      messages: [
        {
          role: 'user',
          timestamp: 1,
          content: [
            { type: 'text', text: 'inspect [Image](/tmp/a.png)' },
            { type: 'text', text: '[image omitted during compact]' },
          ],
        },
      ],
    });
    expect(
      client.preserveAbortedTurn([
        { type: 'text', text: 'inspect [Image](/tmp/a.png)' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]),
    ).toBe(true);
    expect(client.messages).toHaveLength(1);
  });

  it('rejects nonempty history without the pi format', () => {
    const client = new PiModelClient(options());
    expect(() =>
      client.loadSnapshot({
        ...client.getSnapshot(),
        messageFormat: undefined,
        messages: [{ role: 'user', content: 'old', timestamp: 1 }],
      }),
    ).toThrow('不再支持');
  });
});

describe('pi retries and display rollback', () => {
  it.each([400, 401, 422])('does not retry deterministic HTTP %s errors', async (status) => {
    scripts.push(async function* () {
      throw httpError(status);
    });
    const start = vi.fn();
    const end = vi.fn();
    await expect(
      new PiModelClient(options()).query('question', { onRequestStart: start, onRequestEnd: end }),
    ).rejects.toMatchObject({ status });
    expect(requests).toHaveLength(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', attempts: 1 }));
  });
  it('streams partial output immediately and never repeats it without rollback', async () => {
    const client = new PiModelClient(options());
    client.onText = vi.fn();
    scripts.push(async function* () {
      yield textDelta('partial');
      expect(client.onText).toHaveBeenCalledWith('partial');
      throw httpError(503);
    });
    await expect(client.query('question')).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(1);
    expect(client.onText).toHaveBeenCalledTimes(1);
    expect(client.messages).toEqual([]);
  });
  it('rolls back only the later failed request preserving prior text and a completed write', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => 'written');
    tool('write_probe', false, execute);
    scripts.push(
      async function* () {
        yield textDelta('before');
        yield* completed([{ type: 'text', text: 'before' }, call('w', 'write_probe')]);
      },
      async function* () {
        yield textDelta('discard');
        throw httpError(503);
      },
      () => text('after'),
    );
    const client = new PiModelClient(options());
    let display = '';
    let checkpoint = '';
    client.onText = (delta) => {
      display += delta;
    };
    client.onTextAttemptStart = vi.fn(() => {
      checkpoint = display;
    });
    client.onTextRollback = vi.fn(() => {
      display = checkpoint;
    });
    const query = client.query('question');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(query).resolves.toBe('before\n\nafter');
    expect(display).toBe('before\n\nafter');
    expect(client.onTextAttemptStart).toHaveBeenCalledTimes(3);
    expect(client.onTextRollback).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests[2]!.context.messages).toEqual(requests[1]!.context.messages);
    expect(JSON.stringify(client.messages)).not.toContain('discard');
  });
  it.each([false, true])(
    'requires thinking rollback support to retry thinking output: %s',
    async (canRollbackThinking) => {
      vi.useFakeTimers();
      scripts.push(
        async function* () {
          yield thinkingDelta('failed thought');
          throw httpError(503);
        },
        () => text('done'),
      );
      const client = new PiModelClient(options());
      client.onTextAttemptStart = vi.fn();
      client.onTextRollback = vi.fn();
      client.canRollbackThinking = canRollbackThinking;
      const result = client.query('question').then(
        (value) => ({ value }),
        (error: Error) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      if (canRollbackThinking) {
        expect(await result).toEqual({ value: 'done' });
        expect(client.onTextRollback).toHaveBeenCalledTimes(1);
      } else {
        expect(await result).toMatchObject({ error: { status: 503 } });
        expect(requests).toHaveLength(1);
      }
    },
  );
  it('aborts retry backoff immediately', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    scripts.push(async function* () {
      throw httpError(503);
    });
    const retry = vi.fn(() => controller.abort());
    await expect(
      new PiModelClient(options()).query('question', { signal: controller.signal, onRetry: retry }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });
});

describe('pi thinking and usage', () => {
  it('checkpoints complete thinking parts and requests and separates later thinking', async () => {
    tool('probe', true, async () => 'read');
    scripts.push(
      async function* () {
        yield thinkingDelta('first');
        yield {
          type: 'thinking_end',
          contentIndex: 0,
          content: 'first',
          partial: assistant([{ type: 'thinking', thinking: 'first' }]),
        };
        yield* completed([{ type: 'thinking', thinking: 'first', thinkingSignature: 'signed' }, call('read', 'probe')]);
      },
      async function* () {
        yield thinkingDelta('second');
        yield { type: 'thinking_end', contentIndex: 0, content: 'second', partial: assistant([]) };
        yield* text('done');
      },
    );
    const client = new PiModelClient(options());
    const events: string[] = [];
    client.onThinking = (delta) => events.push(delta);
    client.onThinkingCheckpoint = (boundary) => events.push(`checkpoint:${boundary}`);
    await client.query('question');
    expect(events).toEqual([
      'first',
      'checkpoint:part',
      'checkpoint:request',
      '\n\n',
      'second',
      'checkpoint:part',
      'checkpoint:request',
    ]);
    expect(requests[1]!.context.messages.find((m) => m.role === 'assistant')).toMatchObject({
      content: [{ thinkingSignature: 'signed' }, { id: 'read' }],
    });
  });
  it('does not checkpoint a thinking part when displaying its delta aborts', async () => {
    const controller = new AbortController();
    scripts.push(async function* () {
      yield thinkingDelta('interrupted');
      yield { type: 'thinking_end', contentIndex: 0, content: 'interrupted', partial: assistant([]) };
      yield* completed([]);
    });
    const client = new PiModelClient(options());
    client.onThinking = () => controller.abort();
    client.onThinkingCheckpoint = vi.fn();
    await expect(client.query('question', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.onThinkingCheckpoint).not.toHaveBeenCalled();
    expect(client.messages).toEqual([]);
  });
  it('restores cached/written input, counts reasoning within output and uses the response model', async () => {
    scripts.push(() =>
      text('done', {
        responseModel: 'actual-model',
        usage: usage({ input: 20, cacheRead: 50, cacheWrite: 10, output: 12, reasoning: 7, totalTokens: 92 }),
      }),
    );
    const client = new PiModelClient(options());
    client.onUsage = vi.fn();
    await client.query('question');
    expect(client.lastUsage).toMatchObject({
      model: 'actual-model',
      inputTokens: 80,
      cachedInputTokens: 50,
      outputTokens: 12,
      totalTokens: 92,
      paidTokenRate: 42 / 92,
      turnId: 1,
      requestIndex: 1,
    });
    expect(client.onUsage).toHaveBeenCalledTimes(1);
  });
  it('measures final-attempt latency and body generation without hidden reasoning tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
    const first = 'body text '.repeat(20);
    const last = 'more body text '.repeat(20);
    scripts.push(
      async function* () {
        advance(100);
        throw httpError(503);
      },
      async function* (request) {
        request.onGenerationMetadata({ reasoningTokens: 40, hasOtherOutput: false });
        advance(20);
        yield thinkingDelta('thought');
        advance(1000);
        yield textDelta(first);
        advance(600);
        yield textDelta(last);
        advance(100);
        yield* completed([{ type: 'text', text: first + last }], {
          usage: usage({ input: 2, output: 104, reasoning: 40, totalTokens: 106 }),
        });
      },
    );
    const client = new PiModelClient(options());
    const query = client.query('question');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(query).resolves.toBe(first + last);
    expect(client.lastUsage).toMatchObject({
      firstTokenMs: 20,
      responseWaitMs: 2120,
      durationMs: 3820,
      generationDurationMs: 600,
      generationOutputTokens: 63,
      outputTokens: 104,
    });
  });
  it('ignores observer errors and pairs start/end around output', async () => {
    scripts.push(() => text('done'));
    const events: string[] = [];
    const client = new PiModelClient(options());
    client.onText = () => events.push('text');
    await expect(
      client.query('question', {
        onRequestStart: () => {
          events.push('start');
          throw new Error('observer');
        },
        onRequestEnd: () => {
          events.push('end');
          throw new Error('observer');
        },
      }),
    ).resolves.toBe('done');
    expect(events).toEqual(['start', 'text', 'end']);
  });
});

function options(): ModelClientOptions {
  return {
    model: 'pi-loop-model',
    provider: { id: 'pi-loop', protocol: 'openai_responses', api_base: 'http://127.0.0.1:1/v1' },
    apiKey: 'test-key',
    systemPrompt: 'system prompt',
  };
}
function usage(patch: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...patch,
  };
}
function assistant(content: AssistantMessage['content'], patch: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-responses',
    model: 'pi-loop-model',
    provider: 'pi-loop',
    timestamp: 1,
    usage: usage(),
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    content,
    ...patch,
  };
}
async function* completed(
  content: AssistantMessage['content'],
  patch: Partial<AssistantMessage> = {},
): AsyncGenerator<AssistantMessageEvent> {
  const message = assistant(content, patch);
  yield { type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message };
}
async function* text(value: string, patch: Partial<AssistantMessage> = {}): AsyncGenerator<AssistantMessageEvent> {
  yield textDelta(value);
  yield* completed([{ type: 'text', text: value }], patch);
}
function textDelta(delta: string): AssistantMessageEvent {
  return { type: 'text_delta', contentIndex: 0, delta, partial: assistant([{ type: 'text', text: delta }]) };
}
function thinkingDelta(delta: string): AssistantMessageEvent {
  return {
    type: 'thinking_delta',
    contentIndex: 0,
    delta,
    partial: assistant([{ type: 'thinking', thinking: delta }]),
  };
}
function call(id: string, name: string): ToolCall {
  return { type: 'toolCall', id, name, arguments: {} };
}
function httpError(status: number): Error {
  return Object.assign(new Error(`${status} provider error`), { status });
}
function rendezvous(count: number): () => Promise<void> {
  let started = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++started === count) release();
    await ready;
  };
}
function tool(
  name: string,
  readOnly: boolean,
  execute: (input: ToolInput) => Promise<ToolResult>,
  overlappable = false,
  canOverlap?: (input: ToolInput) => boolean,
): void {
  class ProbeTool extends MicaTool {
    constructor() {
      super(name, 'pi loop probe', { type: 'object', properties: {} }, { readOnly, overlappable });
    }
    async execute(input: ToolInput) {
      return await execute(input);
    }
    override canOverlap(input: ToolInput) {
      return canOverlap?.(input) ?? super.canOverlap(input);
    }
    onToolUseDisplayText() {
      return name;
    }
  }
  const instance = new ProbeTool();
  registered.push(instance);
  micaTools.registerRuntime(instance);
}

describe('pi timeout and terminal guards', () => {
  it('closes a stalled stream and retries before any output', async () => {
    vi.useFakeTimers();
    let closed = false;
    scripts.push(
      () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}),
            return: async () => {
              closed = true;
              return { done: true, value: undefined };
            },
          };
        },
      }),
      () => text('after timeout'),
    );
    const query = new PiModelClient(options()).query('question');
    await vi.advanceTimersByTimeAsync(62_000);
    await expect(query).resolves.toBe('after timeout');
    expect(closed).toBe(true);
    expect(requests).toHaveLength(2);
  });
  it('does not retry a stalled stream after visible output without rollback', async () => {
    vi.useFakeTimers();
    scripts.push(async function* () {
      yield textDelta('partial');
      await new Promise<void>(() => {});
    });
    const client = new PiModelClient(options());
    const result = client.query('question').catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(requests).toHaveLength(1);
    expect(client.messages).toEqual([]);
  });
  it('aborts promptly while waiting for a silent SDK stream', async () => {
    scripts.push(async function* () {
      await new Promise<void>(() => {});
    });
    const controller = new AbortController();
    const end = vi.fn();
    const query = new PiModelClient(options()).query('question', { signal: controller.signal, onRequestEnd: end });
    controller.abort();
    await expect(query).rejects.toMatchObject({ name: 'AbortError' });
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('does not commit a completely empty assistant response', async () => {
    scripts.push(() => completed([]));
    const client = new PiModelClient(options());
    await expect(client.query('question')).resolves.toBe('');
    expect(client.messages.filter((m) => m.role === 'assistant')).toEqual([]);
  });
  it('retains thinking signatures without creating an empty text message', async () => {
    scripts.push(() => completed([{ type: 'thinking', thinking: 'only thinking', thinkingSignature: 'signature' }]));
    const client = new PiModelClient(options());
    await expect(client.query('question')).resolves.toBe('');
    expect(client.messages.filter((m) => m.role === 'assistant')).toMatchObject([
      { content: [{ type: 'thinking', thinkingSignature: 'signature' }] },
    ]);
    expect(client.toConversationMessages()).toEqual([{ role: 'user', content: 'question' }]);
  });
});

describe('pi Agent scheduling regressions', () => {
  it.each(['await', 'join'])(
    'keeps Agent runs concurrent across %s and waits before a following write',
    async (operation) => {
      const gate = rendezvous(2);
      const events: string[] = [];
      tool(
        'agent',
        false,
        async (input) => {
          events.push(`start:${input.operation}`);
          if (input.operation === 'run') await gate();
          events.push(`end:${input.operation}`);
          return 'agent result';
        },
        false,
        (input) => input.operation === 'await' || input.operation === 'join',
      );
      tool('write_probe', false, async () => {
        events.push('write');
        return 'written';
      });
      scripts.push(
        () =>
          completed([
            { ...call('run_a', 'agent'), arguments: { operation: 'run' } },
            { ...call('wait', 'agent'), arguments: { operation } },
            { ...call('run_b', 'agent'), arguments: { operation: 'run' } },
            call('write', 'write_probe'),
          ]),
        () => text('done'),
      );
      await expect(new PiModelClient(options()).query('delegate and write')).resolves.toBe('done');
      expect(events.filter((event) => event === 'end:run')).toHaveLength(2);
      expect(events.at(-1)).toBe('write');
    },
  );
  it.each(['await', 'join'])('overlaps agent %s after a read batch with the next write', async (operation) => {
    const gate = rendezvous(2);
    const events: string[] = [];
    tool('read_probe', true, async () => {
      events.push('read');
      return 'read';
    });
    tool(
      'agent',
      false,
      async () => {
        events.push('agent');
        await gate();
        return 'joined';
      },
      false,
      (input) => input.operation === operation,
    );
    tool('write_probe', false, async () => {
      events.push('write');
      await gate();
      return 'written';
    });
    scripts.push(
      () =>
        completed([
          call('read', 'read_probe'),
          { ...call('agent', 'agent'), arguments: { operation } },
          call('write', 'write_probe'),
        ]),
      () => text('done'),
    );
    await new PiModelClient(options()).query('wait while writing');
    expect(events).toEqual(['read', 'agent', 'write']);
    expect(requests[1]!.context.messages.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId)).toEqual([
      'read',
      'agent',
      'write',
    ]);
  });
});

describe('pi thinking completion regressions', () => {
  it('renders done-only thinking and a completed suffix once before checkpoints', async () => {
    scripts.push(async function* () {
      yield thinkingDelta('first');
      yield { type: 'thinking_end', contentIndex: 0, content: 'first suffix', partial: assistant([]) };
      yield { type: 'thinking_end', contentIndex: 0, content: 'first suffix', partial: assistant([]) };
      yield { type: 'thinking_end', contentIndex: 1, content: 'second', partial: assistant([]) };
      yield* text('done');
    });
    const events: string[] = [];
    const client = new PiModelClient(options());
    client.onThinking = (delta) => events.push(delta);
    client.onThinkingCheckpoint = (boundary) => events.push(`checkpoint:${boundary}`);
    await client.query('question');
    expect(events).toEqual([
      'first',
      ' suffix',
      'checkpoint:part',
      '\n\n',
      'second',
      'checkpoint:part',
      'checkpoint:request',
    ]);
  });
  it('waits for clean stream termination before executing a completed tool response', async () => {
    const execute = vi.fn(async () => 'written');
    tool('write_probe', false, execute);
    scripts.push(async function* () {
      yield* completed([call('w', 'write_probe')]);
      throw httpError(400);
    });
    await expect(new PiModelClient(options()).query('write')).rejects.toMatchObject({ status: 400 });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('pi retry termination regressions', () => {
  it('does not run effort fallback after text has already reached the user', async () => {
    disposers.push(
      micaConfig.registerModelRules({
        'pi-loop::pi-loop-model': {
          contextSize: 200,
          defaultEffort: 'none',
          efforts: { none: { openai_responses: { reasoning: { effort: 'none' } } } },
        },
      }),
    );
    scripts.push(
      async function* () {
        yield textDelta('partial');
        throw Object.assign(new Error("Unsupported reasoning effort 'none'"), { status: 400 });
      },
      () => text('duplicate'),
    );
    const client = new PiModelClient({ ...options(), effort: 'none' });
    client.onText = vi.fn();
    await expect(client.query('question')).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
    expect(client.onText).toHaveBeenCalledExactlyOnceWith('partial');
  });

  it('rolls back a failed stream after its terminal event without executing its tools', async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => 'written');
    tool('write_probe', false, execute);
    scripts.push(
      async function* () {
        yield textDelta('discard');
        yield* completed([{ type: 'text', text: 'discard' }, call('discard-tool', 'write_probe')]);
        throw httpError(503);
      },
      () => text('final'),
    );
    const client = new PiModelClient(options());
    client.onTextAttemptStart = vi.fn();
    client.onTextRollback = vi.fn();
    const result = client.query('question');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe('final');
    expect(execute).not.toHaveBeenCalled();
    expect(client.onTextRollback).toHaveBeenCalledTimes(1);
    expect(client.messages.filter((m) => m.role === 'assistant')).toMatchObject([
      { content: [{ type: 'text', text: 'final' }] },
    ]);
  });
});

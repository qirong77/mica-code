import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';

const openaiMocks = vi.hoisted(() => ({
  chatCreate: vi.fn(),
  responsesCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  OpenAI: class MockOpenAI {
    chat = { completions: { create: openaiMocks.chatCreate } };
    responses = { create: openaiMocks.responsesCreate };
  },
}));

afterEach(() => {
  openaiMocks.chatCreate.mockReset();
  openaiMocks.responsesCreate.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type ResponsesRequest = {
  input: Array<Record<string, unknown>>;
  instructions: string;
  tools?: unknown;
  tool_choice?: unknown;
  model: string;
  stream: boolean;
};

const completed = { type: 'response.completed', response: { model: 'test-model', status: 'completed' } };
const thinking = (delta: string) => ({ type: 'response.reasoning_summary_text.delta', delta });
const summaryDelta = (item_id: string, summary_index: number, delta: string) =>
  ({ type: 'response.reasoning_summary_text.delta', item_id, summary_index, delta });
const summaryDone = (item_id: string, summary_index: number, text: string) =>
  ({ type: 'response.reasoning_summary_text.done', item_id, summary_index, text });
const contentDelta = (item_id: string, content_index: number, delta: string) =>
  ({ type: 'response.reasoning_text.delta', item_id, content_index, delta });
const contentDone = (item_id: string, content_index: number, text: string) =>
  ({ type: 'response.reasoning_text.done', item_id, content_index, text });
const reasoningItem = (id: string) => ({
  type: 'response.output_item.done',
  output_index: 0,
  item: { type: 'reasoning', id: `rs_${id}`, summary: [], encrypted_content: `encrypted-${id}` },
});
const toolItem = (id: string) => ({
  type: 'response.output_item.done',
  output_index: 1,
  item: { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'probe_tool', arguments: '{}', status: 'completed' },
});

async function* streamOf(...events: unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event;
}

function options(protocol: ProviderProtocol): ModelClientOptions {
  return {
    model: 'test-model',
    apiKey: 'test-key',
    baseURL: 'https://example.com/v1',
    systemPrompt: 'stable system prompt',
    provider: { id: 'test', api_base: 'https://example.com/v1', protocol },
  };
}

describe('Responses thinking checkpoints', () => {
  it.each([
    ['different summary indices', summaryDelta('one', 0, 'first'), summaryDelta('one', 1, 'unfinished'), summaryDone('one', 0, 'first')],
    ['different items', summaryDelta('one', 0, 'first'), summaryDelta('two', 0, 'unfinished'), summaryDone('one', 0, 'first')],
    ['summary and content indices', summaryDelta('one', 0, 'first'), contentDelta('one', 0, 'unfinished'), summaryDone('one', 0, 'first')],
  ])('excludes an interleaved unfinished part from the checkpoint: %s', async (_name, first, later, firstDone) => {
    const controller = new AbortController();
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      yield first;
      yield later;
      yield firstDone;
      // The SDK may finish iteration normally after the abort signal.
      controller.abort();
    })());
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const events: string[] = [];
    let visible = '';
    let checkpoint = '';
    client.onThinking = (delta) => { visible += delta; events.push(`thinking:${delta}`); };
    client.onThinkingCheckpoint = (boundary) => { checkpoint = visible; events.push(`${boundary}:${visible}`); };
    controller.signal.addEventListener('abort', () => { visible = checkpoint; }, { once: true });

    await expect(client.query('work', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual(['thinking:first', 'part:first', 'thinking:\n\n', 'thinking:unfinished']);
    expect(visible).toBe('first');
    expect(client.messages).toEqual([]);
  });

  it('does not checkpoint if a done suffix triggers an abort while being displayed', async () => {
    const controller = new AbortController();
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      summaryDelta('one', 0, 'first'),
      summaryDone('one', 0, 'first tail'),
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoint = vi.fn();
    client.onThinking = (delta) => { if (delta === ' tail') controller.abort(); };
    client.onThinkingCheckpoint = checkpoint;

    await expect(client.query('work', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('completes and checkpoints parts in first-arrival order, including done-only text and omitted suffixes', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      summaryDelta('one', 0, 'first'),
      summaryDone('one', 1, 'second'),
      summaryDone('one', 1, 'second'),
      summaryDone('one', 0, 'first tail'),
      summaryDone('one', 0, 'first tail'),
      summaryDone('one', 1, 'second'),
      contentDone('one', 0, 'third'),
      { type: 'response.output_text.delta', delta: 'answer' },
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const events: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; events.push(`thinking:${delta}`); };
    client.onThinkingCheckpoint = (boundary) => { events.push(`${boundary}:${visible}`); };

    await expect(client.query('work')).resolves.toBe('answer');
    expect(events).toEqual([
      'thinking:first', 'thinking: tail', 'part:first tail',
      'thinking:\n\n', 'thinking:second', 'part:first tail\n\nsecond',
      'thinking:\n\n', 'thinking:third', 'part:first tail\n\nsecond\n\nthird',
      'request:first tail\n\nsecond\n\nthird',
    ]);
  });

  it('supports sequential parts and duplicate done events from providers without indices', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      thinking('first'),
      { type: 'response.reasoning_summary_text.done', text: 'first' },
      { type: 'response.reasoning_summary_text.done', text: 'first' },
      thinking('sec'),
      { type: 'response.reasoning_text.done', text: 'second' },
      { type: 'response.reasoning_text.done', text: 'second' },
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoints: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => { checkpoints.push(`${boundary}:${visible}`); };

    await client.query('work');
    expect(visible).toBe('first\n\nsecond');
    expect(checkpoints).toEqual(['part:first', 'part:first\n\nsecond', 'request:first\n\nsecond']);
  });

  it('does not apply a late duplicate done to the next unidentified part', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      thinking('first'),
      { type: 'response.reasoning_summary_text.done', text: 'first' },
      thinking('second'),
      { type: 'response.reasoning_summary_text.done', text: 'first' },
      thinking(' tail'),
      { type: 'response.reasoning_summary_text.done', text: 'second tail' },
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoints: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => { checkpoints.push(`${boundary}:${visible}`); };

    await client.query('work');
    expect(checkpoints).toEqual(['part:first', 'part:first\n\nsecond tail', 'request:first\n\nsecond tail']);
  });

  it('does not checkpoint an unidentified part when its done could be a duplicate', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      thinking('same'),
      { type: 'response.reasoning_summary_text.done', text: 'same' },
      thinking('same'),
      { type: 'response.reasoning_summary_text.done', text: 'same' },
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoints: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => { checkpoints.push(`${boundary}:${visible}`); };

    await client.query('work');
    expect(visible).toBe('same\n\nsame');
    expect(checkpoints).toEqual(['part:same']);
  });

  it('separates interleaved items when a provider omits only the part indices', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      { ...thinking('first'), item_id: 'one' },
      { ...thinking('second'), item_id: 'two' },
      { type: 'response.reasoning_summary_text.done', item_id: 'two', text: 'second' },
      { type: 'response.reasoning_summary_text.done', item_id: 'two', text: 'second' },
      { type: 'response.reasoning_summary_text.done', item_id: 'one', text: 'first' },
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoints: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => { checkpoints.push(`${boundary}:${visible}`); };

    await client.query('work');
    expect(checkpoints).toEqual(['part:first', 'part:first\n\nsecond', 'request:first\n\nsecond']);
  });

  it('matches an item by output index when an item id appears only on done', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      { ...summaryDelta('one', 0, 'first'), item_id: undefined, output_index: 0 },
      { ...summaryDelta('two', 0, 'second'), item_id: undefined, output_index: 1 },
      { ...summaryDone('two', 0, 'second'), output_index: 1 },
      { ...summaryDone('one', 0, 'first'), output_index: 0 },
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoints: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => { checkpoints.push(`${boundary}:${visible}`); };

    await client.query('work');
    expect(checkpoints).toEqual(['part:first', 'part:first\n\nsecond', 'request:first\n\nsecond']);
  });

  it('does not checkpoint inconsistent text after a part has streamed', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      summaryDelta('one', 0, 'incorrect'),
      summaryDone('one', 0, 'correct'),
      summaryDone('one', 1, 'later'),
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const onCheckpoint = vi.fn();
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = onCheckpoint;

    await client.query('work');
    expect(visible).toBe('incorrect');
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('uses authoritative done text when inconsistent deltas are still buffered', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      summaryDelta('one', 0, 'first'),
      summaryDelta('one', 1, 'stale'),
      summaryDone('one', 1, 'correct'),
      summaryDone('one', 0, 'first'),
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoints: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => { checkpoints.push(`${boundary}:${visible}`); };

    await client.query('work');
    expect(checkpoints).toEqual(['part:first', 'part:first\n\ncorrect', 'request:first\n\ncorrect']);
  });

  it('does not guess whether an unidentified second done-only event is a new part', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      { type: 'response.reasoning_summary_text.done', text: 'first' },
      { type: 'response.reasoning_summary_text.done', text: 'different' },
      completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const checkpoints: string[] = [];
    let visible = '';
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => { checkpoints.push(`${boundary}:${visible}`); };

    await client.query('work');
    expect(visible).toBe('first');
    expect(checkpoints).toEqual(['part:first']);
  });

  it('preserves two completed reasoning parts when the third part is interrupted within the same response', async () => {
    const controller = new AbortController();
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      yield thinking('first');
      yield { type: 'response.reasoning_summary_text.done', text: 'first' };
      yield thinking('second');
      yield { type: 'response.reasoning_text.done', text: 'second' };
      yield thinking('unfinished');
      controller.abort();
    })());
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    let visible = '';
    let checkpoint = '';
    const boundaries: string[] = [];
    client.onThinking = (delta) => { visible += delta; };
    client.onThinkingCheckpoint = (boundary) => {
      checkpoint = visible;
      boundaries.push(boundary);
    };
    controller.signal.addEventListener('abort', () => { visible = checkpoint; }, { once: true });

    await expect(client.query('work', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(visible).toBe('first\n\nsecond');
    expect(boundaries).toEqual(['part', 'part']);
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
    const request = openaiMocks.responsesCreate.mock.calls[0]?.[0] as ResponsesRequest;
    expect(request.input.some((item) => item.type === 'reasoning')).toBe(false);
  });

  it('retains two completed requests and rolls back only an interrupted third request without replaying reasoning', async () => {
    const controller = new AbortController();
    const client = new ResponsesClient(options('openai_responses'));
    client.messages = [
      { type: 'message', role: 'user', content: 'earlier question' },
      { type: 'message', role: 'assistant', content: 'earlier answer' },
      { type: 'reasoning', id: 'rs_history', summary: [], encrypted_content: 'encrypted-history' },
    ];
    vi.spyOn(micaTools, 'execute').mockResolvedValue('tool result');

    const streams = [
      streamOf(thinking('first; '), reasoningItem('one'), toolItem('one'), completed),
      streamOf(thinking('second; '), reasoningItem('two'), toolItem('two'), completed),
      (async function* () {
        yield thinking('unfinished third');
        yield reasoningItem('partial');
        controller.abort();
      })(),
      streamOf({ type: 'response.output_text.delta', delta: 'resumed' }, completed),
    ];
    const requests: ResponsesRequest[] = [];
    let historyBeforeAbort: typeof client.messages | undefined;
    openaiMocks.responsesCreate.mockImplementation(async (request: ResponsesRequest) => {
      requests.push(structuredClone(request));
      if (requests.length === 3) historyBeforeAbort = structuredClone(client.messages);
      return streams[requests.length - 1];
    });

    const events: string[] = [];
    let visibleThinking = '';
    let completedThinking = '';
    client.onTextAttemptStart = () => { events.push('attempt'); };
    client.onTextRollback = () => { events.push('attempt rollback'); };
    client.onThinking = (delta) => { visibleThinking += delta; events.push(`thinking:${delta}`); };
    client.onThinkingCheckpoint = () => { completedThinking = visibleThinking; events.push(`checkpoint:${visibleThinking}`); };
    const onThinkingRollback = () => { visibleThinking = completedThinking; events.push(`thinking rollback:${visibleThinking}`); };
    client.onToolCall = (_name, _args, id) => { events.push(`call:${id}`); };
    client.onToolResult = (_name, _result, id) => { events.push(`result:${id}`); };
    // The runtime owns abort rollback; the provider must not emit another one.
    controller.signal.addEventListener('abort', () => {
      events.push('abort');
      onThinkingRollback();
    }, { once: true });

    await expect(client.query('work', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual([
      'attempt', 'thinking:first; ', 'checkpoint:first; ', 'call:call_one', 'result:call_one',
      'attempt', 'thinking:second; ', 'checkpoint:first; second; ', 'call:call_two', 'result:call_two',
      'attempt', 'thinking:unfinished third', 'abort', 'thinking rollback:first; second; ',
    ]);
    expect(visibleThinking).toBe('first; second; ');
    expect(historyBeforeAbort).toBeDefined();
    expect(client.messages).toEqual(historyBeforeAbort);
    expect(client.messages.filter((item) => item.type === 'reasoning')).toEqual([
      { type: 'reasoning', id: 'rs_history', summary: [], encrypted_content: 'encrypted-history' },
      { type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: 'encrypted-one' },
      { type: 'reasoning', id: 'rs_two', summary: [], encrypted_content: 'encrypted-two' },
    ]);
    expect(JSON.stringify(client.messages)).not.toContain('encrypted-partial');

    const originalInput = [
      { type: 'message', role: 'user', content: 'earlier question' },
      { type: 'message', role: 'assistant', content: 'earlier answer' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'work' }] },
    ];
    const firstCall = { type: 'function_call', call_id: 'call_one', name: 'probe_tool', arguments: '{}' };
    const firstResult = { type: 'function_call_output', call_id: 'call_one', output: 'tool result' };
    const secondCall = { type: 'function_call', call_id: 'call_two', name: 'probe_tool', arguments: '{}' };
    const secondResult = { type: 'function_call_output', call_id: 'call_two', output: 'tool result' };
    expect(requests.map((request) => request.input)).toEqual([
      originalInput,
      [...originalInput, firstCall, firstResult],
      [...originalInput, firstCall, firstResult, secondCall, secondResult],
    ]);
    for (const request of requests) {
      expect(request.instructions).toBe('stable system prompt');
      expect(request.tools).toEqual(requests[0]?.tools);
      expect(request.tool_choice).toEqual(requests[0]?.tool_choice);
      expect(request.input.some((item) => item.type === 'reasoning')).toBe(false);
    }

    // Abort preservation still normalizes completed items and retains their reasoning.
    expect(client.preserveAbortedTurn('work')).toBe(true);
    expect(client.messages).toEqual([
      originalInput[0], originalInput[1],
      { type: 'reasoning', id: 'rs_history', summary: [], encrypted_content: 'encrypted-history' },
      originalInput[2],
      { type: 'reasoning', id: 'rs_one', summary: [], encrypted_content: 'encrypted-one' },
      firstCall, firstResult,
      { type: 'reasoning', id: 'rs_two', summary: [], encrypted_content: 'encrypted-two' },
      secondCall, secondResult,
    ]);
    await expect(client.query('resume')).resolves.toBe('resumed');
    expect(requests[3]?.input).toEqual([
      ...originalInput, firstCall, firstResult, secondCall, secondResult,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'resume' }] },
    ]);
    expect(requests[3]?.input.some((item) => item.type === 'reasoning')).toBe(false);
    expect(visibleThinking).toBe('first; second; ');
  });

  it('waits for clean stream termination after response.completed, including without tools', async () => {
    let release!: () => void;
    let reachedEnd!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const afterTerminal = new Promise<void>((resolve) => { reachedEnd = resolve; });
    const events: string[] = [];
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      yield thinking('complete thought');
      yield { type: 'response.output_text.delta', delta: 'answer' };
      yield completed;
      events.push('terminal delivered');
      reachedEnd();
      await gate;
      events.push('stream ended');
    })());
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    client.onThinking = (delta) => { events.push(`thinking:${delta}`); };
    client.onThinkingCheckpoint = () => { events.push('checkpoint'); };
    const result = client.query('hello');
    await afterTerminal;
    try {
      expect(events).toEqual(['thinking:complete thought', 'terminal delivered']);
    } finally {
      release();
    }
    await expect(result).resolves.toBe('answer');
    expect(events).toEqual(['thinking:complete thought', 'terminal delivered', 'stream ended', 'checkpoint']);
  });

  it('checkpoints a successful response without inventing missing thinking', async () => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(
      { type: 'response.output_text.delta', delta: 'answer' }, completed,
    ));
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const onThinking = vi.fn();
    const onCheckpoint = vi.fn();
    client.onThinking = onThinking;
    client.onThinkingCheckpoint = onCheckpoint;
    await expect(client.query('hello')).resolves.toBe('answer');
    expect(onThinking).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenCalledTimes(1);
  });

  const unsuccessfulStreams: Array<[string, unknown[]]> = [
    ['truncated', []],
    ['failed event', [{ type: 'response.failed', response: { error: { code: 'bad_request', message: 'failed' } } }]],
    ['incomplete event', [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]],
    ['error event after completion', [completed, { type: 'error', code: 'bad_request', message: 'failed' }]],
    ['non-completed status', [{ type: 'response.completed', response: { status: 'incomplete' } }]],
  ];
  it.each(unsuccessfulStreams)('does not checkpoint a %s stream', async (_description, suffix) => {
    openaiMocks.responsesCreate.mockResolvedValueOnce(streamOf(thinking('partial'), ...suffix));
    const client = new ResponsesClient(options('openai_responses'));
    const onCheckpoint = vi.fn();
    client.onThinkingCheckpoint = onCheckpoint;
    await expect(client.query('hello')).rejects.toThrow();
    expect(onCheckpoint).not.toHaveBeenCalled();
    expect(client.messages).toEqual([]);
    expect(openaiMocks.responsesCreate).toHaveBeenCalledTimes(1);
  });

  it('does not checkpoint when aborted after response.completed but before stream termination', async () => {
    const controller = new AbortController();
    openaiMocks.responsesCreate.mockResolvedValueOnce((async function* () {
      yield thinking('partial');
      yield completed;
      controller.abort();
    })());
    const client = new ResponsesClient(options('openai_responses'));
    const onCheckpoint = vi.fn();
    client.onThinkingCheckpoint = onCheckpoint;
    await expect(client.query('hello', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(onCheckpoint).not.toHaveBeenCalled();
    expect(client.messages).toEqual([]);
  });

  it('rolls back completed and buffered parts before retrying the same request', async () => {
    vi.useFakeTimers();
    const requests: ResponsesRequest[] = [];
    const streams = [
      (async function* () {
        yield summaryDelta('one', 0, 'failed first');
        yield summaryDelta('one', 1, 'failed partial');
        yield summaryDone('one', 0, 'failed first');
        throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
      })(),
      streamOf(
        summaryDone('two', 0, 'successful first'),
        summaryDelta('two', 1, 'successful '),
        summaryDone('two', 1, 'successful second'),
        { type: 'response.output_text.delta', delta: 'answer' },
        completed,
      ),
    ];
    openaiMocks.responsesCreate.mockImplementation(async (request: ResponsesRequest) => {
      requests.push(structuredClone(request));
      return streams[requests.length - 1];
    });
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const events: string[] = [];
    let visible = 'earlier; ';
    let checkpoint = visible;
    let attemptVisible = '';
    let attemptCheckpoint = '';
    client.canRollbackThinking = true;
    client.onTextAttemptStart = () => {
      attemptVisible = visible;
      attemptCheckpoint = checkpoint;
      events.push('attempt');
    };
    client.onTextRollback = () => {
      visible = attemptVisible;
      checkpoint = attemptCheckpoint;
      events.push('rollback');
    };
    client.onThinking = (delta) => { visible += delta; events.push(`thinking:${delta}`); };
    client.onThinkingCheckpoint = (boundary) => {
      checkpoint = visible;
      events.push(`${boundary}:${visible}`);
    };

    const result = client.query('work');
    await vi.advanceTimersByTimeAsync(3100);
    await expect(result).resolves.toBe('answer');
    expect(events).toEqual([
      'attempt', 'thinking:failed first', 'part:earlier; failed first',
      'thinking:\n\n', 'thinking:failed partial', 'rollback',
      'attempt', 'thinking:successful first', 'part:earlier; successful first',
      'thinking:\n\n', 'thinking:successful ', 'thinking:second',
      'part:earlier; successful first\n\nsuccessful second',
      'request:earlier; successful first\n\nsuccessful second',
    ]);
    expect(checkpoint).toBe('earlier; successful first\n\nsuccessful second');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.input.some((item) => item.type === 'reasoning')).toBe(false);
  });

  it('preserves attempt start and rollback semantics when a stream fails after its terminal event and retries', async () => {
    vi.useFakeTimers();
    const requests: ResponsesRequest[] = [];
    const streams = [
      (async function* () {
        yield thinking('failed thought');
        yield { type: 'response.output_text.delta', delta: 'failed answer' };
        yield completed;
        throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' });
      })(),
      streamOf(thinking('successful thought'), { type: 'response.output_text.delta', delta: 'answer' }, completed),
    ];
    openaiMocks.responsesCreate.mockImplementation(async (request: ResponsesRequest) => {
      requests.push(structuredClone(request));
      return streams[requests.length - 1];
    });
    const client = new ResponsesClient({ ...options('openai_responses'), tools: false });
    const events: string[] = [];
    let text = 'earlier text; ';
    let thought = 'earlier thought; ';
    let attemptText = '';
    let attemptThought = '';
    client.canRollbackThinking = true;
    client.onTextAttemptStart = () => {
      attemptText = text;
      attemptThought = thought;
      events.push('attempt');
    };
    client.onTextRollback = () => {
      text = attemptText;
      thought = attemptThought;
      events.push('rollback');
    };
    client.onText = (delta) => { text += delta; events.push(`text:${delta}`); };
    client.onThinking = (delta) => { thought += delta; events.push(`thinking:${delta}`); };
    client.onThinkingCheckpoint = () => { events.push(`checkpoint:${thought}`); };
    const result = client.query('hello');
    await vi.advanceTimersByTimeAsync(3100);
    await expect(result).resolves.toBe('answer');
    expect(events).toEqual([
      'attempt', 'thinking:failed thought', 'text:failed answer', 'rollback',
      'attempt', 'thinking:successful thought', 'text:answer', 'checkpoint:earlier thought; successful thought',
    ]);
    expect(text).toBe('earlier text; answer');
    expect(thought).toBe('earlier thought; successful thought');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.input.some((item) => item.type === 'reasoning')).toBe(false);
  });

  it('does not introduce checkpoint events for Chat Completions', async () => {
    openaiMocks.chatCreate.mockResolvedValueOnce(streamOf(
      { choices: [{ delta: { reasoning_content: 'chat thought' } }] },
      { choices: [{ delta: { content: 'chat answer' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ));
    const client = new ChatCompletionsClient({ ...options('openai_chat_completions'), tools: false });
    const onThinking = vi.fn();
    const onCheckpoint = vi.fn();
    client.onThinking = onThinking;
    client.onThinkingCheckpoint = onCheckpoint;
    await expect(client.query('hello')).resolves.toBe('chat answer');
    expect(onThinking).toHaveBeenCalledWith('chat thought');
    expect(onCheckpoint).not.toHaveBeenCalled();
  });
});

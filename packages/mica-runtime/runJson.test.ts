import { describe, expect, it } from 'vitest';
import {
  chunkRunJsonText,
  createRunJsonError,
  createRunJsonStepFinish,
  createRunJsonStepStart,
  createStdoutRunJsonWriter,
  encodeRunJsonLine,
  exitCodeForRunJsonStatus,
  parseToolCallInput,
  truncateRunJsonToolOutput,
  type RunJsonEvent,
} from './runJson.js';

describe('runJson', () => {
  it('encodes one OpenCode-compatible JSON object per line', () => {
    const event = createRunJsonStepStart('s1', 123);
    expect(encodeRunJsonLine(event)).toBe(
      '{"type":"step_start","timestamp":123,"sessionID":"s1","part":{"type":"step-start"}}\n',
    );
  });

  it('writes events through the provided sink', () => {
    const lines: string[] = [];
    const writer = createStdoutRunJsonWriter((chunk: string) => lines.push(chunk));
    writer.write(createRunJsonError('boom', { name: 'TestError' }));
    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'error',
      error: { name: 'TestError', data: { message: 'boom' } },
    });
  });

  it('renders step-finish usage in the shape Multica parses', () => {
    const event = createRunJsonStepFinish(
      's1',
      'completed',
      { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, total: 13 },
      456,
    );
    expect(event).toEqual({
      type: 'step_finish',
      timestamp: 456,
      sessionID: 's1',
      part: {
        type: 'step-finish',
        reason: 'completed',
        tokens: {
          total: 13,
          input: 7,
          output: 3,
          reasoning: 0,
          cache: { read: 2, write: 1 },
        },
      },
    } satisfies RunJsonEvent);
  });

  it('parses tool arguments into an object and preserves malformed input', () => {
    expect(parseToolCallInput('{"command":"bun test"}')).toEqual({ command: 'bun test' });
    expect(parseToolCallInput('false')).toEqual({ value: false });
    expect(parseToolCallInput('not-json')).toEqual({ raw: 'not-json' });
  });

  it('bounds tool output below Multica scanner limits without a 500-char lossy summary', () => {
    expect(truncateRunJsonToolOutput('ok', 8)).toBe('ok');
    expect(truncateRunJsonToolOutput('x'.repeat(12), 8)).toContain('xxxxxxx');
    expect(truncateRunJsonToolOutput('x'.repeat(12), 8)).toContain('4 chars omitted');
  });

  it('chunks large text events without splitting a UTF-16 surrogate pair', () => {
    const text = 'abc😀def';
    const chunks = chunkRunJsonText(text, 4);
    expect(chunks.join('')).toBe(text);
    expect(chunks).toEqual(['abc', '😀de', 'f']);
    expect(() => chunkRunJsonText(text, 0)).toThrow(RangeError);
  });

  it('maps result status to process exit codes', () => {
    expect(exitCodeForRunJsonStatus('completed')).toBe(0);
    expect(exitCodeForRunJsonStatus('aborted')).toBe(130);
    expect(exitCodeForRunJsonStatus('error')).toBe(1);
  });
});

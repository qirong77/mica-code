import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedInput } from './parse-keypress.js';

function parse(input: Buffer | string): ParsedInput[] {
  return parseMultipleKeypresses({ ...INITIAL_STATE }, input)[0];
}

describe('terminal response parsing', () => {
  it('parses xterm-compatible DECXCPR responses without a page', () => {
    expect(parse('\x1b[?7;5R')).toEqual([
      {
        kind: 'response',
        sequence: '\x1b[?7;5R',
        response: { type: 'cursorPosition', row: 7, col: 5 },
      },
    ]);
  });

  it('parses VT300 DECXCPR responses with a page', () => {
    expect(parse('\x1b[?7;5;1R')).toEqual([
      {
        kind: 'response',
        sequence: '\x1b[?7;5;1R',
        response: { type: 'cursorPosition', row: 7, col: 5, page: 1 },
      },
    ]);
  });

  it('parses a page-bearing DECXCPR response split across stdin chunks', () => {
    const [firstItems, state] = parseMultipleKeypresses({ ...INITIAL_STATE }, '\x1b[?7;');
    const [secondItems, finalState] = parseMultipleKeypresses(state, '5;1R');

    expect(firstItems).toEqual([]);
    expect(secondItems).toEqual([
      {
        kind: 'response',
        sequence: '\x1b[?7;5;1R',
        response: { type: 'cursorPosition', row: 7, col: 5, page: 1 },
      },
    ]);
    expect(finalState.incomplete).toBe('');
  });

  it('parses an 8-bit C1 DECXCPR response from raw stdin bytes', () => {
    expect(parse(Buffer.concat([Buffer.from([0x9b]), Buffer.from('?7;5;1R')]))).toEqual([
      {
        kind: 'response',
        sequence: '\x1b[?7;5;1R',
        response: { type: 'cursorPosition', row: 7, col: 5, page: 1 },
      },
    ]);
  });

  it('parses an 8-bit C1 DA1 sentinel response', () => {
    expect(parse(Buffer.concat([Buffer.from([0x9b]), Buffer.from('?1;2c')]))).toEqual([
      {
        kind: 'response',
        sequence: '\x1b[?1;2c',
        response: { type: 'da1', params: [1, 2] },
      },
    ]);
  });

  it('parses 8-bit C1 OSC and DCS terminal responses', () => {
    expect(
      parse(Buffer.concat([Buffer.from([0x9d]), Buffer.from('11;rgb:0000/0000/0000'), Buffer.from([0x9c])])),
    ).toEqual([
      {
        kind: 'response',
        sequence: '\x1b]11;rgb:0000/0000/0000\x1b\\',
        response: { type: 'osc', code: 11, data: 'rgb:0000/0000/0000' },
      },
    ]);
    expect(parse(Buffer.concat([Buffer.from([0x90]), Buffer.from('>|xterm.js(5.5.0)'), Buffer.from([0x9c])]))).toEqual([
      {
        kind: 'response',
        sequence: '\x1bP>|xterm.js(5.5.0)\x1b\\',
        response: { type: 'xtversion', name: 'xterm.js(5.5.0)' },
      },
    ]);
  });

  it('parses an 8-bit C1 response split across raw stdin chunks', () => {
    const [firstItems, state] = parseMultipleKeypresses({ ...INITIAL_STATE }, Buffer.from([0x9b]));
    const [secondItems, finalState] = parseMultipleKeypresses(state, Buffer.from('?7;5;1R'));

    expect(firstItems).toEqual([]);
    expect(secondItems).toEqual([
      {
        kind: 'response',
        sequence: '\x1b[?7;5;1R',
        response: { type: 'cursorPosition', row: 7, col: 5, page: 1 },
      },
    ]);
    expect(finalState.incomplete).toBe('');
  });

  it('preserves UTF-8 text split across raw stdin chunks', () => {
    const utf8 = Buffer.from('你🙂');
    const [firstItems, state] = parseMultipleKeypresses({ ...INITIAL_STATE }, utf8.subarray(0, 2));
    const [secondItems, finalState] = parseMultipleKeypresses(state, utf8.subarray(2, 5));
    const [thirdItems] = parseMultipleKeypresses(finalState, utf8.subarray(5));

    expect(firstItems).toEqual([]);
    expect(secondItems).toEqual([expect.objectContaining({ kind: 'key', sequence: '你' })]);
    expect(thirdItems).toEqual([expect.objectContaining({ kind: 'key', sequence: '🙂' })]);
  });

  it('does not reinterpret a UTF-8 encoded U+009B as a C1 introducer', () => {
    expect(parse(Buffer.from([0xc2, 0x9b]))).toEqual([
      expect.objectContaining({
        kind: 'key',
        sequence: '\u009b',
      }),
    ]);
  });

  it('does not consume a DECXCPR-shaped sequence with extra parameters', () => {
    expect(parse('\x1b[?7;5;1;9R')).toEqual([
      expect.objectContaining({
        kind: 'key',
        sequence: '\x1b[?7;5;1;9R',
      }),
    ]);
  });

  it('keeps text following a DECXCPR response as separate user input', () => {
    expect(parse('\x1b[?7;5;1Rabc')).toEqual([
      {
        kind: 'response',
        sequence: '\x1b[?7;5;1R',
        response: { type: 'cursorPosition', row: 7, col: 5, page: 1 },
      },
      expect.objectContaining({ kind: 'key', sequence: 'abc' }),
    ]);
  });

  it('keeps an ambiguous plain CPR or modified F3 sequence as a keypress', () => {
    expect(parse('\x1b[1;2R')).toEqual([
      expect.objectContaining({
        kind: 'key',
        name: 'f3',
        shift: true,
        sequence: '\x1b[1;2R',
      }),
    ]);
  });

  it.each([
    { sequence: '\x1b[1;2P', name: 'f1' },
    { sequence: '\x1b[1;2Q', name: 'f2' },
    { sequence: '\x1b[1;2R', name: 'f3' },
    { sequence: '\x1b[1;2S', name: 'f4' },
  ])('parses legacy modified $name sequences', ({ sequence, name }) => {
    expect(parse(sequence)).toEqual([
      expect.objectContaining({
        kind: 'key',
        name,
        shift: true,
        sequence,
      }),
    ]);
  });
});

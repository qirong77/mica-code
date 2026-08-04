import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, parseMultipleKeypresses, type ParsedInput } from './parse-keypress.js';

function parse(input: Buffer | string): ParsedInput[] {
  return parseMultipleKeypresses({ ...INITIAL_STATE }, input)[0];
}

describe('terminal response parsing', () => {
  it('emits escape key when ESC is followed by plain text in the same chunk', () => {
    // 用户按 esc 后立即输入字符时，\x1b 与后续文本可能同批到达；
    // 孤立 \x1b 必须作为 escape 键发出，不能被并入文本。
    const keys = parse('\x1b/mcp');
    expect(keys.map((k) => (k.kind === 'key' ? k.name : k.kind))).toEqual(['escape', '', '']);
    expect('sequence' in keys[0] && keys[0].sequence).toBe('\x1b');
    expect('sequence' in keys[1] && keys[1].sequence).toBe('/m');
    expect('sequence' in keys[2] && keys[2].sequence).toBe('cp');
  });

  it('still parses real escape sequences as before', () => {
    const keys = parse('\x1b[A');
    expect(keys.map((k) => (k.kind === 'key' ? k.name : k.kind))).toEqual(['up']);
  });

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

  it.each([
    { sequence: '\x1b\r', label: 'ESC CR (Alt+Enter)' },
    { sequence: '\x1b\n', label: 'ESC LF (Alt+Enter)' },
  ])('parses $label as a single meta+return key', ({ sequence }) => {
    const keys = parse(sequence);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual(
      expect.objectContaining({
        kind: 'key',
        name: 'return',
        meta: true,
      }),
    );
  });

  it('does not split Alt+Enter into Escape and Return keys', () => {
    // 拆分会导致输入框被 escape 清空并误提交（回归防护）。
    const keys = parse('\x1b\r');
    expect(keys.map((k) => (k.kind === 'key' ? k.name : k.kind))).toEqual(['return']);
  });

  it('keeps a plain Enter as return without meta', () => {
    expect(parse('\r')).toEqual([
      expect.objectContaining({
        kind: 'key',
        name: 'return',
        meta: false,
      }),
    ]);
  });
});

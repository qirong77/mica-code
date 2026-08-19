import { describe, expect, it } from 'vitest';
import { Cursor, getCommandHighlightRange, resolveCommandHighlight } from './CursorInput.js';

function cursorAt(text: string, offset: number): Cursor {
  return Cursor.fromText(text, 80, offset);
}

describe('Cursor.deleteLine', () => {
  it('clears a single-line input entirely', () => {
    const c = cursorAt('hello world', 5).deleteLine();
    expect(c.text).toBe('');
    expect(c.offset).toBe(0);
  });

  it('deletes an empty-input line', () => {
    const c = cursorAt('', 0).deleteLine();
    expect(c.text).toBe('');
    expect(c.offset).toBe(0);
  });

  it('deletes a middle line including its trailing newline', () => {
    const c = cursorAt('a\nb\nc', 3).deleteLine(); // cursor on 'b'
    expect(c.text).toBe('a\nc');
    expect(c.offset).toBe(2);
  });

  it('deletes the last line and lands at the previous line end', () => {
    const c = cursorAt('a\nb\nc', 4).deleteLine(); // cursor on 'c'
    expect(c.text).toBe('a\nb');
    expect(c.offset).toBe(3);
  });

  it('deletes the first line and keeps the rest', () => {
    const c = cursorAt('a\nb\nc', 1).deleteLine(); // cursor on 'a'
    expect(c.text).toBe('b\nc');
    expect(c.offset).toBe(0);
  });

  it('keeps a line break separator when deleting the middle of a line', () => {
    const c = cursorAt('a\nxy\nc', 4).deleteLine(); // cursor inside 'xy'
    expect(c.text).toBe('a\nc');
    expect(c.offset).toBe(2);
  });
});

describe('Cursor.render highlight', () => {
  const wrap = (text: string) => `[${text}]`;
  const invert = (text: string) => `~${text}~`;

  it('wraps the highlighted range in a single-line input', () => {
    const c = cursorAt('/rename xxx', 11);
    const rendered = c.render(' ', invert, undefined, { start: 0, end: 7 }, wrap);
    expect(rendered).toContain('[/rename]');
    expect(rendered).not.toContain('[xxx]');
  });

  it('highlights characters before the cursor and leaves the cursor char alone', () => {
    const c = cursorAt('/rename xxx', 3);
    const rendered = c.render(' ', invert, undefined, { start: 0, end: 7 }, wrap);
    expect(rendered).toContain('[/re]');
    expect(rendered).toContain('~n~');
  });

  it('highlights a non-cursor line independently of the cursor line', () => {
    const c = cursorAt('/loop\nsecond line', 14);
    const rendered = c.render(' ', invert, undefined, { start: 0, end: 5 }, wrap);
    expect(rendered).toContain('[/loop]');
    expect(rendered).toContain('second l');
    expect(rendered).toContain('~i~');
  });

  it('leaves text unchanged when the range is out of bounds', () => {
    const c = cursorAt('plain text', 4);
    const rendered = c.render(' ', invert, undefined, { start: 100, end: 120 }, wrap);
    expect(rendered).toContain('plai');
    expect(rendered).not.toContain('[');
  });
});

describe('command highlight range', () => {
  const commands = [{ name: 'rename' }, { name: 'loop' }];

  it('extracts the command token from the first line', () => {
    expect(getCommandHighlightRange('/rename xxx')).toEqual({ start: 0, end: 7 });
    expect(getCommandHighlightRange('/loop stop')).toEqual({ start: 0, end: 5 });
    expect(getCommandHighlightRange('/loop')).toEqual({ start: 0, end: 5 });
  });

  it('returns null for non-command or ambiguous input', () => {
    expect(getCommandHighlightRange('')).toBeNull();
    expect(getCommandHighlightRange('plain text')).toBeNull();
    expect(getCommandHighlightRange('/')).toBeNull();
    expect(getCommandHighlightRange('// comment')).toBeNull();
    expect(getCommandHighlightRange('second line\n/loop')).toBeNull();
  });

  it('only highlights known commands', () => {
    expect(resolveCommandHighlight('/rename xxx', true, commands)).toEqual({ start: 0, end: 7 });
    expect(resolveCommandHighlight('/loop', true, commands)).toEqual({ start: 0, end: 5 });
    expect(resolveCommandHighlight('/unknown xxx', true, commands)).toBeNull();
    expect(resolveCommandHighlight('/rename xxx', false, commands)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { Cursor } from './CursorInput.js';

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

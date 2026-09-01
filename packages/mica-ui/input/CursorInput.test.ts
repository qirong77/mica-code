import { describe, expect, it } from 'vitest';
import {
  Cursor,
  buildTextHandler,
  getCommandHighlightRange,
  isRedoShortcut,
  isUndoShortcut,
  MinimalEditHistory,
  resolveCommandHighlight,
} from './CursorInput.js';

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

describe('undo/redo shortcuts', () => {
  it('detects Ctrl+Z as undo and Ctrl+Y / Cmd+Shift+Z as redo', () => {
    expect(isUndoShortcut({ ctrl: true }, '\x1a')).toBe(true);
    expect(isUndoShortcut({ ctrl: true }, 'z')).toBe(true); // CSI u Ctrl+Z
    expect(isUndoShortcut({ ctrl: true }, 'Z')).toBe(true);
    expect(isUndoShortcut({ meta: true }, 'z')).toBe(true);
    expect(isUndoShortcut({ meta: true }, 'Z')).toBe(true);
    expect(isUndoShortcut({ ctrl: true, shift: true }, '\x1a')).toBe(false);
    expect(isUndoShortcut({ ctrl: true, shift: true }, 'z')).toBe(false); // Ctrl+Shift+Z 是 redo
    expect(isUndoShortcut({ meta: true, shift: true }, 'z')).toBe(false);
    expect(isUndoShortcut({ meta: true }, 'x')).toBe(false);

    expect(isRedoShortcut({ meta: true, shift: true }, 'z')).toBe(true);
    expect(isRedoShortcut({ meta: true, shift: true }, 'Z')).toBe(true);
    expect(isRedoShortcut({ ctrl: true }, '\x19')).toBe(true); // Ctrl+Y
    expect(isRedoShortcut({ ctrl: true }, 'y')).toBe(false); // 'y' 不是 Ctrl+Y 的 ASCII
    expect(isRedoShortcut({ ctrl: true, shift: true }, '\x1a')).toBe(true);
    expect(isRedoShortcut({ ctrl: true, shift: true }, 'z')).toBe(true);
    expect(isRedoShortcut({ ctrl: true }, '\x1a')).toBe(false);
  });
});

function createEditor(initial: string = '') {
  let value = initial;
  let offset = initial.length;
  const history = new MinimalEditHistory();
  function call(input: string, key: any) {
    const { onInput } = buildTextHandler({
      value,
      onChange: (v) => {
        value = v;
      },
      onOffsetChange: (o) => {
        offset = o;
      },
      multiline: true,
      cursorChar: '',
      invert: (t) => t,
      columns: 80,
      externalOffset: offset,
      maxVisibleLines: 6,
      disableCursorMovementForUpDownKeys: false,
      editingHistory: history,
    });
    onInput(input, key);
    return { value, offset };
  }
  return { history, call };
}

describe('input undo/redo', () => {
  const undoKey = () => ({ ctrl: true });
  const redoKey = () => ({ ctrl: true, shift: true });

  it('undoes and redoes sequential character edits', () => {
    const { call } = createEditor();
    call('h', {});
    call('i', {});
    expect(call('\x1a', undoKey()).value).toBe('h');
    expect(call('\x1a', undoKey()).value).toBe('');
    expect(call('\x1a', undoKey()).value).toBe(''); // nothing left to undo

    expect(call('\x1a', redoKey()).value).toBe('h');
    expect(call('\x1a', redoKey()).value).toBe('hi');
  });

  it('clears the redo stack once a new edit is made after undo', () => {
    const { call } = createEditor();
    call('a', {});
    call('b', {});
    call('\x1a', undoKey()); // undo to 'a'
    call('x', {}); // new edit after undo
    expect(call('\x1a', redoKey()).value).toBe('ax'); // redo cleared
    expect(call('\x1a', undoKey()).value).toBe('a'); // undo 'x'
    expect(call('\x1a', undoKey()).value).toBe(''); // undo 'a'
  });

  it('tracks the cursor offset across undo/redo', () => {
    const { call } = createEditor();
    call('a', {});
    call('b', {});
    expect(call('\x1a', undoKey())).toEqual({ value: 'a', offset: 1 });
    expect(call('\x1a', undoKey())).toEqual({ value: '', offset: 0 });
    expect(call('\x1a', redoKey())).toEqual({ value: 'a', offset: 1 });
  });
});

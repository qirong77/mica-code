import {describe, expect, it} from 'vitest';
import {planMarkdownSourceIndent} from '../../sourceEditing';

function apply(value: string, start: number, end: number, outdent = false) {
  const edit = planMarkdownSourceIndent(value, start, end, outdent);
  return edit ? {value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), start: edit.selectionStart, end: edit.selectionEnd} : null;
}

describe('Markdown source indentation', () => {
  it('inserts two spaces at a caret and replaces a single-line selection', () => {
    expect(apply('abc', 1, 1)).toEqual({value: 'a  bc', start: 3, end: 3});
    expect(apply('abc', 1, 2)).toEqual({value: 'a  c', start: 3, end: 3});
    expect(apply('', 0, 0)).toEqual({value: '  ', start: 2, end: 2});
  });
  it('indents only selected lines, retaining the original selection text', () => {
    expect(apply('one\ntwo\nthree', 1, 7)).toEqual({value: '  one\n  two\nthree', start: 3, end: 11});
    expect(apply('one\ntwo\nthree', 0, 4)).toEqual({value: '  one\ntwo\nthree', start: 2, end: 6});
    expect(apply('\none\ntwo', 0, 4)).toEqual({value: '  \n  one\ntwo', start: 2, end: 8});
  });
  it('outdents mixed indentation without swallowing line contents', () => {
    expect(apply('  one\n two\n\tthree\nfour', 0, 17, true)).toEqual({value: 'one\ntwo\nthree\nfour', start: 0, end: 13});
    expect(apply('  abc', 1, 4, true)).toEqual({value: 'abc', start: 0, end: 2});
    expect(apply('abc', 2, 2, true)).toBeNull();
  });
});

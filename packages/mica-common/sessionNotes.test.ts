import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_NOTES_LENGTH,
  appendSessionNotes,
  normalizeSessionNotes,
  notesSections,
  replaceNotesSection,
  sessionNotesSummary,
} from './sessionNotes.js';

describe('normalizeSessionNotes', () => {
  it('treats non-strings as empty notes', () => {
    expect(normalizeSessionNotes(undefined)).toBe('');
    expect(normalizeSessionNotes(null)).toBe('');
    expect(normalizeSessionNotes(42)).toBe('');
    expect(normalizeSessionNotes({ content: 'x' })).toBe('');
  });

  it('unifies line endings and strips trailing whitespace', () => {
    expect(normalizeSessionNotes('a\r\nb\r\n')).toBe('a\nb');
    expect(normalizeSessionNotes('line   \nnext\t\n\n\n')).toBe('line\nnext');
    expect(normalizeSessionNotes('\n\n  keep inner  spaces  \n\n')).toBe('  keep inner  spaces');
  });

  it('clamps to the hard limit so the prompt cannot grow without bound', () => {
    const long = 'x'.repeat(MAX_SESSION_NOTES_LENGTH + 500);
    expect(normalizeSessionNotes(long)).toHaveLength(MAX_SESSION_NOTES_LENGTH);
  });
});

describe('appendSessionNotes', () => {
  it('separates the appended block with one blank line', () => {
    expect(appendSessionNotes('a', 'b')).toBe('a\n\nb');
  });

  it('keeps the current notes when the addition is empty', () => {
    expect(appendSessionNotes('a', '   ')).toBe('a');
    expect(appendSessionNotes('a', '\n\n')).toBe('a');
  });

  it('works on empty notes without leaving a leading blank line', () => {
    expect(appendSessionNotes('', 'first')).toBe('first');
  });
});

describe('sessionNotesSummary', () => {
  it('counts characters and lines of the normalized text', () => {
    expect(sessionNotesSummary('a\nb')).toEqual({ chars: 3, lines: 2 });
    expect(sessionNotesSummary('  ')).toEqual({ chars: 0, lines: 0 });
  });
});

describe('section editing', () => {
  it('reports the heading level and line of every section, skipping fenced code', () => {
    const notes = ['# a', '```', '# not a heading', '```', '## b'].join('\n');
    expect(notesSections(notes)).toEqual([
      { heading: 'a', level: 1, line: 0 },
      { heading: 'b', level: 2, line: 4 },
    ]);
  });

  // 超限必须由调用方判断再决定写不写：这里若顺手截断，调用方看到的永远是「刚好等于上限」，
  // 用户会拿到一份被砍掉尾巴的笔记。
  it('never truncates the result of a section edit', () => {
    const filler = 'x'.repeat(MAX_SESSION_NOTES_LENGTH - 100);
    const result = replaceNotesSection(`# 大\n${filler}\n\n# 小\n- a`, '小', 'y'.repeat(500));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.notes.length).toBeGreaterThan(MAX_SESSION_NOTES_LENGTH);
  });
});

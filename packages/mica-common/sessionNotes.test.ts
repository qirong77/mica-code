import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_NOTES_LENGTH,
  appendSessionNotes,
  formatSessionNotesSection,
  normalizeSessionNotes,
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

describe('formatSessionNotesSection', () => {
  it('returns nothing for empty notes so the prompt keeps its shape', () => {
    expect(formatSessionNotesSection('')).toBe('');
    expect(formatSessionNotesSection('   \n')).toBe('');
  });

  it('wraps the notes in a section that explains they are not a new instruction', () => {
    const section = formatSessionNotesSection('# 决策\n用 Bun');
    expect(section.startsWith('<session-notes>')).toBe(true);
    expect(section.endsWith('</session-notes>')).toBe(true);
    expect(section).toContain('# 决策\n用 Bun');
    expect(section).toContain('不会被上下文压缩掉');
    expect(section).toContain('SessionNotes');
  });
});

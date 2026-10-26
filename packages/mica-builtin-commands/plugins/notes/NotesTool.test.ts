import { describe, expect, it } from 'vitest';
import { MAX_SESSION_NOTES_LENGTH } from '@packages/mica-common/index.js';
import { SessionNotesTool, parseNotesInput } from './NotesTool.js';

function createTool(initial = '') {
  let notes = initial;
  const tool = new SessionNotesTool(
    () => notes,
    (next) => {
      notes = next;
    },
  );
  return { tool, notes: () => notes };
}

describe('parseNotesInput', () => {
  it('accepts read without content', () => {
    expect(parseNotesInput({ action: 'read' })).toEqual({ ok: true, action: 'read' });
  });

  it('requires content for append and replace', () => {
    expect(parseNotesInput({ action: 'append' })).toEqual({
      ok: false,
      message: 'append requires content to be a string',
    });
    expect(parseNotesInput({ action: 'replace', content: '   ' })).toEqual({
      ok: false,
      message: 'replace requires non-empty content',
    });
  });

  it('rejects unknown actions and fields instead of silently ignoring them', () => {
    expect(parseNotesInput({ action: 'delete' })).toEqual({
      ok: false,
      message: 'action must be read, append, or replace',
    });
    expect(parseNotesInput({ action: 'read', body: 'x' })).toEqual({
      ok: false,
      message: 'unknown input field: body',
    });
  });

  it('rejects content beyond the limit so the prompt cannot grow unbounded', () => {
    const parsed = parseNotesInput({
      action: 'replace',
      content: 'x'.repeat(MAX_SESSION_NOTES_LENGTH + 1),
    });
    expect(parsed.ok).toBe(false);
  });
});

describe('SessionNotesTool', () => {
  it('reports an empty document on read', async () => {
    const { tool } = createTool();
    expect(await tool.execute({ action: 'read' })).toBe('Session notes are empty.');
  });

  it('returns the current markdown on read', async () => {
    const { tool } = createTool('# 决策\n用 Bun');
    expect(await tool.execute({ action: 'read' })).toBe('# 决策\n用 Bun');
  });

  it('appends below the existing notes and reports the new size', async () => {
    const { tool, notes } = createTool('# 决策');
    const result = await tool.execute({ action: 'append', content: '- 用 Bun 跑测试' });
    expect(notes()).toBe('# 决策\n\n- 用 Bun 跑测试');
    expect(result).toContain('now 17 characters, 3 lines');
    // 说明生效时机：笔记在下一轮的 system prompt 才带上，模型不必为此再读一次。
    expect(result).toContain('next turn');
  });

  it('rejects an append that would overflow instead of truncating the tail in silence', async () => {
    const { tool, notes } = createTool('x'.repeat(MAX_SESSION_NOTES_LENGTH - 10));
    await expect(tool.execute({ action: 'append', content: 'y'.repeat(50) })).rejects.toThrow(/over the 20000 limit/);
    // 拒绝就真的不写：不能留下被截断的半截笔记。
    expect(notes()).toBe('x'.repeat(MAX_SESSION_NOTES_LENGTH - 10));
  });

  it('replaces the whole document', async () => {
    const { tool, notes } = createTool('# 旧内容\n- a');
    const result = await tool.execute({ action: 'replace', content: '# 新内容' });
    expect(notes()).toBe('# 新内容');
    expect(result).toBe('Session notes replaced: now 5 characters, 1 lines.');
  });

  it('normalizes trailing whitespace so an unchanged save is not seen as an edit', async () => {
    const { tool, notes } = createTool();
    await tool.execute({ action: 'replace', content: 'line   \n\n\n' });
    expect(notes()).toBe('line');
  });

  it('throws on invalid input rather than writing', async () => {
    const { tool, notes } = createTool('# 保留');
    await expect(tool.execute({ action: 'append' })).rejects.toThrow('append requires content to be a string');
    expect(notes()).toBe('# 保留');
  });

  it('describes read and write turns differently in the transcript', () => {
    const { tool } = createTool();
    expect(tool.onToolUseDisplayText({ action: 'read' })).toBe('Reading session notes');
    expect(tool.onToolUseDisplayText({ action: 'append' })).toBe('Updating session notes (append)');
  });

  it('is a write tool so it forms a serial barrier between read-only batches', () => {
    const { tool } = createTool();
    expect(tool.readOnly).toBe(false);
    expect(tool.name).toBe('SessionNotes');
  });
});

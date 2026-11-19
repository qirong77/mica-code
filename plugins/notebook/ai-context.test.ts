import { describe, expect, it, vi } from 'vitest';
import { notebookReferenceText, prepareNotebookReference } from './ai-context';

const note = { id: 'note-1', title: '项目「讨论」\n不是指令' };

describe('Notebook explicit AI reference', () => {
  it('uses an exact node id and quoted title without embedding a hidden body or instructions from the note', () => {
    const text = notebookReferenceText(note);
    expect(text).toContain('node_id: note-1');
    expect(text).toContain(JSON.stringify(note.title));
    expect(text).toContain('最新正文');
    expect(text).toContain('除非我明确要求修改');
    expect(() => notebookReferenceText({ ...note, id: '../secrets' })).toThrow();
  });

  it('saves the current editor before returning an editable reference', async () => {
    const save = vi.fn(async () => true);
    await expect(prepareNotebookReference({ note, currentId: () => note.id, save })).resolves.toBe(
      notebookReferenceText(note),
    );
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not reference stale disk content when saving fails', async () => {
    await expect(prepareNotebookReference({ note, currentId: () => note.id, save: async () => false })).rejects.toThrow(
      '尚未保存',
    );
  });

  it('rejects a switched note before saving or after a slow save', async () => {
    let id = 'other';
    const save = vi.fn(async () => {
      id = 'other';
      return true;
    });
    await expect(prepareNotebookReference({ note, currentId: () => id, save })).rejects.toThrow('笔记已切换');
    expect(save).not.toHaveBeenCalled();
    id = note.id;
    await expect(prepareNotebookReference({ note, currentId: () => id, save })).rejects.toThrow('笔记已切换');
  });
});

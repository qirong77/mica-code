import { describe, expect, it, vi } from 'vitest';
import { createNotebookExternalUpdateCheck } from './external-updates';
import type { NotebookDraft } from './writer';

const draft = (version: string): NotebookDraft => ({
  id: 'note',
  document: { version: 1, editorState: null },
  version,
  saved: '',
  dirty: false,
  unconfirmed: false,
});

describe('notebook external update checks', () => {
  it('coalesces overlapping checks and reports a changed active document without replacing the draft', async () => {
    let current = draft('old');
    let reads = 0;
    const changed = vi.fn();
    const observer = createNotebookExternalUpdateCheck({
      available: () => true,
      waitForWrites: async () => {},
      refreshIndex: async () => {},
      current: () => current,
      readVersion: async () => {
        reads += 1;
        return 'new';
      },
      changed,
      error: vi.fn(),
    });

    await Promise.all([observer.check(), observer.check()]);

    // A second request arriving while the first read is in flight schedules one follow-up pass,
    // so a write that lands during the first pass cannot be missed.
    expect(reads).toBe(2);
    expect(changed).toHaveBeenCalledWith('note');
    expect(current.version).toBe('old');
    observer.dispose();
  });

  it('does not report a stale read after the active draft changes', async () => {
    let current = draft('old');
    const changed = vi.fn();
    const observer = createNotebookExternalUpdateCheck({
      available: () => true,
      waitForWrites: async () => {},
      refreshIndex: async () => {},
      current: () => current,
      readVersion: async () => {
        current = draft('replacement');
        return 'new';
      },
      changed,
      error: vi.fn(),
    });

    await observer.check();

    expect(changed).not.toHaveBeenCalled();
    observer.dispose();
  });
});

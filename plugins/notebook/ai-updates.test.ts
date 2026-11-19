import { describe, expect, it, vi } from 'vitest';
import { createNotebookUpdateCheck } from './ai-updates';
import { createNotebookDraft } from './writer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let draft = createNotebookDraft('a', { value: { version: 1, editorState: null }, version: 'v1', missing: false });
  const options = {
    available: () => true,
    waitForWrites: vi.fn(async () => {}),
    refreshIndex: vi.fn(async () => {}),
    current: () => draft,
    readVersion: vi.fn(async (_id: string): Promise<string | null> => 'v2'),
    changed: vi.fn(),
    error: vi.fn(),
  };
  return {
    options,
    switchNote: () => {
      draft = { ...draft, id: 'b' };
    },
    get draft() {
      return draft;
    },
  };
}

describe('Notebook external AI updates', () => {
  it('only reports new versions and never replaces or marks a local draft saved', async () => {
    const f = fixture();
    f.draft.dirty = true;
    const before = JSON.stringify(f.draft);
    const observer = createNotebookUpdateCheck(f.options);
    await observer.check();
    expect(f.options.changed).toHaveBeenCalledWith('a');
    expect(JSON.stringify(f.draft)).toBe(before);
    f.options.readVersion.mockResolvedValue('v1');
    f.options.changed.mockClear();
    await observer.check();
    expect(f.options.changed).not.toHaveBeenCalled();
  });

  it('discards late reads after switching notes or closing the page', async () => {
    for (const close of [false, true]) {
      const f = fixture();
      const read = deferred<string>();
      const started = deferred<void>();
      f.options.readVersion.mockImplementation(async () => {
        started.resolve();
        return read.promise;
      });
      const observer = createNotebookUpdateCheck(f.options);
      const pending = observer.check();
      await started.promise;
      if (close) observer.dispose();
      else f.switchNote();
      read.resolve('v2');
      await pending;
      expect(f.options.changed).not.toHaveBeenCalled();
    }
  });

  it('waits for pending local writes and coalesces simultaneous refresh requests', async () => {
    const f = fixture();
    const writes = deferred<void>();
    f.options.waitForWrites.mockReturnValue(writes.promise);
    const observer = createNotebookUpdateCheck(f.options);
    const first = observer.check();
    const second = observer.check();
    expect(first).toBe(second);
    expect(f.options.readVersion).not.toHaveBeenCalled();
    writes.resolve();
    await first;
    expect(f.options.refreshIndex).toHaveBeenCalledTimes(2);
  });

  it('reports read failures without changing content and can retry', async () => {
    const f = fixture();
    f.options.readVersion.mockRejectedValueOnce(new Error('offline'));
    const observer = createNotebookUpdateCheck(f.options);
    await observer.check();
    expect(f.options.error).toHaveBeenCalledOnce();
    expect(f.draft.version).toBe('v1');
    await observer.check();
    expect(f.options.changed).toHaveBeenCalledWith('a');
  });
});

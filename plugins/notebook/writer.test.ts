import { describe, expect, it, vi } from 'vitest';
import { createNotebookController, NotebookConflictError } from './controller';
import type { NotebookHost, NotebookWriteResult } from './controller';
import { createNotebookDraft, createNotebookWriter, updateNotebookDraft } from './writer';
import type { NotebookDraft } from './writer';

function draft(id = 'a'): NotebookDraft {
  return {
    id,
    document: { version: 1, editorState: null },
    version: null,
    saved: '',
    dirty: true,
    unconfirmed: false,
  };
}

function deferred<T = string>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}

describe('Notebook autosave queue', () => {
  it('shares one drain across concurrent autosave, navigation and close, including edits made in flight', async () => {
    const first = deferred();
    const second = deferred();
    const saveDocument = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const writer = createNotebookWriter({ saveDocument });
    const value = draft();
    const saves = [writer.save(value), writer.save(value), writer.save(value)];
    await Promise.resolve();
    expect(saveDocument).toHaveBeenCalledTimes(1);
    value.document = { ...value.document, editorState: '{"root":{"text":"last input"}}' };
    first.resolve('v1');
    await vi.waitFor(() => expect(saveDocument).toHaveBeenCalledTimes(2));
    expect(saveDocument.mock.calls[1]).toEqual(['a', value.document, { expectedVersion: 'v1' }]);
    expect(value.dirty).toBe(true);
    second.resolve('v2');
    await Promise.all(saves);
    expect(saveDocument).toHaveBeenCalledTimes(2);
    expect(value).toMatchObject({ dirty: false, version: 'v2', saved: JSON.stringify(value.document) });
  });

  it('does not start concurrent retries when multiple callers were waiting for a failed save', async () => {
    const first = deferred(),
      retry = deferred();
    const saveDocument = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const writer = createNotebookWriter({ saveDocument });
    const value = draft();
    const failed = writer.save(value);
    const rejected = expect(failed).rejects.toThrow('temporarily offline');
    const waiters = [writer.save(value), writer.save(value)];
    first.reject(new Error('temporarily offline'));
    await rejected;
    await vi.waitFor(() => expect(saveDocument).toHaveBeenCalledTimes(2));
    expect(value).toMatchObject({ dirty: true, version: null });
    retry.resolve('retried');
    await Promise.all(waiters);
    expect(saveDocument).toHaveBeenCalledTimes(2);
    expect(value).toMatchObject({ dirty: false, version: 'retried' });
  });

  it('retains conflicting drafts and continues saving other documents without inventing a new version', async () => {
    const conflict = new NotebookConflictError('document a');
    const saveDocument = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce('b1')
      .mockResolvedValueOnce('a1');
    const writer = createNotebookWriter({ saveDocument });
    const a = draft('a'),
      b = draft('b');
    const failed = writer.save(a);
    const other = writer.save(b);
    await expect(failed).rejects.toBe(conflict);
    await other;
    expect(a).toMatchObject({ dirty: true, version: null, saved: '' });
    expect(b).toMatchObject({ dirty: false, version: 'b1' });
    await writer.save(a);
    expect(saveDocument.mock.calls[2]?.[2]).toEqual({ expectedVersion: null });
    expect(a).toMatchObject({ dirty: false, version: 'a1' });
  });

  it('waits for in-flight saves before a caller replaces the current draft', async () => {
    const pending = deferred();
    const writer = createNotebookWriter({ saveDocument: vi.fn(() => pending.promise) });
    const value = draft();
    const saved = writer.save(value);
    const idle = writer.idle();
    let settled = false;
    void idle.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve('committed');
    await idle;
    await saved;
    expect(value.version).toBe('committed');
  });

  it('keeps an undo to the old baseline unsaved after a committed write loses its response, including later flushes/retries', async () => {
    const a = draft().document;
    const b = { ...a, editorState: '{"root":{"text":"B"}}' };
    let disk = { value: a, version: 'A-version' };
    const response = deferred<NotebookWriteResult>();
    const written = deferred<void>();
    const host: NotebookHost = {
      readData: vi.fn(async () => ({ value: null, version: null })),
      writeData: vi.fn(async () => ({ ok: true })),
      documents: {
        read: vi.fn(async () => structuredClone(disk)),
        write: vi.fn(async (_id, document, options) => {
          if (options.expectedVersion !== disk.version) return { ok: false, conflict: true };
          disk = { value: structuredClone(document), version: 'B-version' };
          written.resolve();
          return response.promise;
        }),
      },
    };
    const controller = createNotebookController({ host });
    const writer = createNotebookWriter(controller);
    const value = createNotebookDraft('a', await controller.readDocument('a'));
    updateNotebookDraft(value, b);
    const saving = writer.save(value);
    const failed = expect(saving).rejects.toThrow('response lost');
    await written.promise;
    expect(disk.value).toEqual(b);
    updateNotebookDraft(value, a); // The editor's undo arrives while B is still awaiting its response.
    expect(value).toMatchObject({ dirty: true, unconfirmed: true });
    response.reject(new Error('response lost'));
    await failed;
    expect(value).toMatchObject({
      document: a,
      dirty: true,
      unconfirmed: true,
      version: 'A-version',
      saved: JSON.stringify(a),
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      updateNotebookDraft(value, structuredClone(a)); // A later iframe flush must not erase uncertainty.
      expect(value.dirty).toBe(true);
      await expect(writer.save(value)).rejects.toBeInstanceOf(NotebookConflictError);
      expect(value).toMatchObject({ document: a, dirty: true, unconfirmed: true, version: 'A-version' });
    }
    expect(vi.mocked(host.documents.write).mock.calls.map((call) => call[2])).toEqual([
      { expectedVersion: 'A-version' },
      { expectedVersion: 'A-version' },
      { expectedVersion: 'A-version' },
    ]);
    expect(disk.value).toEqual(b);
    // Only an explicit reload adopts the actual disk baseline; the failed draft stays exportable.
    const latest = createNotebookDraft('a', await controller.readDocument('a'));
    expect(latest).toMatchObject({ document: b, version: 'B-version', dirty: false, unconfirmed: false });
    expect(value.document).toEqual(a);
  });

  it('saves the final undo with the original CAS version when an unconfirmed write did not reach disk', async () => {
    const first = deferred();
    const saveDocument = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce('retry-version');
    const writer = createNotebookWriter({ saveDocument });
    const a = draft().document;
    const value = createNotebookDraft('a', { value: a, version: 'A-version', missing: false });
    updateNotebookDraft(value, { ...a, editorState: '{"root":{"text":"B"}}' });
    const saving = writer.save(value);
    const failed = expect(saving).rejects.toThrow('offline');
    await Promise.resolve();
    updateNotebookDraft(value, a);
    first.reject(new Error('offline'));
    await failed;
    updateNotebookDraft(value, a);
    await writer.save(value);
    expect(saveDocument.mock.calls[1]).toEqual(['a', a, { expectedVersion: 'A-version' }]);
    expect(value).toMatchObject({
      document: a,
      dirty: false,
      unconfirmed: false,
      saved: JSON.stringify(a),
      version: 'retry-version',
    });
  });

  it('drains an undo after the intermediate save is acknowledged and uses its confirmed version', async () => {
    const first = deferred(),
      second = deferred();
    const saveDocument = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const writer = createNotebookWriter({ saveDocument });
    const a = draft().document;
    const value = createNotebookDraft('a', { value: a, version: 'A-version', missing: false });
    updateNotebookDraft(value, { ...a, editorState: '{"root":{"text":"B"}}' });
    const saving = writer.save(value);
    await Promise.resolve();
    updateNotebookDraft(value, a);
    first.resolve('B-version');
    await vi.waitFor(() => expect(saveDocument).toHaveBeenCalledTimes(2));
    expect(saveDocument.mock.calls[1]).toEqual(['a', a, { expectedVersion: 'B-version' }]);
    expect(value).toMatchObject({ dirty: true, unconfirmed: true });
    second.resolve('final-A-version');
    await saving;
    expect(value).toMatchObject({
      document: a,
      dirty: false,
      unconfirmed: false,
      saved: JSON.stringify(a),
      version: 'final-A-version',
    });
  });
});

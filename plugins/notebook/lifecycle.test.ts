import { describe, expect, it, vi } from 'vitest';
import { createEditorBridge, NOTEBOOK_CHANNEL } from './bridge';
import { createNotebookLifecycle } from './lifecycle';
import type { NotebookDocument } from './model';
import { createNotebookDraft, createNotebookWriter, updateNotebookDraft } from './writer';
import type { NotebookDraft } from './writer';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const document = (text: string): NotebookDocument => ({ version: 1, editorState: null, comments: [{ text }] });
const draft = (id: string, text = id) =>
  createNotebookDraft(id, { value: document(text), version: `${id}-version`, missing: false });

async function fixture() {
  let current = draft('a');
  let loaded: string | null = null;
  let frozen = true;
  let frameDocument = current.document;
  let lastLoad: Record<string, unknown> = {};
  const saveDocument = vi.fn(async () => 'saved-version');
  const flushIndex = vi.fn(async () => {});
  const writer = createNotebookWriter({ saveDocument });
  const target = {
    postMessage: vi.fn((payload: Record<string, unknown>) => {
      if (payload.type === 'freeze') frozen = payload.frozen as boolean;
      if (payload.type === 'load') {
        lastLoad = payload;
        frameDocument = payload.document as NotebookDocument;
      }
      if (payload.type === 'flush')
        queueMicrotask(() => receive({ ...payload, type: 'result', document: frameDocument }));
    }),
  } as unknown as Window;
  const bridge = createEditorBridge({
    token: 'nonce',
    target: () => target,
    onReady: vi.fn(),
    onError: vi.fn(),
    onChange: (_id, value) => updateNotebookDraft(current, value),
  });
  function receive(data: Record<string, unknown>) {
    bridge.receive({ source: target, data: { channel: NOTEBOOK_CHANNEL, token: 'nonce', ...data } } as MessageEvent);
  }
  const lifecycle = createNotebookLifecycle({ freeze: bridge.freeze, canEdit: () => loaded === current.id });
  const load = async (next: NotebookDraft) => {
    current = next;
    loaded = null;
    try {
      await bridge.load(next.id, next.document);
      loaded = next.id;
    } finally {
      lifecycle.resume();
    }
  };
  const acknowledge = () => receive({ ...lastLoad, type: 'loaded' });
  const initial = load(current);
  acknowledge();
  await initial;
  const flush = vi.fn(async () => {
    const result = await bridge.flush();
    expect(result.noteId).toBe(current.id);
    updateNotebookDraft(current, result.document);
    await writer.save(current);
    await flushIndex();
    return true;
  });
  const input = (value: NotebookDocument) => {
    if (frozen) return false;
    frameDocument = value; // The iframe has not yet delivered its debounced change message.
    return true;
  };
  return {
    lifecycle,
    bridge,
    target,
    load,
    acknowledge,
    flush,
    flushIndex,
    saveDocument,
    input,
    current: () => current,
    frozen: () => frozen,
  };
}

describe('Notebook close lifecycle', () => {
  it('collects queued final input and blocks replacement/thaw throughout a slow index flush and successful close', async () => {
    const f = await fixture();
    const index = deferred();
    f.flushIndex.mockReturnValueOnce(index.promise);
    const finalInput = document('final input still in the iframe queue');
    expect(f.input(finalInput)).toBe(true);
    const closing = f.lifecycle.beforeClose(f.flush);
    expect(f.lifecycle.closing).toBe(true);
    expect(f.frozen()).toBe(true);
    await vi.waitFor(() => expect(f.flushIndex).toHaveBeenCalledOnce());
    expect(f.saveDocument).toHaveBeenCalledWith('a', finalInput, { expectedVersion: 'a-version' });

    const prepare = vi.fn(async () => draft('b'));
    await f.lifecycle.replace(prepare, f.load);
    f.lifecycle.resume(); // A late loader/finally callback also cannot thaw the editor.
    expect(prepare).not.toHaveBeenCalled();
    expect(f.input(document('unsafe new input'))).toBe(false);
    expect(f.current().id).toBe('a');
    expect(f.lifecycle.beforeClose(f.flush)).toBe(closing);
    index.resolve();
    await expect(closing).resolves.toBe(true);
    f.lifecycle.resume();
    expect(f.frozen()).toBe(true);
    expect(f.lifecycle.closing).toBe(true);
    expect(f.flush).toHaveBeenCalledOnce();
    f.bridge.dispose();
  });

  it.each(['open another note', 'reload the current note'])(
    'cancels a pending disk read for %s before applying it during close',
    async (operation) => {
      const f = await fixture();
      const read = deferred<NotebookDraft>();
      const prepare = vi.fn(() => read.promise);
      const apply = vi.fn(f.load);
      const replacing = f.lifecycle.replace(prepare, apply);
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      const closing = f.lifecycle.beforeClose(f.flush);
      expect(f.frozen()).toBe(true);
      expect(f.flush).not.toHaveBeenCalled();
      read.resolve(draft(operation === 'open another note' ? 'b' : 'a', 'latest disk body'));
      await replacing;
      await expect(closing).resolves.toBe(true);
      expect(apply).not.toHaveBeenCalled();
      expect(f.current().document).toEqual(document('a'));
      expect(f.frozen()).toBe(true);
      f.bridge.dispose();
    },
  );

  it.each(['b', 'a'])(
    'waits for an already-applied load of %s and never thaws from its finally before the close flush',
    async (id) => {
      const f = await fixture();
      const index = deferred();
      f.flushIndex.mockReturnValueOnce(index.promise);
      const replacing = f.lifecycle.replace(async () => draft(id, 'loaded body'), f.load);
      await vi.waitFor(() => expect(f.current().document).toEqual(document('loaded body')));
      const closing = f.lifecycle.beforeClose(f.flush);
      expect(f.flush).not.toHaveBeenCalled();
      vi.mocked(f.target.postMessage).mockClear();
      f.acknowledge();
      await replacing;
      await vi.waitFor(() => expect(f.flushIndex).toHaveBeenCalledOnce());
      const messages = vi.mocked(f.target.postMessage).mock.calls.map(([value]) => value);
      expect(messages.some((value) => value.type === 'flush' && value.noteId === id)).toBe(true);
      expect(messages.some((value) => value.type === 'freeze' && value.frozen === false)).toBe(false);
      expect(f.frozen()).toBe(true);
      expect(f.input(document('would be lost on unload'))).toBe(false);
      index.resolve();
      await expect(closing).resolves.toBe(true);
      f.bridge.dispose();
    },
  );

  it.each(['failed', 'thrown'])(
    'restores editing and replacement only after a %s close, allowing a later close attempt',
    async (failure) => {
      const f = await fixture();
      const result = deferred<boolean>();
      const failed = f.lifecycle.beforeClose(async () => {
        const ok = await result.promise;
        if (failure === 'thrown') throw new Error('flush failed');
        return ok;
      });
      const settled =
        failure === 'thrown' ? expect(failed).rejects.toThrow('flush failed') : expect(failed).resolves.toBe(false);
      f.lifecycle.resume();
      expect(f.frozen()).toBe(true);
      result.resolve(false);
      await settled;
      expect(f.lifecycle.closing).toBe(false);
      expect(f.frozen()).toBe(false);
      expect(f.input(document('draft retained after failure'))).toBe(true);
      const prepare = vi.fn(async () => {});
      await f.lifecycle.replace(prepare, () => {});
      expect(prepare).toHaveBeenCalledOnce();
      await expect(f.lifecycle.beforeClose(f.flush)).resolves.toBe(true);
      expect(f.saveDocument).toHaveBeenCalledWith('a', document('draft retained after failure'), {
        expectedVersion: 'a-version',
      });
      expect(f.frozen()).toBe(true);
      f.bridge.dispose();
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import {
  NotebookConflictError,
  NotebookStorageError,
  NotebookVerificationError,
  createNotebookController,
} from './controller';
import type {
  NotebookHost,
  NotebookReadResult,
  NotebookStatus,
  NotebookStorageVersion,
  NotebookWriteOptions,
  NotebookWriteResult,
} from './controller';
import {
  NotebookValidationError,
  createNode,
  emptyDocument,
  emptyIndex,
  renameNode,
} from './model';
import type { NotebookDocument, NotebookIndex } from './model';

const NOW = '2026-11-01T08:00:00.000Z';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function indexWithNote(): NotebookIndex {
  return createNode(emptyIndex(), { kind: 'note', parentId: null, title: 'Original', id: 'n', now: NOW });
}

function body(text: string): NotebookDocument {
  return { version: 1, editorState: JSON.stringify({ root: { text } }) };
}

/** In-memory host with opaque versions; no filesystem or global config access. */
function memoryHost(initialIndex: unknown = null, initialDocument?: NotebookDocument) {
  let counter = 0;
  const nextVersion = () => `opaque-${++counter}`;
  let storedIndex: NotebookReadResult = { value: clone(initialIndex), version: initialIndex === null ? null : nextVersion() };
  const documents = new Map<string, NotebookReadResult>();
  if (initialDocument) documents.set('n', { value: clone(initialDocument), version: nextVersion() });
  const host: NotebookHost = {
    readData: vi.fn(async () => clone(storedIndex)),
    writeData: vi.fn(async (value: NotebookIndex, options: NotebookWriteOptions) => {
      if (options.expectedVersion !== storedIndex.version) return { ok: false, conflict: true };
      storedIndex = { value: clone(value), version: nextVersion() };
      return { ok: true };
    }),
    documents: {
      read: vi.fn(async (id: string) => clone(documents.get(id) ?? { value: null, version: null })),
      write: vi.fn(async (id: string, value: NotebookDocument, options: NotebookWriteOptions) => {
        if (options.expectedVersion !== (documents.get(id)?.version ?? null)) return { ok: false, conflict: true };
        documents.set(id, { value: clone(value), version: nextVersion() });
        return { ok: true };
      }),
    },
  };
  return {
    host,
    index: () => clone(storedIndex),
    document: (id = 'n') => clone(documents.get(id) ?? { value: null, version: null }),
    externalIndex: (value: unknown) => { storedIndex = { value: clone(value), version: nextVersion() }; },
    externalDocument: (value: unknown, id = 'n') => { documents.set(id, { value: clone(value), version: nextVersion() }); },
  };
}

describe('Notebook index controller', () => {
  it('loads a missing index without writing and publishes detached snapshots', async () => {
    const { host } = memoryHost();
    const statuses: NotebookStatus[] = [];
    const published: NotebookIndex[] = [];
    const controller = createNotebookController({ host, onIndex: (value) => published.push(value), onStatus: (status) => statuses.push(status) });
    const loaded = await controller.loadIndex();
    expect(loaded).toEqual(emptyIndex());
    expect(published).toEqual([emptyIndex()]);
    expect(published[0]).not.toBe(loaded);
    expect(statuses.map((status) => status.phase)).toEqual(['loading', 'loaded']);
    expect(host.writeData).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, value: null, version: null, error: 'permission denied' },
    { value: null, version: null, error: 'invalid JSON' },
    { value: null, version: 'stored-json-null' },
    { value: undefined, version: null },
    { value: {}, version: 'opaque' },
    { value: { version: 2, nodes: [] }, version: 'opaque' },
    { value: emptyIndex(), version: null },
    { value: emptyIndex(), version: '' },
    { value: emptyIndex(), version: undefined },
  ])('never resets or writes failed/corrupt/malformed reads: %j', async (readResult) => {
    const { host } = memoryHost();
    vi.mocked(host.readData).mockResolvedValue(readResult as NotebookReadResult);
    const statuses: NotebookStatus[] = [];
    const controller = createNotebookController({ host, onStatus: (status) => statuses.push(status) });
    await expect(controller.loadIndex()).rejects.toBeInstanceOf(Error);
    await expect(controller.mutateIndex((index) => createNode(index, { kind: 'note', parentId: null, title: 'Keep draft', id: 'n', now: NOW }))).rejects.toBeInstanceOf(Error);
    expect(host.writeData).not.toHaveBeenCalled();
    expect(controller.getPendingIndexCount()).toBe(1);
    expect(statuses.some((status) => status.phase === 'saved')).toBe(false);
  });

  it('serializes mutations and rereads the latest index for each CAS', async () => {
    const storage = memoryHost();
    const controller = createNotebookController({ host: storage.host });
    const first = controller.mutateIndex((index) => createNode(index, { kind: 'folder', parentId: null, title: 'Folder', id: 'f', now: NOW }));
    const second = controller.mutateIndex((index) => createNode(index, { kind: 'note', parentId: 'f', title: 'Note', id: 'n', now: NOW }));
    const [one, two] = await Promise.all([first, second]);
    expect(one.nodes.map((node) => node.id)).toEqual(['f']);
    expect(two.nodes.map((node) => node.id)).toEqual(['f', 'n']);
    expect(storage.index().value).toEqual(two);
    expect(storage.host.readData).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storage.host.writeData).mock.calls.map(([, options]) => options.expectedVersion)).toEqual([null, 'opaque-1']);
    expect(controller.getPendingIndexCount()).toBe(0);
  });

  it('retries only the index operation on CAS conflict and preserves another window’s changes', async () => {
    const storage = memoryHost(indexWithNote());
    const { host } = storage;
    const commit = host.writeData;
    let injected = false;
    host.writeData = vi.fn(async (value: NotebookIndex, options: NotebookWriteOptions) => {
      if (!injected) {
        injected = true;
        storage.externalIndex(createNode(indexWithNote(), { kind: 'note', parentId: null, title: 'External', id: 'external', now: NOW }));
        return { ok: false, conflict: true };
      }
      return commit(value, options);
    });
    const operation = vi.fn((index: NotebookIndex) => renameNode(index, 'n', 'Local', NOW));
    const controller = createNotebookController({ host });
    const result = await controller.mutateIndex(operation);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(result.nodes.map((node) => [node.id, node.title])).toEqual([['n', 'Local'], ['external', 'External']]);
    expect(storage.index().value).toEqual(result);
  });

  it('retains a failed write and retries it before later queued operations', async () => {
    const storage = memoryHost(indexWithNote());
    const statuses: NotebookStatus[] = [];
    vi.mocked(storage.host.writeData).mockResolvedValueOnce({ ok: false, error: 'disk full' });
    const controller = createNotebookController({ host: storage.host, onStatus: (status) => statuses.push(status) });
    await expect(controller.mutateIndex((index) => renameNode(index, 'n', 'Retained', NOW))).rejects.toThrow('disk full');
    expect(controller.getPendingIndexCount()).toBe(1);
    expect(statuses.map((status) => status.phase)).toEqual(['saving', 'error']);
    expect((storage.index().value as NotebookIndex).nodes[0]?.title).toBe('Original');

    const result = await controller.mutateIndex((index) => {
      expect(index.nodes[0]?.title).toBe('Retained');
      return createNode(index, { kind: 'folder', parentId: null, title: 'Next', id: 'f', now: NOW });
    });
    expect(result.nodes.map((node) => node.title)).toEqual(['Retained', 'Next']);
    expect(controller.getPendingIndexCount()).toBe(0);
    expect(statuses.at(-1)).toMatchObject({ phase: 'saved', pendingIndexCount: 0 });
  });

  it('keeps the whole queue on persistent failure and supports explicit flush retry', async () => {
    const storage = memoryHost(indexWithNote());
    const write = storage.host.writeData;
    storage.host.writeData = vi.fn(async () => ({ ok: false, error: 'unavailable' }));
    const controller = createNotebookController({ host: storage.host });
    await expect(controller.mutateIndex((index) => renameNode(index, 'n', 'First', NOW))).rejects.toThrow('unavailable');
    await expect(controller.mutateIndex((index) => renameNode(index, 'n', 'Second', NOW))).rejects.toThrow('unavailable');
    expect(controller.getPendingIndexCount()).toBe(2);
    storage.host.writeData = write;
    expect((await controller.flushIndex()).nodes[0]?.title).toBe('Second');
    expect(controller.getPendingIndexCount()).toBe(0);
    expect((storage.index().value as NotebookIndex).nodes[0]?.title).toBe('Second');
  });

  it('can verify an ambiguously acknowledged index write without replaying a stable-id create', async () => {
    const storage = memoryHost();
    const commit = storage.host.writeData;
    storage.host.writeData = vi.fn(async (value: NotebookIndex, options: NotebookWriteOptions) => {
      await commit(value, options);
      throw new Error('response lost after disk replacement');
    });
    const controller = createNotebookController({ host: storage.host });
    await expect(controller.mutateIndex((index) => createNode(index, { kind: 'note', parentId: null, title: 'Created', id: 'n', now: NOW }))).rejects.toThrow('response lost');
    expect(controller.getPendingIndexCount()).toBe(1);
    expect((await controller.flushIndex()).nodes.map((node) => node.id)).toEqual(['n']);
    expect(controller.getPendingIndexCount()).toBe(0);
    expect(storage.host.writeData).toHaveBeenCalledTimes(1);
  });

  it('caps conflict retries, retains the pending edit, and does not report saved', async () => {
    const storage = memoryHost(indexWithNote());
    const statuses: NotebookStatus[] = [];
    vi.mocked(storage.host.writeData).mockResolvedValue({ ok: false, conflict: true });
    const controller = createNotebookController({ host: storage.host, maxIndexAttempts: 2, onStatus: (status) => statuses.push(status) });
    await expect(controller.mutateIndex((index) => renameNode(index, 'n', 'Pending', NOW))).rejects.toBeInstanceOf(NotebookConflictError);
    expect(storage.host.writeData).toHaveBeenCalledTimes(2);
    expect(controller.getPendingIndexCount()).toBe(1);
    expect(statuses.map((status) => status.phase)).toEqual(['saving', 'conflict']);
  });

  it('handles no-ops and rejects impossible operations without poisoning later writes', async () => {
    const { host } = memoryHost(indexWithNote());
    const controller = createNotebookController({ host });
    expect((await controller.mutateIndex((index) => renameNode(index, 'n', 'Original', NOW))).nodes[0]?.title).toBe('Original');
    expect(host.writeData).not.toHaveBeenCalled();
    await expect(controller.mutateIndex(() => null as unknown as NotebookIndex)).rejects.toBeInstanceOf(NotebookValidationError);
    expect(host.writeData).not.toHaveBeenCalled();
    expect(controller.getPendingIndexCount()).toBe(0);
    await expect(controller.flushIndex()).resolves.toBeDefined();
    await expect(controller.mutateIndex((index) => renameNode(index, 'n', 'Recovered', NOW))).resolves.toBeDefined();
  });

  it('does not let view callbacks change a committed result or break the queue', async () => {
    const storage = memoryHost(indexWithNote());
    const controller = createNotebookController({
      host: storage.host,
      onStatus() { throw new Error('unmounted view'); },
      onIndex(index) { index.nodes.length = 0; throw new Error('unmounted view'); },
    });
    const result = await controller.mutateIndex((index) => renameNode(index, 'n', 'Saved', NOW));
    expect(result.nodes[0]?.title).toBe('Saved');
    expect((storage.index().value as NotebookIndex).nodes[0]?.title).toBe('Saved');
  });
});

describe('Notebook document controller', () => {
  it('returns an explicit missing blank document and does not create it on read', async () => {
    const { host } = memoryHost();
    const controller = createNotebookController({ host });
    expect(await controller.readDocument('new-note')).toEqual({ value: emptyDocument(), version: null, missing: true });
    expect(host.documents.write).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, value: null, version: null, error: 'read failed' },
    { value: null, version: 'existing-json-null-file' },
    { value: { version: 2, editorState: null }, version: 'existing' },
    { value: { version: 1, editorState: 'broken JSON' }, version: 'existing' },
    { value: emptyDocument(), version: null },
  ])('does not open a failed/corrupt document as blank: %j', async (readResult) => {
    const { host } = memoryHost();
    vi.mocked(host.documents.read).mockResolvedValue(readResult as NotebookReadResult);
    const controller = createNotebookController({ host });
    await expect(controller.readDocument('n')).rejects.toBeInstanceOf(Error);
    expect(host.documents.write).not.toHaveBeenCalled();
  });

  it('saves a missing body with expectedVersion:null and returns its verified new opaque version', async () => {
    const storage = memoryHost();
    const statuses: NotebookStatus[] = [];
    const controller = createNotebookController({ host: storage.host, onStatus: (status) => statuses.push(status) });
    const draft = body('new note');
    const savedVersion = await controller.saveDocument('n', draft, { expectedVersion: null });
    expect(savedVersion).toBe(storage.document().version);
    expect(storage.document().value).toEqual(draft);
    expect(storage.host.documents.write).toHaveBeenCalledWith('n', draft, { expectedVersion: null });
    expect(storage.host.documents.read).toHaveBeenCalledTimes(1);
    expect(statuses.map((status) => status.phase)).toEqual(['saving', 'saved']);
  });

  it('uses a host-returned committed version without a follow-up read', async () => {
    const { host } = memoryHost();
    vi.mocked(host.documents.write).mockResolvedValue({ ok: true, version: 'committed-1' });
    const controller = createNotebookController({ host });
    expect(await controller.saveDocument('n', body('one'), { expectedVersion: null })).toBe('committed-1');
    expect(host.documents.read).not.toHaveBeenCalled();
  });

  it('rejects stale same-note saves explicitly; another window’s content and the draft are unchanged', async () => {
    const storage = memoryHost(null, body('original'));
    const statuses: NotebookStatus[] = [];
    const controller = createNotebookController({ host: storage.host, onStatus: (status) => statuses.push(status) });
    const loaded = await controller.readDocument('n');
    const draft = body('local draft');
    storage.externalDocument(body('other window'));
    await expect(controller.saveDocument('n', draft, { expectedVersion: loaded.version })).rejects.toBeInstanceOf(NotebookConflictError);
    expect(storage.document().value).toEqual(body('other window'));
    expect(draft).toEqual(body('local draft'));
    expect(storage.host.documents.write).toHaveBeenCalledTimes(1);
    expect(statuses.some((status) => status.phase === 'saved')).toBe(false);
    expect(statuses.at(-1)?.phase).toBe('conflict');
  });

  it('serializes same-note writes but does not advance a stale caller version for it', async () => {
    const storage = memoryHost(null, body('original'));
    const controller = createNotebookController({ host: storage.host });
    const loaded = await controller.readDocument('n');
    const first = controller.saveDocument('n', body('first'), { expectedVersion: loaded.version });
    const second = controller.saveDocument('n', body('second'), { expectedVersion: loaded.version });
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0]?.status).toBe('fulfilled');
    expect(settled[1]).toMatchObject({ status: 'rejected', reason: expect.any(NotebookConflictError) });
    expect(storage.document().value).toEqual(body('first'));
    const refreshed = await controller.readDocument('n');
    await expect(controller.saveDocument('n', body('second'), { expectedVersion: refreshed.version })).resolves.toBeTypeOf('string');
  });

  it('detects a write between acknowledgment and verification; never associates that version with a stale draft', async () => {
    const storage = memoryHost(null, body('original'));
    const statuses: NotebookStatus[] = [];
    const commit = storage.host.documents.write;
    // Reassign rather than mockImplementation: keep the original mock as the real CAS writer.
    storage.host.documents.write = vi.fn(async (id: string, value: NotebookDocument, options: NotebookWriteOptions) => {
      const result = await commit(id, value, options);
      if (result.ok) storage.externalDocument(body('racing writer'), id);
      return result;
    });
    const controller = createNotebookController({ host: storage.host, onStatus: (status) => statuses.push(status) });
    const expectedVersion = storage.document().version;
    await expect(controller.saveDocument('n', body('local'), { expectedVersion })).rejects.toMatchObject({ conflict: true, mayHaveSaved: true });
    expect(storage.document().value).toEqual(body('racing writer'));
    expect(statuses.map((status) => status.phase)).toEqual(['saving', 'conflict']);
  });

  it('reports an unverified acknowledgment as uncertain, not saved', async () => {
    const storage = memoryHost();
    const statuses: NotebookStatus[] = [];
    vi.mocked(storage.host.documents.read).mockResolvedValue({ value: null, version: null, ok: false, error: 'read unavailable' });
    const controller = createNotebookController({ host: storage.host, onStatus: (status) => statuses.push(status) });
    await expect(controller.saveDocument('n', body('local'), { expectedVersion: null })).rejects.toBeInstanceOf(NotebookVerificationError);
    expect(storage.document().value).toEqual(body('local'));
    expect(statuses.map((status) => status.phase)).toEqual(['saving', 'error']);
  });

  it.each([
    { ok: false, error: 'disk full' },
    { ok: true, error: 'write did not finish' },
    { ok: false },
  ])('does not report saved on rejected/malformed disk acknowledgments: %j', async (writeResult) => {
    const { host } = memoryHost();
    const statuses: NotebookStatus[] = [];
    vi.mocked(host.documents.write).mockResolvedValue(writeResult as NotebookWriteResult);
    const controller = createNotebookController({ host, onStatus: (status) => statuses.push(status) });
    const draft = body('keep me');
    await expect(controller.saveDocument('n', draft, { expectedVersion: null })).rejects.toBeInstanceOf(NotebookStorageError);
    expect(host.documents.read).not.toHaveBeenCalled();
    expect(draft).toEqual(body('keep me'));
    expect(statuses.map((status) => status.phase)).toEqual(['saving', 'error']);
  });

  it('recovers same-note scheduling after a thrown storage error, with caller-controlled retry', async () => {
    const storage = memoryHost();
    vi.mocked(storage.host.documents.write).mockRejectedValueOnce(new Error('disconnected'));
    const controller = createNotebookController({ host: storage.host });
    await expect(controller.saveDocument('n', body('draft'), { expectedVersion: null })).rejects.toThrow('disconnected');
    await expect(controller.saveDocument('n', body('draft'), { expectedVersion: null })).resolves.toBeTypeOf('string');
  });

  it('requires an explicit version and rejects unsafe ids/invalid drafts before host access', async () => {
    const { host } = memoryHost();
    const controller = createNotebookController({ host });
    await expect(controller.saveDocument('n', body('draft'), {} as { expectedVersion: NotebookStorageVersion })).rejects.toThrow('version');
    await expect(controller.saveDocument('../n', body('draft'), { expectedVersion: null })).rejects.toThrow('id');
    await expect(controller.readDocument('../n')).rejects.toThrow('id');
    await expect(controller.saveDocument('n', { ...emptyDocument(), editorState: 'bad' }, { expectedVersion: null })).rejects.toBeInstanceOf(NotebookValidationError);
    expect(host.documents.write).not.toHaveBeenCalled();
    expect(host.documents.read).not.toHaveBeenCalled();
  });

  it('captures the submitted document immediately, even when the editor replaces it before write', async () => {
    const storage = memoryHost();
    const controller = createNotebookController({ host: storage.host });
    const draft: NotebookDocument = body('submitted');
    const saved = controller.saveDocument('n', draft, { expectedVersion: null });
    draft.editorState = JSON.stringify({ root: { text: 'new unsaved edit' } });
    await saved;
    expect(storage.document().value).toEqual(body('submitted'));
  });
});

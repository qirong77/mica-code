import {
  emptyDocument,
  NotebookOperationError,
  NotebookValidationError,
  parseNotebookDocument,
  parseNotebookIndex,
  validateNotebookIndex,
  validateNodeId,
} from './model';
import type { NotebookDocument, NotebookIndex } from './model';

export type NotebookStorageVersion = string | null;

export interface NotebookReadResult {
  value: unknown;
  version: NotebookStorageVersion;
  ok?: boolean;
  error?: unknown;
}

export interface NotebookWriteResult {
  ok: boolean;
  conflict?: boolean;
  error?: unknown;
  /** Hosts may return the committed version to avoid the verification read. */
  version?: NotebookStorageVersion;
}

export interface NotebookWriteOptions {
  expectedVersion: NotebookStorageVersion;
}

/** Browser-only host contract: no filesystem/Node imports and no unconditional writes. */
export interface NotebookHost {
  readData(): Promise<NotebookReadResult>;
  writeData(value: NotebookIndex, options: NotebookWriteOptions): Promise<NotebookWriteResult>;
  documents: {
    read(key: string): Promise<NotebookReadResult>;
    write(key: string, value: NotebookDocument, options: NotebookWriteOptions): Promise<NotebookWriteResult>;
  };
}

export class NotebookStorageError extends Error {
  constructor(message: string, public readonly resource: string) {
    super(message);
    this.name = 'NotebookStorageError';
  }
}

export class NotebookConflictError extends NotebookStorageError {
  readonly conflict = true;

  constructor(resource: string, public readonly mayHaveSaved = false) {
    super(`Notebook ${resource} changed elsewhere; keep the draft and reload or merge explicitly`, resource);
    this.name = 'NotebookConflictError';
  }
}

/** The write was acknowledged but its version/content could not be verified. Keep the draft. */
export class NotebookVerificationError extends NotebookStorageError {
  readonly mayHaveSaved = true;

  constructor(resource: string, detail: string) {
    super(`Notebook ${resource} write could not be verified: ${detail}`, resource);
    this.name = 'NotebookVerificationError';
  }
}

export interface NotebookStatus {
  scope: 'index' | 'document';
  phase: 'loading' | 'loaded' | 'saving' | 'saved' | 'conflict' | 'error';
  id?: string;
  error?: Error;
  pendingIndexCount: number;
}

export interface NotebookDocumentSnapshot {
  value: NotebookDocument;
  version: NotebookStorageVersion;
  /** Only true for a missing file, not a stored JSON null or damaged file. */
  missing: boolean;
}

export interface NotebookController {
  loadIndex(): Promise<NotebookIndex>;
  /** Operations must be pure/replayable. Capture new ids/timestamps BEFORE the callback. */
  mutateIndex(operation: (latest: NotebookIndex) => NotebookIndex): Promise<NotebookIndex>;
  /** Retry retained operations in order. A rejected operation is never silently removed. */
  flushIndex(): Promise<NotebookIndex>;
  getPendingIndexCount(): number;
  readDocument(id: string): Promise<NotebookDocumentSnapshot>;
  /** No merge or conflict retry. Only clear the UI draft after this promise resolves. */
  saveDocument(id: string, value: NotebookDocument, options: NotebookWriteOptions): Promise<string>;
}

export interface NotebookControllerOptions {
  host: NotebookHost;
  onIndex?: (index: NotebookIndex) => void;
  onStatus?: (status: NotebookStatus) => void;
  /** CAS attempts per queued operation, including its first attempt. Default: 5. */
  maxIndexAttempts?: number;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'Notebook storage request failed');
}

function version(value: unknown): NotebookStorageVersion {
  if (value === null || (typeof value === 'string' && value.length > 0)) return value;
  throw new NotebookStorageError('Notebook host returned an invalid storage version', 'host');
}

function checkedRead(result: NotebookReadResult, resource: string): NotebookReadResult {
  if (!result || typeof result !== 'object' || result.ok === false || result.error != null) {
    throw new NotebookStorageError(`Unable to read notebook ${resource}: ${asError(result?.error).message}`, resource);
  }
  if (!Object.hasOwn(result, 'value')) {
    throw new NotebookStorageError(`Notebook ${resource} read did not return a value`, resource);
  }
  const storageVersion = version(result.version);
  if (result.value !== null && storageVersion === null) {
    throw new NotebookStorageError(`Notebook ${resource} read omitted the existing file version`, resource);
  }
  return { value: result.value, version: storageVersion };
}

function checkedWrite(result: NotebookWriteResult, resource: string): void {
  if (result?.conflict) throw new NotebookConflictError(resource);
  if (result?.ok !== true || result.error != null) {
    throw new NotebookStorageError(`Unable to save notebook ${resource}: ${asError(result?.error).message}`, resource);
  }
}

export function createNotebookController(options: NotebookControllerOptions): NotebookController {
  const { host, onIndex, onStatus } = options;
  const maxIndexAttempts = options.maxIndexAttempts ?? 5;
  if (!Number.isInteger(maxIndexAttempts) || maxIndexAttempts < 1 || maxIndexAttempts > 20) {
    throw new RangeError('maxIndexAttempts must be an integer between 1 and 20');
  }

  type PendingMutation = {
    sequence: number;
    operation: (latest: NotebookIndex) => NotebookIndex;
    attemptedValue?: string;
  };
  const pending: PendingMutation[] = [];
  let nextSequence = 0;
  let indexTail: Promise<void> = Promise.resolve();
  const documentTails = new Map<string, Promise<void>>();
  const rejectedOperations = new WeakSet<Error>();

  function notify(status: Omit<NotebookStatus, 'pendingIndexCount'>): void {
    try {
      onStatus?.({ ...status, pendingIndexCount: pending.length });
    } catch {
      // A view callback must never turn an acknowledged disk write into a storage failure.
    }
  }

  function publish(index: NotebookIndex): void {
    try {
      onIndex?.(validateNotebookIndex(index));
    } catch {
      // Give views a detached snapshot; neither mutation nor exceptions affect the queue.
    }
  }

  async function report<T>(
    scope: NotebookStatus['scope'],
    phase: 'loading' | 'saving',
    id: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    notify({ scope, phase, ...(id === undefined ? {} : { id }) });
    try {
      const result = await work();
      notify({ scope, phase: phase === 'loading' ? 'loaded' : 'saved', ...(id === undefined ? {} : { id }) });
      return result;
    } catch (cause) {
      const error = asError(cause);
      notify({ scope, phase: error instanceof NotebookConflictError ? 'conflict' : 'error', error, ...(id === undefined ? {} : { id }) });
      throw error;
    }
  }

  function indexSerial<T>(work: () => Promise<T>): Promise<T> {
    const result = indexTail.then(work);
    // Recover scheduling only. The original result rejects, and pending mutations stay intact.
    indexTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function documentSerial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = documentTails.get(id) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => undefined, () => undefined);
    documentTails.set(id, tail);
    void tail.then(() => {
      if (documentTails.get(id) === tail) documentTails.delete(id);
    });
    return result;
  }

  async function latestIndex(): Promise<{ value: NotebookIndex; version: NotebookStorageVersion }> {
    const result = checkedRead(await host.readData(), 'index');
    if (result.value === null && result.version !== null) {
      throw new NotebookStorageError('Stored notebook index is JSON null, not a missing file', 'index');
    }
    return { value: parseNotebookIndex(result.value), version: result.version };
  }

  async function commitMutation(entry: PendingMutation): Promise<NotebookIndex> {
    for (let attempt = 0; attempt < maxIndexAttempts; attempt++) {
      const latest = await latestIndex();
      const serializedLatest = JSON.stringify(latest.value);
      // A transport may reject AFTER the disk replacement. A retry can acknowledge the exact
      // attempted tree without replaying a create operation and falsely rejecting its stable id.
      if (entry.attemptedValue === serializedLatest) return latest.value;
      // Validate independently of the stored-null parser: returning null must not erase a tree.
      let candidate: NotebookIndex;
      try { candidate = validateNotebookIndex(entry.operation(validateNotebookIndex(latest.value))); }
      catch (error) {
        if (error instanceof NotebookOperationError || error instanceof NotebookValidationError) rejectedOperations.add(error);
        throw error;
      }
      const serializedCandidate = JSON.stringify(candidate);
      if (serializedCandidate === serializedLatest) return candidate;
      entry.attemptedValue = serializedCandidate;
      const result = await host.writeData(candidate, { expectedVersion: latest.version });
      if (result?.conflict) {
        delete entry.attemptedValue;
        continue;
      }
      checkedWrite(result, 'index');
      return candidate;
    }
    throw new NotebookConflictError('index');
  }

  async function drain(throughSequence: number): Promise<NotebookIndex> {
    let result: NotebookIndex | undefined;
    while (pending[0] && pending[0].sequence <= throughSequence) {
      try {
        result = await commitMutation(pending[0]);
      } catch (error) {
        // 确定不可能执行的目录操作不能堵死后续全部操作；IO/CAS失败仍保留重试。
        if (error instanceof Error && rejectedOperations.has(error)) pending.shift();
        throw error;
      }
      pending.shift(); // Remove ONLY an acknowledged write (or a verified no-op).
      publish(result);
    }
    if (!result) {
      result = (await latestIndex()).value;
      publish(result);
    }
    return validateNotebookIndex(result);
  }

  async function documentSnapshot(id: string): Promise<NotebookDocumentSnapshot> {
    const result = checkedRead(await host.documents.read(id), `document ${id}`);
    const missing = result.value === null && result.version === null;
    return {
      value: missing ? emptyDocument() : parseNotebookDocument(result.value),
      version: result.version,
      missing,
    };
  }

  async function committedDocumentVersion(
    id: string,
    snapshot: NotebookDocument,
    result: NotebookWriteResult,
  ): Promise<string> {
    const resource = `document ${id}`;
    if (typeof result.version === 'string' && result.version.length > 0) return result.version;
    if (result.version !== undefined) throw new NotebookVerificationError(resource, 'host returned an invalid committed version');
    let observed: NotebookDocumentSnapshot;
    try {
      observed = await documentSnapshot(id);
    } catch (cause) {
      throw new NotebookVerificationError(resource, asError(cause).message);
    }
    // Another window may write between the acknowledgment and this read. Never pair its version
    // with our stale draft: that would let the NEXT autosave overwrite it without a CAS conflict.
    if (observed.missing || JSON.stringify(observed.value) !== JSON.stringify(snapshot)) {
      throw new NotebookConflictError(resource, true);
    }
    if (observed.version === null) throw new NotebookVerificationError(resource, 'saved file has no version');
    return observed.version;
  }

  return {
    loadIndex() {
      return indexSerial(() => report('index', 'loading', undefined, async () => {
        const result = await latestIndex();
        publish(result.value);
        return validateNotebookIndex(result.value);
      }));
    },
    mutateIndex(operation) {
      const sequence = ++nextSequence;
      pending.push({ sequence, operation });
      return indexSerial(() => report('index', 'saving', undefined, () => drain(sequence)));
    },
    flushIndex() {
      const throughSequence = nextSequence;
      return indexSerial(() => report('index', 'saving', undefined, () => drain(throughSequence)));
    },
    getPendingIndexCount() {
      return pending.length;
    },
    async readDocument(id) {
      validateNodeId(id);
      return documentSerial(id, () => report('document', 'loading', id, () => documentSnapshot(id)));
    },
    async saveDocument(id, value, writeOptions) {
      let snapshot: NotebookDocument;
      let expectedVersion: NotebookStorageVersion;
      try {
        validateNodeId(id);
        snapshot = parseNotebookDocument(value);
        // Required even for a new document (null). Omitting it must not disable host CAS.
        expectedVersion = version(writeOptions?.expectedVersion);
      } catch (cause) {
        const error = asError(cause);
        notify({ scope: 'document', phase: 'error', id, error });
        throw error;
      }
      return documentSerial(id, () => report('document', 'saving', id, async () => {
        const result = await host.documents.write(id, snapshot, { expectedVersion });
        checkedWrite(result, `document ${id}`);
        return committedDocumentVersion(id, snapshot, result);
      }));
    },
  };
}

import type { NotebookController, NotebookDocumentSnapshot, NotebookStorageVersion } from './controller';
import type { NotebookDocument } from './model';

export interface NotebookDraft {
  id: string;
  document: NotebookDocument;
  version: NotebookStorageVersion;
  saved: string;
  dirty: boolean;
  /** The last save may have changed disk without returning its committed version. */
  unconfirmed: boolean;
}

export function createNotebookDraft(id: string, snapshot: NotebookDocumentSnapshot): NotebookDraft {
  return {
    id,
    document: snapshot.value,
    version: snapshot.version,
    saved: JSON.stringify(snapshot.value),
    dirty: false,
    unconfirmed: false,
  };
}

export function updateNotebookDraft(draft: NotebookDraft, document: NotebookDocument): void {
  draft.document = document;
  draft.dirty = draft.unconfirmed || JSON.stringify(document) !== draft.saved;
}

/** Retain only a few recent clean notes in memory. Active or unsaved drafts are never evicted. */
export function rememberNotebookDraft(drafts: Map<string, NotebookDraft>, active: NotebookDraft): void {
  const maxIdleNotes = 5;
  const maxIdleCharacters = 6 * 1024 * 1024;
  drafts.delete(active.id);
  drafts.set(active.id, active);
  let count = 0;
  let characters = 0;
  for (const [id, draft] of [...drafts].reverse()) {
    if (draft === active || draft.dirty || draft.unconfirmed) continue;
    if (count >= maxIdleNotes || characters + draft.saved.length > maxIdleCharacters) {
      drafts.delete(id);
    } else {
      count++;
      characters += draft.saved.length;
    }
  }
}

/** Autosave, navigation and close may all save at once. Advance each draft's CAS version in one queue. */
export function createNotebookWriter(controller: Pick<NotebookController, 'saveDocument'>) {
  let tail: Promise<void> = Promise.resolve();
  return {
    save(draft: NotebookDraft | null, onSaving?: () => void): Promise<void> {
      const result = tail.then(async () => {
        if (!draft) return;
        while (draft.dirty || draft.unconfirmed) {
          const snapshot = draft.document;
          const serialized = JSON.stringify(snapshot);
          onSaving?.();
          // An undo/flush must not trust the old saved baseline while this write is unconfirmed.
          draft.unconfirmed = true;
          try {
            draft.version = await controller.saveDocument(draft.id, snapshot, { expectedVersion: draft.version });
          } catch (error) {
            draft.dirty = true;
            throw error;
          }
          draft.saved = serialized;
          draft.unconfirmed = false;
          draft.dirty = JSON.stringify(draft.document) !== serialized;
        }
      });
      tail = result.catch(() => undefined);
      return result;
    },
    idle: () => tail,
  };
}

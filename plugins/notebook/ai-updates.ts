import type { NotebookDraft } from './writer';
import type { NotebookStorageVersion } from './controller';

/** Coalesced read-only checks. Never save, replace, or mutate an editor draft. */
export function createNotebookUpdateCheck(options: {
  available: () => boolean;
  waitForWrites: () => Promise<void>;
  refreshIndex: () => Promise<unknown>;
  current: () => NotebookDraft | null;
  readVersion: (id: string) => Promise<NotebookStorageVersion>;
  changed: (id: string) => void;
  error: (cause: unknown) => void;
}) {
  let alive = true;
  let reading: Promise<void> | null = null;
  let pending = false;
  async function run() {
    try {
      while (pending && alive) {
        pending = false;
        await options.waitForWrites();
        if (!alive || !options.available()) continue;
        await options.refreshIndex();
        if (!alive || !options.available()) continue;
        const draft = options.current();
        if (!draft) continue;
        const version = await options.readVersion(draft.id);
        if (alive && options.available() && options.current() === draft && version !== draft.version) {
          options.changed(draft.id);
        }
      }
    } catch (cause) {
      if (alive) options.error(cause);
    } finally {
      reading = null;
    }
  }
  return {
    check(): Promise<void> {
      if (!alive) return Promise.resolve();
      pending = true;
      return reading ?? (reading = run());
    },
    dispose() {
      alive = false;
      pending = false;
    },
  };
}

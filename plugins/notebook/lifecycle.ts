/** Keep document replacement and every editor thaw behind the same close boundary. */
export function createNotebookLifecycle(options: { freeze: (frozen: boolean) => void; canEdit: () => boolean }) {
  let closing = false;
  let replacement: Promise<void> | null = null;
  let closeTask: Promise<boolean> | null = null;

  function resume() {
    if (!closing && !replacement && options.canEdit()) options.freeze(false);
  }

  function cancelClose() {
    closing = false;
    closeTask = null;
    resume();
  }

  return {
    get closing() {
      return closing;
    },
    get switching() {
      return replacement !== null;
    },
    resume,
    replace<T>(prepare: () => Promise<T>, apply: (value: T) => void | Promise<void>): Promise<void> {
      if (closing || replacement) return Promise.resolve();
      options.freeze(true);
      const result = Promise.resolve().then(async () => {
        if (closing) return;
        const value = await prepare();
        // Close may have started while the disk read/old-document flush was in flight.
        if (!closing) await apply(value);
      });
      const settled = result.finally(() => {
        replacement = null;
        resume();
      });
      replacement = settled;
      return settled;
    },
    beforeClose(flush: () => Promise<boolean>): Promise<boolean> {
      if (closeTask) return closeTask;
      closing = true;
      options.freeze(true);
      const pending = replacement;
      closeTask = Promise.resolve()
        .then(async () => {
          // A load already applied to the iframe must settle while frozen before its final flush.
          await pending?.catch(() => undefined);
          return flush();
        })
        .then(
          (ok) => {
            if (!ok) cancelClose();
            return ok;
          },
          (error) => {
            cancelClose();
            throw error;
          },
        );
      return closeTask;
    },
  };
}

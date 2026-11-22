/** Page lifecycle for read-only checks. Saving remains independent of visibility. */
export function createNotebookPageRefresh(options: {
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  check: () => Promise<void>;
  intervalMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 30_000;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queued: ReturnType<typeof setTimeout> | null = null;

  const visible = () => !disposed && options.page.visibilityState === 'visible';
  function clearTimers() {
    if (timer !== null) clearTimeout(timer);
    if (queued !== null) clearTimeout(queued);
    timer = null;
    queued = null;
  }
  function schedule() {
    if (!visible()) return;
    timer = setTimeout(() => {
      timer = null;
      request();
    }, intervalMs);
  }
  function request() {
    if (!visible() || queued !== null) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // Focus, visibility and transport recovery commonly arrive together. One check is enough;
    // createNotebookExternalUpdateCheck still coalesces events that arrive during an active read.
    queued = setTimeout(() => {
      queued = null;
      if (!visible()) return;
      void options.check().finally(() => {
        if (timer === null && queued === null) schedule();
      });
    }, 80);
  }
  function visibilityChanged() {
    clearTimers();
    if (visible()) request();
  }

  options.page.addEventListener('visibilitychange', visibilityChanged);
  options.window.addEventListener('focus', request);
  options.window.addEventListener('mica:transport-resync', request);
  // The initial index/document reads already provide a fresh baseline. Do not download them twice.
  schedule();

  return {
    request,
    dispose() {
      disposed = true;
      clearTimers();
      options.page.removeEventListener('visibilitychange', visibilityChanged);
      options.window.removeEventListener('focus', request);
      options.window.removeEventListener('mica:transport-resync', request);
    },
  };
}

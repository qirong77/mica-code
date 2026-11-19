/** View-only refresh policy; the backend separately owns its bounded 30s snapshot. */
export const CONSOLE_REFRESH_MS = 30_000;
let lastSnapshot = null;
export function getLastSnapshot() {
  return lastSnapshot;
}
export function resetLastSnapshot() {
  lastSnapshot = null;
}

/**
 * @param {{ read(signal: AbortSignal): Promise<any>, intervalMs?: number,
 *   isVisible?: () => boolean, isFocused?: () => boolean, autoRefresh?: boolean }} options
 */
export function createConsoleViewController(options) {
  const intervalMs = options.intervalMs ?? CONSOLE_REFRESH_MS;
  const isVisible =
    options.isVisible ?? (() => typeof document !== 'undefined' && document.visibilityState === 'visible');
  const isFocused = options.isFocused ?? (() => typeof document === 'undefined' || document.hasFocus());
  const listeners = new Set();
  let disposed = false;
  let mounted = false;
  let timer = null;
  let flight = null;
  let active = false;
  let state = {
    snapshot: lastSnapshot,
    loading: !lastSnapshot,
    refreshing: false,
    error: '',
    autoRefresh: options.autoRefresh !== false,
  };
  const setState = (patch) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const currentlyActive = () => isVisible() && isFocused();
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (!mounted || disposed || !active || !state.autoRefresh || flight) return;
    timer = setTimeout(() => {
      timer = null;
      if (currentlyActive()) automaticRead();
    }, intervalMs);
  };
  const refresh = () => {
    if (disposed) return Promise.resolve(undefined);
    if (flight) {
      // Resume/manual reads must wait for a cancelled fetch to drain, not reuse
      // its rejected result or overlap it with a second request.
      return flight.controller.signal.aborted
        ? flight.promise.then(
            () => refresh(),
            () => refresh(),
          )
        : flight.promise;
    }
    clearTimer();
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return options.read(controller.signal);
      })
      .then((snapshot) => {
        if (disposed || controller.signal.aborted) return undefined;
        if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1) throw new Error('运行快照响应无效');
        lastSnapshot = snapshot;
        setState({ snapshot, error: '' });
        return snapshot;
      })
      .catch((error) => {
        if (disposed || controller.signal.aborted || error?.name === 'AbortError') return undefined;
        // The transport may contain paths, service URLs or raw diagnostics.
        // This surface exposes only a fixed safe failure description.
        setState({ error: '运行快照刷新失败，请稍后重试；已有统计仍保留。' });
        throw error;
      })
      .finally(() => {
        if (flight?.controller !== controller) return;
        flight = null;
        setState({ loading: false, refreshing: false });
        schedule();
      });
    flight = { controller, promise };
    setState({ loading: !state.snapshot, refreshing: true, error: '' });
    void promise.catch(() => {});
    return promise;
  };
  function automaticRead() {
    void refresh().catch(() => {});
  }
  const cancelFlight = () => {
    flight?.controller.abort();
    // Keep the old data and make manual retry available even when auto is off.
    setState({ loading: false, refreshing: false });
  };
  const syncActivity = () => {
    if (disposed || !mounted) return;
    const next = currentlyActive();
    if (next === active) return;
    active = next;
    if (!active) {
      clearTimer();
      cancelFlight();
    } else if (state.autoRefresh) automaticRead();
  };
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    clearTimer();
    cancelFlight();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', syncActivity);
      window.removeEventListener('focus', syncActivity);
      window.removeEventListener('blur', syncActivity);
    }
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    syncActivity,
    mount() {
      if (disposed || mounted) return () => {};
      mounted = true;
      active = currentlyActive();
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', syncActivity);
        window.addEventListener('focus', syncActivity);
        window.addEventListener('blur', syncActivity);
      }
      if (active) automaticRead();
      return unmount;
    },
    setAutoRefresh(enabled) {
      setState({ autoRefresh: enabled === true });
      if (!state.autoRefresh) clearTimer();
      else if (mounted && active) automaticRead();
    },
    dispose() {
      if (disposed) return;
      unmount();
      cancelFlight();
      disposed = true;
      listeners.clear();
    },
  };
}

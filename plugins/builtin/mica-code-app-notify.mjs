/**
 * Notify mica-code-app when a turn starts / finishes / errors / aborts.
 *
 * Activated only when the process was started inside a mica-code-app terminal:
 *   MICA_HOST=mica-code-app
 *   MICA_TERMINAL_ID=...
 *   MICA_APP_NOTIFY_URL=http://127.0.0.1:<port>
 *   MICA_APP_TOKEN=...
 *
 * - turn:before → green "running" dot
 * - turn:after  → red "unread" dot (completed / error / aborted)
 */

// Keep the turn loop non-blocking, but allow for a temporarily busy Electron
// main process instead of dropping otherwise valid localhost notifications.
const REQUEST_TIMEOUT_MS = 1500;

export default function setup(ctx) {
  const env = readNotifyEnv();
  if (!env) {
    ctx.logger?.info?.('mica-code-app-notify:skip', { reason: 'not_in_app_terminal' });
    return;
  }

  let aborted = false;
  let lastErrorSummary = '';
  let sessionId = '';

  const notify = (type, extra = {}) => {
    // Fire-and-forget: never block mica turn loop on local UI notify.
    void postEvent(env, type, extra).catch((error) => {
      ctx.logger?.warn?.('mica-code-app-notify:failed', {
        type,
        terminalId: env.terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const beforeDisposable = ctx.hooks.on(
    'turn:before',
    async (event) => {
      const currentSessionId = event?.runtime?.getCurrentSessionId?.();
      sessionId = typeof currentSessionId === 'string' ? currentSessionId.trim() : '';
      notify('turn.started', sessionId ? { sessionId } : {});
    },
    { pluginId: ctx.pluginId, priority: 1000 },
  );

  const startDisposable = ctx.hooks.on(
    'runtime:start',
    async (event) => {
      const currentSessionId = event?.runtime?.getCurrentSessionId?.();
      sessionId = typeof currentSessionId === 'string' ? currentSessionId.trim() : '';
      if (sessionId) notify('session.active', { sessionId });
    },
    { pluginId: ctx.pluginId, priority: 1000 },
  );

  const errorDisposable = ctx.hooks.on(
    'turn:error',
    async (event) => {
      const message = event?.error instanceof Error ? event.error.message : event?.error ? String(event.error) : '';
      lastErrorSummary = message.slice(0, 200);
    },
    { pluginId: ctx.pluginId, priority: 1000 },
  );

  const abortDisposable = ctx.hooks.on(
    'turn:abort',
    async () => {
      aborted = true;
    },
    { pluginId: ctx.pluginId, priority: 1000 },
  );

  const afterDisposable = ctx.hooks.on(
    'turn:after',
    async (event) => {
      if (aborted) {
        aborted = false;
        lastErrorSummary = '';
        notify('turn.aborted', sessionId ? { sessionId } : {});
        return;
      }

      if (event?.hasError) {
        const summary = lastErrorSummary;
        lastErrorSummary = '';
        notify('turn.error', {
          ...(summary ? { summary } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        return;
      }

      lastErrorSummary = '';
      notify('turn.completed', {
        elapsedMs: typeof event?.elapsedMs === 'number' ? event.elapsedMs : undefined,
        ...(sessionId ? { sessionId } : {}),
      });
    },
    { pluginId: ctx.pluginId, priority: 1000 },
  );

  ctx.onDispose(() => {
    beforeDisposable.dispose();
    startDisposable.dispose();
    afterDisposable.dispose();
    errorDisposable.dispose();
    abortDisposable.dispose();
  });

  ctx.logger?.info?.('mica-code-app-notify:ready', {
    terminalId: env.terminalId,
    baseUrl: env.baseUrl,
  });
}

function readNotifyEnv() {
  const host = String(process.env.MICA_HOST || '').trim();
  if (host !== 'mica-code-app') return null;

  const terminalId = String(process.env.MICA_TERMINAL_ID || '').trim();
  const baseUrl = String(process.env.MICA_APP_NOTIFY_URL || '').trim().replace(/\/+$/, '');
  const token = String(process.env.MICA_APP_TOKEN || '').trim();

  if (!terminalId || !baseUrl || !token) return null;
  if (!baseUrl.startsWith('http://127.0.0.1:') && !baseUrl.startsWith('http://localhost:')) return null;

  return { host, terminalId, baseUrl, token };
}

async function postEvent(env, type, extra = {}) {
  const url = `${env.baseUrl}/v1/terminals/${encodeURIComponent(env.terminalId)}/events`;
  const body = JSON.stringify({
    v: 1,
    type,
    terminalId: env.terminalId,
    ts: Date.now(),
    ...extra,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.token}`,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`http ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

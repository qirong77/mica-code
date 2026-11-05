import { Socket } from 'node:net';
import { parseTarget, type Target, type ProbeStatus } from './state.js';

export const PROBE_TIMEOUT_MS = 5000;
export type FetchProbe = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'body'>>;
export type ProbeDeps = {
  fetch?: FetchProbe;
  socket?: () => Socket;
  now?: () => number;
  timeoutMs?: number;
};

/** One bounded request; no body, cookies, auth headers, redirects or DNS discovery. */
export async function probeTarget(input: Target, signal: AbortSignal, deps: ProbeDeps = {}): Promise<ProbeStatus> {
  const target = parseTarget(input);
  const now = deps.now ?? Date.now;
  const timeoutMs = Math.min(PROBE_TIMEOUT_MS, Math.max(1, deps.timeoutMs ?? PROBE_TIMEOUT_MS));
  const status = (result: Omit<ProbeStatus, 'checkedAt'>): ProbeStatus => ({ ...result, checkedAt: now() });
  if (signal.aborted) return status({ reachable: false, healthy: null, error: 'aborted' });
  if (target.kind === 'tcp') {
    return new Promise((resolve) => {
      let settled = false;
      let socket: Socket;
      try {
        socket = (deps.socket ?? (() => new Socket()))();
      } catch {
        resolve(status({ reachable: false, healthy: null, error: 'connection' }));
        return;
      }
      const finish = (result: Omit<ProbeStatus, 'checkedAt'>) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        socket.destroy();
        resolve(status(result));
      };
      const abort = () => finish({ reachable: false, healthy: null, error: 'aborted' });
      signal.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => finish({ reachable: true, healthy: null }));
      socket.once('timeout', () => finish({ reachable: false, healthy: null, error: 'timeout' }));
      // Keep the error listener through destroy; late socket errors must not escape.
      socket.on('error', () => finish({ reachable: false, healthy: null, error: 'connection' }));
      try {
        if (signal.aborted) {
          abort();
          return;
        }
        socket.setTimeout(timeoutMs);
        socket.connect({ host: target.host, port: target.port });
      } catch {
        finish({ reachable: false, healthy: null, error: 'connection' });
      }
    });
  }
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error('aborted'));
  });
  const abort = () => {
    controller.abort();
    rejectAbort();
  };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  try {
    const request = (deps.fetch ?? ((url, init) => fetch(url, init)))(target.url, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {},
      signal: controller.signal,
    }).then((response) => {
      // A late response after cancellation also needs its stream released.
      void response.body?.cancel().catch(() => {});
      return response;
    });
    const response = await Promise.race([request, aborted]);
    if (signal.aborted) return status({ reachable: false, healthy: null, error: 'aborted' });
    return status({
      reachable: true,
      healthy: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      ...(response.status >= 300 && response.status < 400 ? { error: 'redirect' as const } : {}),
    });
  } catch {
    return status({
      reachable: false,
      healthy: null,
      error: timedOut ? 'timeout' : signal.aborted ? 'aborted' : 'connection',
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

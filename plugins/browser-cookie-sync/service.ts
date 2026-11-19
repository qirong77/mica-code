import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fromMicaCookie, normalizeHost, SAME_SITE_NAMES, toMicaPayload, type SyncCookie } from './cookies.js';

const MAX_BODY = 128 * 1024;
const MAX_EVENT = 256 * 1024;
const MAX_SNAPSHOT = 16 * 1024 * 1024;

type CookieEvent = { cookie: SyncCookie; removed: boolean };
export type CookieSyncObservation = {
  direction: 'upstream' | 'incremental' | 'snapshot' | 'to-browser' | 'reconcile';
  outcome: 'success' | 'error' | 'recovered';
  code: 'ok' | 'invalid-json' | 'stream-ended' | 'timeout' | 'unavailable' | 'request-failed' | 'http-error' | 'invalid-response' | 'write-rejected' | 'reconcile-incomplete';
  httpStatus?: number;
  reason: 'none' | 'http' | 'timeout' | 'connection-refused' | 'connection-reset' | 'dns' | 'invalid-response' | 'transport' | 'incomplete';
  deliveries: number;
  repairRequested: number;
  repairCompleted: number;
  repairPending: number;
  failures: number;
  reconnects: number;
  durationMs: number;
};

class SyncFailure extends Error {
  constructor(readonly code: CookieSyncObservation['code'], readonly httpStatus?: number) { super(code); }
}

function normalizeCookie(value: unknown): SyncCookie | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if ('partitionKey' in raw || (raw.storeId != null && raw.storeId !== '0')) return null;
  if (typeof raw.name !== 'string' || !raw.name || typeof raw.value !== 'string') return null;
  if (typeof raw.hostOnly !== 'boolean' || typeof raw.secure !== 'boolean' || typeof raw.httpOnly !== 'boolean')
    return null;
  if (typeof raw.path !== 'string' || !raw.path.startsWith('/')) return null;
  if (typeof raw.sameSite !== 'string' || !SAME_SITE_NAMES.includes(raw.sameSite as SyncCookie['sameSite']))
    return null;
  if (raw.expiresAt !== null && (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt))) return null;
  const host = normalizeHost(raw.host ?? raw.domain);
  if (!host || /[\s/:\\]/.test(host) || host.length > 253) return null;
  return {
    host,
    hostOnly: raw.hostOnly,
    name: raw.name,
    path: raw.path,
    value: raw.value,
    expiresAt: raw.expiresAt as number | null,
    secure: raw.secure,
    httpOnly: raw.httpOnly,
    sameSite: raw.sameSite as SyncCookie['sameSite'],
  };
}

function chromeCookie(value: unknown): SyncCookie | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if ('partitionKey' in raw || (raw.storeId != null && raw.storeId !== '0')) return null;
  return normalizeCookie({
    ...raw,
    host: raw.host ?? raw.domain,
    expiresAt: raw.expiresAt !== undefined ? raw.expiresAt : raw.session ? null : (raw.expirationDate ?? null),
  });
}

function eventFromUpstream(value: unknown): CookieEvent | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.removed !== 'boolean' || !input.cookie || typeof input.cookie !== 'object') return null;
  const raw = input.cookie as Record<string, unknown>;
  if ('partitionKey' in raw || (raw.storeId != null && raw.storeId !== '0')) return null;
  if (typeof raw.value !== 'string') return null;
  const cookie = raw.host !== undefined ? normalizeCookie(raw) : fromMicaCookie(raw);
  return cookie ? { cookie, removed: input.removed } : null;
}

async function resolveUpstreamEvent(value: unknown, base: string): Promise<CookieEvent | null> {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (typeof input.removed !== 'boolean' || !input.cookie || typeof input.cookie !== 'object') return null;
  const identity = input.cookie as Record<string, unknown>;
  const host = normalizeHost(identity.domain);
  if (!host || typeof identity.name !== 'string' || typeof identity.path !== 'string') return null;
  const response = await fetch(`${base}/browser/cookies/all?domain=${encodeURIComponent(host)}&limit=20000`, {
    signal: AbortSignal.timeout(20000),
  });
  const result = await readJson(response, MAX_SNAPSHOT);
  if (result.truncated === true || !Array.isArray(result.cookies)) throw new Error('cookie scope incomplete');
  const match = result.cookies
    .map((entry) => {
      const raw = entry as Record<string, unknown>;
      return raw.host !== undefined ? normalizeCookie(raw) : fromMicaCookie(raw);
    })
    .find(
      (cookie) =>
        cookie?.host === host &&
        cookie.name === identity.name &&
        cookie.path === identity.path &&
        cookie.hostOnly === !String(identity.domain).startsWith('.'),
    );
  if (match) return { cookie: match, removed: false };
  return input.removed
    ? {
        removed: true,
        cookie: {
          host,
          hostOnly: !String(identity.domain).startsWith('.'),
          name: identity.name,
          path: identity.path,
          value: '',
          expiresAt: null,
          secure: false,
          httpOnly: false,
          sameSite: 'unspecified',
        },
      }
    : null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function readJson(response: Response, max: number): Promise<Record<string, unknown>> {
  if (!response.ok) throw new SyncFailure('http-error', response.status);
  if (!response.body) throw new SyncFailure('invalid-response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new SyncFailure('invalid-response');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  if (!body || typeof body !== 'object' || body.ok === false) throw new SyncFailure('write-rejected');
  return body;
}

export async function startCookieService({
  token,
  micaBrowserUrl,
  port = 19387,
  onClientCount = () => {},
  onObservation = () => {},
  extensionInfo,
}: {
  token: string;
  micaBrowserUrl: string;
  port?: number;
  onClientCount?: (count: number) => void;
  /** Metadata only; never includes cookie identity/value, URL, token or error text. */
  onObservation?: (event: CookieSyncObservation) => void;
  /** 磁盘上那份扩展的版本与最近更新时间，扩展据此判断自己要不要重载。 */
  extensionInfo?: () => { version: string; fingerprint: string; updatedAt: number };
}): Promise<{ port: number; close(): Promise<void> }> {
  if (!token || !micaBrowserUrl) throw new Error('cookie service requires token and browser URL');
  const upstream = new URL(micaBrowserUrl);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)) {
    throw new Error('browser URL must be local HTTP');
  }
  const base = upstream.href.replace(/\/+$/, '');
  const expectedToken = Buffer.from(token);
  const clients = new Set<ServerResponse>();
  const controller = new AbortController();
  let stopped = false;
  let writes = Promise.resolve();
  let revision = 0;
  let reconnects = 0;
  let deliveries = 0;
  let repairEpoch = 0;
  let repairRequested = 0;
  let repairCompleted = 0;
  let repairPending = 0;
  const snapshots = new Map<string, { revision: number; repairEpoch: number }>();
  const failures = new Map<CookieSyncObservation['direction'], { count: number; since: number; degraded: boolean }>();
  function note(direction: CookieSyncObservation['direction'], error?: unknown, reconciled = false): void {
    // A stream gap invalidates older in-flight snapshot acknowledgments too.
    if (direction === 'upstream' && error !== undefined) {
      repairEpoch++; repairRequested++; repairPending++;
    }
    const state = failures.get(direction) ?? { count: 0, since: Date.now(), degraded: false };
    const recovering = state.degraded && error === undefined && (reconciled || repairPending === 0 || !['incremental', 'to-browser'].includes(direction));
    if (error !== undefined) {
      if (!state.degraded) state.since = Date.now();
      state.degraded = true;
      state.count++;
    } else if (reconciled || repairPending === 0 || !['incremental', 'to-browser'].includes(direction)) state.degraded = false;
    failures.set(direction, state);
    const name = error instanceof Error ? error.name : '';
    const code = error instanceof SyncFailure ? error.code : error === undefined ? 'ok' : name === 'SyntaxError' ? 'invalid-json' : name === 'TimeoutError' ? 'timeout'
      : error === 'stream-ended' ? 'stream-ended' : direction === 'upstream' ? 'unavailable' : 'request-failed';
    const transportCode = error && typeof error === 'object' ? (error as { cause?: { code?: unknown }; code?: unknown }).cause?.code ?? (error as { code?: unknown }).code : undefined;
    const reason: CookieSyncObservation['reason'] = error === undefined ? 'none' : code === 'http-error' ? 'http'
      : code === 'timeout' ? 'timeout' : ['invalid-json', 'invalid-response'].includes(code) ? 'invalid-response'
      : code === 'reconcile-incomplete' ? 'incomplete' : transportCode === 'ECONNREFUSED' ? 'connection-refused'
      : ['ECONNRESET', 'EPIPE'].includes(String(transportCode)) ? 'connection-reset' : ['ENOTFOUND', 'EAI_AGAIN'].includes(String(transportCode)) ? 'dns' : 'transport';
    try { onObservation({ direction, outcome: error === undefined ? (recovering ? 'recovered' : 'success') : 'error', code, reason,
      ...(error instanceof SyncFailure && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
      failures: state.count, reconnects, deliveries, repairRequested, repairCompleted, repairPending, durationMs: Math.max(0, Date.now() - state.since) }); }
    catch { /* diagnostics cannot stop cookie synchronization */ }
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = writes.then(job);
    writes = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      send(res, 403, { ok: false });
      return;
    }
    const host = req.headers.host;
    if (!host || !/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) {
      send(res, 403, { ok: false });
      return;
    }
    const auth = req.headers.authorization;
    const supplied =
      typeof auth === 'string' && auth.startsWith('Bearer ') ? Buffer.from(auth.slice(7)) : Buffer.alloc(0);
    if (supplied.length !== expectedToken.length || !timingSafeEqual(supplied, expectedToken)) {
      send(res, 401, { ok: false });
      return;
    }
    const path = new URL(req.url || '/', `http://${host}`).pathname;
    if (req.method === 'GET' && path === '/health') {
      const info = extensionInfo?.();
      send(res, 200, {
        ok: true,
        connected: clients.size > 0,
        ...(info ? { extension: { version: info.version, fingerprint: info.fingerprint, updatedAt: info.updatedAt } } : {}),
      });
      return;
    }
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      onClientCount(clients.size);
      res.on('close', () => {
        clients.delete(res);
        onClientCount(clients.size);
      });
      return;
    }
    if (req.method === 'GET' && path === '/snapshot') {
      try {
        const snapshot = await enqueue(async () => {
          const response = await fetch(`${base}/browser/cookies/all?limit=20000`, {
            signal: AbortSignal.timeout(20000),
          });
          const body = await readJson(response, MAX_SNAPSHOT);
          if (
            body.truncated === true ||
            !Array.isArray(body.cookies) ||
            body.cookies.length > 20000 ||
            (typeof body.total === 'number' && body.total > 20000)
          )
            throw new Error('snapshot incomplete');
          const cookies = body.cookies.map((item) => {
            const raw = item as Record<string, unknown>;
            return raw.host !== undefined ? normalizeCookie(raw) : fromMicaCookie(raw);
          });
          if (cookies.some((item) => item === null)) throw new Error('invalid snapshot cookie');
          const deliveryId = randomUUID();
          if (snapshots.size >= 16) snapshots.delete(snapshots.keys().next().value!);
          snapshots.set(deliveryId, { revision, repairEpoch });
          return { cookies, revision, repairEpoch, deliveryId };
        });
        note('snapshot');
        send(res, 200, snapshot);
      } catch (error) {
        note('snapshot', error);
        send(res, 502, { ok: false, error: 'snapshot unavailable or incomplete' });
      }
      return;
    }
    if (req.method === 'POST' && path === '/ack') {
      try {
        const value = await readBody(req) as Record<string, unknown>;
        if (!value || value.kind !== 'snapshot' || typeof value.deliveryId !== 'string' || !Number.isSafeInteger(value.repairEpoch) || !Number.isSafeInteger(value.revision) ||
          Number(value.revision) < 0 || Number(value.revision) > revision || !Number.isSafeInteger(value.failed) || Number(value.failed) < 0 ||
          !Number.isSafeInteger(value.skipped) || Number(value.skipped) < 0) { send(res, 400, { ok: false }); return; }
        const delivered = snapshots.get(value.deliveryId);
        if (!delivered || delivered.revision !== value.revision || delivered.repairEpoch !== value.repairEpoch) {
          send(res, 409, { ok: false }); return;
        }
        snapshots.delete(value.deliveryId);
        if (Number(value.failed) > 0 || Number(value.skipped) > 0) note('reconcile', new SyncFailure('reconcile-incomplete'));
        else if (value.repairEpoch === repairEpoch) {
          repairCompleted += repairPending;
          repairPending = 0;
          note('reconcile', undefined, true);
          for (const direction of ['incremental', 'to-browser'] as const) {
            if (failures.get(direction)?.degraded) note(direction, undefined, true);
          }
        }
        send(res, 200, { ok: true });
      } catch { send(res, 400, { ok: false }); }
      return;
    }
    if (req.method === 'POST' && path === '/events') {
      if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) {
        send(res, 415, { ok: false });
        return;
      }
      let input: unknown;
      try {
        input = await readBody(req);
      } catch {
        send(res, 400, { ok: false });
        return;
      }
      if (
        !input ||
        typeof input !== 'object' ||
        typeof (input as CookieEvent).removed !== 'boolean' ||
        'partitionKey' in input ||
        ('storeId' in input && (input as Record<string, unknown>).storeId !== '0')
      ) {
        send(res, 400, { ok: false });
        return;
      }
      const rawCookie = (input as CookieEvent).cookie;
      if (
        !rawCookie ||
        typeof rawCookie !== 'object' ||
        ('storeId' in rawCookie && (rawCookie as Record<string, unknown>).storeId !== '0') ||
        'partitionKey' in rawCookie
      ) {
        send(res, 400, { ok: false });
        return;
      }
      const cookie = chromeCookie(rawCookie);
      if (!cookie) {
        send(res, 400, { ok: false });
        return;
      }
      const event = { cookie, removed: (input as CookieEvent).removed };
      const write = enqueue(async () => {
        const response = await fetch(`${base}/browser/cookies/${event.removed ? 'remove' : 'set'}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookies: [toMicaPayload(cookie)] }),
          signal: AbortSignal.timeout(20000),
        });
        const result = await readJson(response, MAX_BODY);
        if (Array.isArray(result.failed) && result.failed.length) throw new SyncFailure('write-rejected');
        return ++revision;
      });
      try {
        send(res, 200, { ok: true, revision: await write });
        deliveries++;
        note('to-browser');
      } catch (error) {
        repairEpoch++; repairRequested++; repairPending++;
        note('to-browser', error);
        send(res, 502, { ok: false, error: 'browser write failed' });
      }
      return;
    }
    send(res, 404, { ok: false });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { ok: false }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    controller.abort();
    throw error;
  }

  async function relay(): Promise<void> {
    let delay = 500;
    let reconnecting = false;
    while (!stopped) {
      try {
        const response = await fetch(`${base}/browser/cookies/events`, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok) throw new SyncFailure('http-error', response.status);
        if (!response.body) throw new SyncFailure('invalid-response');
        note('upstream');
        if (reconnecting) for (const client of clients) client.end();
        let buffer = '';
        let data: string[] = [];
        let dataSize = 0;
        const decoder = new TextDecoder();
        for await (const bytes of response.body) {
          buffer += decoder.decode(bytes, { stream: true });
          if (buffer.length > MAX_EVENT) throw new Error('event too large');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).replace(/\r$/, '');
            buffer = buffer.slice(newline + 1);
            if (!line) {
              if (data.length) {
                try {
                  const raw = JSON.parse(data.join('\n')) as unknown;
                  const relayed = await enqueue(async () => {
                    const event =
                      clients.size > 0 ? (eventFromUpstream(raw) ?? (await resolveUpstreamEvent(raw, base))) : null;
                    if (event) {
                      delay = 500;
                      const frame = `data: ${JSON.stringify({ ...event, revision: ++revision })}\n\n`;
                      let sent = false;
                      for (const client of clients) {
                        if (client.writableLength > MAX_EVENT * 4) {
                          clients.delete(client);
                          client.end();
                        } else { client.write(frame); sent = true; }
                      }
                      return sent;
                    }
                    return false;
                  });
                  if (relayed) { deliveries++; note('incremental'); }
                } catch (error) {
                  repairEpoch++; repairRequested++; repairPending++;
                  note('incremental', error);
                  // Reconnect clients so their snapshot repairs a failed incremental read.
                  for (const client of clients) client.end();
                }
              }
              data = [];
              dataSize = 0;
            } else if (line.startsWith('data:')) {
              const part = line.slice(5).trimStart();
              dataSize += part.length;
              if (dataSize > MAX_EVENT) throw new Error('event too large');
              data.push(part);
            }
          }
        }
        if (!stopped) note('upstream', 'stream-ended');
      } catch (error) {
        if (!stopped && !controller.signal.aborted) note('upstream', error);
      }
      if (stopped) break;
      reconnecting = true;
      reconnects++;
      for (const client of clients) client.end();
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, delay);
        controller.signal.addEventListener('abort', done, { once: true });
      });
      delay = Math.min(delay * 2, 15000);
    }
  }
  const relayTask = relay();
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.writableLength < MAX_EVENT) client.write(': ping\n\n');
      else client.end();
    }
  }, 20_000);
  heartbeat.unref?.();
  return {
    port: (server.address() as { port: number }).port,
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      controller.abort();
      for (const client of clients) client.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await relayTask;
      await writes;
    },
  };
}

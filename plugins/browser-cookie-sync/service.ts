import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fromMicaCookie, normalizeHost, SAME_SITE_NAMES, toMicaPayload, type SyncCookie } from './cookies.js';

const MAX_BODY = 128 * 1024;
const MAX_EVENT = 256 * 1024;
const MAX_SNAPSHOT = 16 * 1024 * 1024;

type CookieEvent = { cookie: SyncCookie; removed: boolean };

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
  if (!response.ok || !response.body) throw new Error('upstream unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error('upstream response too large');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  if (!body || typeof body !== 'object' || body.ok === false) throw new Error('upstream rejected request');
  return body;
}

export async function startCookieService({
  token,
  micaBrowserUrl,
  port = 19387,
  onClientCount = () => {},
}: {
  token: string;
  micaBrowserUrl: string;
  port?: number;
  onClientCount?: (count: number) => void;
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
      send(res, 200, { ok: true, connected: clients.size > 0 });
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
          return { cookies, revision };
        });
        send(res, 200, snapshot);
      } catch {
        send(res, 502, { ok: false, error: 'snapshot unavailable or incomplete' });
      }
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
        if (Array.isArray(result.failed) && result.failed.length) throw new Error('cookie write failed');
        return ++revision;
      });
      try {
        send(res, 200, { ok: true, revision: await write });
      } catch {
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
        if (!response.ok || !response.body) throw new Error('upstream event stream unavailable');
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
                  await enqueue(async () => {
                    const event =
                      clients.size > 0 ? (eventFromUpstream(raw) ?? (await resolveUpstreamEvent(raw, base))) : null;
                    if (event) {
                      delay = 500;
                      const frame = `data: ${JSON.stringify({ ...event, revision: ++revision })}\n\n`;
                      for (const client of clients) {
                        if (client.writableLength > MAX_EVENT * 4) {
                          clients.delete(client);
                          client.end();
                        } else client.write(frame);
                      }
                    }
                  });
                } catch {
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
      } catch {
        /* Reconnect after bounded backoff, without logging cookie data. */
      }
      if (stopped) break;
      reconnecting = true;
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

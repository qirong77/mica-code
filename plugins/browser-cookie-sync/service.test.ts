import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startCookieService, type CookieSyncObservation } from './service.js';

const cookie = {
  host: 'example.com',
  hostOnly: true,
  name: 'sid',
  path: '/',
  value: 'secret',
  expiresAt: null,
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
};
const token = 'test-token';

async function fixture(extensionInfo?: () => { version: string; fingerprint: string; updatedAt: number }) {
  const calls: Array<{ path: string; body: any }> = [];
  const observations: CookieSyncObservation[] = [];
  const streams = new Set<ServerResponse>();
  let writeStatus = 200;
  let snapshot: Record<string, unknown> = { ok: true, cookies: [{ ...cookie }], total: 1, truncated: false };
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (path === '/browser/cookies/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
    } else if (path === '/browser/cookies/all' || path === '/browser/cookies') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(snapshot));
    } else {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      calls.push({ path, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.statusCode = writeStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, written: 1, removed: 1 }));
    }
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const browserPort = (upstream.address() as { port: number }).port;
  const service = await startCookieService({
    token,
    micaBrowserUrl: `http://127.0.0.1:${browserPort}`,
    port: 0,
    onObservation: (event) => observations.push(event),
    ...(extensionInfo ? { extensionInfo } : {}),
  });
  const url = `http://127.0.0.1:${service.port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  return {
    calls,
    observations,
    streams,
    url,
    request,
    setSnapshot(value: Record<string, unknown>) {
      snapshot = value;
    },
    setWriteStatus(status: number) { writeStatus = status; },
    emit(value: unknown) {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(value)}\n\n`);
    },
    emitRaw(value: string) { for (const stream of streams) stream.write(`data: ${value}\n\n`); },
    async close() {
      await service.close();
      for (const stream of streams) stream.end();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    },
  };
}

const active: Array<Awaited<ReturnType<typeof fixture>>> = [];
async function setup(extensionInfo?: () => { version: string; fingerprint: string; updatedAt: number }) {
  const value = await fixture(extensionInfo);
  active.push(value);
  return value;
}
afterEach(async () => {
  for (const value of active.splice(0)) await value.close();
});

function post(body: unknown, extra: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

describe('cookie loopback service', () => {
  it('reports safe HTTP failure metadata and requires a current completed snapshot acknowledgment for repair', async () => {
    const service = await setup();
    service.setWriteStatus(503);
    expect((await service.request('/events', post({ cookie, removed: false }))).status).toBe(502);
    expect(service.observations.find((row) => row.direction === 'to-browser')).toMatchObject({ code: 'http-error', httpStatus: 503, reason: 'http', repairPending: 1 });
    const first = await (await service.request('/snapshot')).json();
    const acknowledge = (snapshot: typeof first, failed = 0) => service.request('/ack', post({ kind: 'snapshot',
      deliveryId: snapshot.deliveryId, revision: snapshot.revision, repairEpoch: snapshot.repairEpoch, failed, skipped: 0 }));
    // A newer failure makes this delivered snapshot insufficient to prove recovery.
    await service.request('/events', post({ cookie, removed: false }));
    await acknowledge(first);
    expect(service.observations.some((row) => row.outcome === 'recovered')).toBe(false);
    service.setWriteStatus(200);
    await service.request('/events', post({ cookie, removed: false }));
    expect(service.observations.filter((row) => row.direction === 'to-browser').at(-1)).toMatchObject({ outcome: 'success', repairPending: 2 });
    const partial = await (await service.request('/snapshot')).json();
    await acknowledge(partial, 1);
    expect(service.observations.filter((row) => row.direction === 'reconcile').at(-1)).toMatchObject({ outcome: 'error', code: 'reconcile-incomplete', repairPending: 2 });
    const complete = await (await service.request('/snapshot')).json();
    expect((await acknowledge(complete)).status).toBe(200);
    expect(service.observations.filter((row) => row.direction === 'to-browser').at(-1)).toMatchObject({ outcome: 'recovered', repairCompleted: 2, repairPending: 0 });
    expect((await acknowledge(complete)).status).toBe(409);
    expect(JSON.stringify(service.observations)).not.toMatch(/secret|example\.com|sid|test-token/);
  });
  it('reports parse failure and recovery without retaining cookie data or token', async () => {
    const service = await setup();
    await waitFor(() => service.streams.size > 0);
    service.emitRaw('{PRIVATE_COOKIE_INVALID_JSON');
    await waitFor(() => service.observations.some((row) => row.code === 'invalid-json'));
    service.emit({ cookie, removed: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.observations.some((row) => row.direction === 'incremental' && row.outcome === 'recovered')).toBe(false);
    const reader = (await service.request('/events')).body!.getReader();
    await reader.read();
    service.emit({ cookie, removed: false });
    await reader.read();
    await waitFor(() => service.observations.some((row) => row.direction === 'incremental' && row.outcome === 'success'));
    expect(service.observations.some((row) => row.direction === 'incremental' && row.outcome === 'recovered')).toBe(false);
    const snapshot = await (await service.request('/snapshot')).json();
    expect(snapshot.repairEpoch).toBeGreaterThan(0);
    expect((await service.request('/ack', post({ kind: 'snapshot', deliveryId: snapshot.deliveryId,
      revision: snapshot.revision, repairEpoch: snapshot.repairEpoch, failed: 0, skipped: 0 }))).status).toBe(200);
    expect(service.observations.filter((row) => row.direction === 'incremental').at(-1)).toMatchObject({ outcome: 'recovered', repairCompleted: 1, repairPending: 0 });
    expect(JSON.stringify(service.observations)).not.toMatch(/PRIVATE|secret|test-token|example.com/);
    const failure = service.observations.find((row) => row.code === 'invalid-json')!;
    expect(failure).toMatchObject({ direction: 'incremental', failures: 1 });
    await reader.cancel();
  });
  it('reports the on-disk extension version so the extension can self-update', async () => {
    const info = { version: '1.2.0', fingerprint: 'abc123', updatedAt: 1_700_000_000_000 };
    const withInfo = await setup(() => info);
    expect(await (await withInfo.request('/health')).json()).toEqual({
      ok: true,
      connected: false,
      extension: info,
    });
    // 老服务（没有版本信息）也不能让扩展报错：字段直接省略。
    const plain = await setup();
    expect(await (await plain.request('/health')).json()).toEqual({ ok: true, connected: false });
  });

  it('rejects unauthenticated, webpage-origin and partitioned events without CORS', async () => {
    const service = await setup();
    const noAuth = await fetch(`${service.url}/snapshot`);
    expect(noAuth.status).toBe(401);
    const foreign = await service.request('/snapshot', { headers: { origin: 'https://example.com' } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
    expect((await service.request('/snapshot', { headers: { origin: extensionOrigin } })).status).toBe(200);
    expect(
      (
        await service.request(
          '/events',
          post({ cookie: { ...cookie, partitionKey: { topLevelSite: 'https://example.com' } }, removed: false }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await service.request('/events', post({ cookie: { ...cookie, storeId: '1' }, removed: false }))).status,
    ).toBe(400);
    expect(
      (await service.request('/events', post({ cookie: { ...cookie, partitionKey: null }, removed: false }))).status,
    ).toBe(400);
    expect(service.calls).toEqual([]);
  });

  it('writes and removes a single normalized cookie to the Mica browser', async () => {
    const service = await setup();
    const changed = await service.request(
      '/events',
      post({ cookie: { ...cookie, host: '.EXAMPLE.com' }, removed: false }),
    );
    expect(await changed.json()).toEqual({ ok: true, revision: 1 });
    expect((await service.request('/events', post({ cookie, removed: true }))).status).toBe(200);
    expect(service.calls.map(({ path }) => path)).toEqual(['/browser/cookies/set', '/browser/cookies/remove']);
    expect(service.calls[0]?.body.cookies[0]).toMatchObject({ domain: 'example.com', name: 'sid', value: 'secret' });
  });

  it('rejects truncated snapshots and returns normalized complete snapshots', async () => {
    const service = await setup();
    expect(await (await service.request('/snapshot')).json()).toMatchObject({ cookies: [cookie], revision: 0, repairEpoch: 0, deliveryId: expect.any(String) });
    service.setSnapshot({ ok: true, truncated: true, total: 20001, cookies: [cookie] });
    expect((await service.request('/snapshot')).status).toBe(502);
  });

  it('relays Mica SSE and does not swallow a real Chrome change back to an older value', async () => {
    const service = await setup();
    const reader = (await service.request('/events')).body!.getReader();
    await reader.read();
    await waitFor(() => service.streams.size > 0);
    service.emit({ cookie, removed: false });
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain('"value":"secret"');
    expect(
      (await service.request('/events', post({ cookie: { ...cookie, value: 'changed' }, removed: false }))).status,
    ).toBe(200);
    await waitFor(() => service.calls.length === 1);
    service.emit({ cookie: { ...cookie, value: 'changed' }, removed: false });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"value":"changed"');
    service.emit({ cookie: { ...cookie, value: 'newer' }, removed: false });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"value":"newer"');
    expect((await service.request('/events', post({ cookie, removed: false }))).status).toBe(200);
    expect(service.calls.map((call) => call.body.cookies[0].value)).toEqual(['changed', 'secret']);
    await reader.cancel();
  });

  it('reads the changed cookie by scope rather than forwarding a value-less event', async () => {
    const service = await setup();
    const reader = (await service.request('/events')).body!.getReader();
    await reader.read();
    await waitFor(() => service.streams.size > 0);
    service.emit({ cookie: { name: 'sid', domain: 'example.com', path: '/' }, removed: false });
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain('"value":"secret"');
    await reader.cancel();
  });

  it('clears frames received while Chrome is offline before relaying the next change', async () => {
    const service = await setup();
    await waitFor(() => service.streams.size > 0);
    service.emit({ cookie, removed: false });
    const reader = (await service.request('/events')).body!.getReader();
    await reader.read();
    service.emit({ cookie: { ...cookie, value: 'after-connect' }, removed: false });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('after-connect');
    await reader.cancel();
  });

  it('closes the downstream stream when upstream disconnects so Chrome can reconcile', async () => {
    const service = await setup();
    const reader = (await service.request('/events')).body!.getReader();
    await reader.read();
    await waitFor(() => service.streams.size > 0);
    for (const stream of service.streams) stream.end();
    expect((await reader.read()).done).toBe(true);
    expect(service.observations.some((row) => row.direction === 'upstream' && row.code === 'stream-ended')).toBe(true);
  });
});

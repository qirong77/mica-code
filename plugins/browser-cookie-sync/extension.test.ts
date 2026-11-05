import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Cookie = {
  host: string;
  hostOnly: boolean;
  name: string;
  path: string;
  value: string;
  expiresAt: number | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
};
type RawCookie = Omit<Cookie, 'host' | 'expiresAt'> & {
  domain: string;
  storeId: string;
  session: boolean;
  expirationDate?: number;
  partitionKey?: object;
};
type Event = { cookie: Cookie; removed: boolean; revision?: number };
type Worker = {
  normalize(cookie: object): Cookie | null;
  key(cookie: Cookie): string;
  fingerprint(cookie: Cookie): Promise<string>;
  reconcile(token: string): Promise<void>;
  incoming(event: Event): Promise<void>;
  readEvents(response: Response): Promise<void>;
  connect(): Promise<void>;
  settle(): Promise<void>;
};

const source = readFileSync(new URL('./extension/service-worker.js', import.meta.url), 'utf8');
const cookie = (value = 'one', overrides: Partial<Cookie> = {}): Cookie => ({
  host: 'example.com',
  hostOnly: true,
  name: 'session',
  path: '/',
  value,
  expiresAt: null,
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  ...overrides,
});
const raw = (value: Cookie): RawCookie => ({
  domain: `${value.hostOnly ? '' : '.'}${value.host}`,
  hostOnly: value.hostOnly,
  name: value.name,
  path: value.path,
  value: value.value,
  storeId: '0',
  session: value.expiresAt === null,
  ...(value.expiresAt === null ? {} : { expirationDate: value.expiresAt }),
  secure: value.secure,
  httpOnly: value.httpOnly,
  sameSite: value.sameSite,
});

async function harness(initial: Cookie[] = []) {
  const state: { token: string; baseline: Record<string, string> } = { token: '', baseline: {} };
  let jar = initial.map(raw);
  let snapshot: Cookie[] = [];
  let revision = 0;
  const posts: Event[] = [];
  const cookieListeners: Array<(event: { cookie: RawCookie; removed: boolean; cause: string }) => void> = [];
  const storageListeners: Array<(changes: object, area: string) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const storage = {
    get: vi.fn(async (name: keyof typeof state) => structuredClone({ [name]: state[name] })),
    set: vi.fn(async (values: Partial<typeof state>) => {
      Object.assign(state, structuredClone(values));
    }),
  };
  const changed = (entry: RawCookie, removed: boolean, cause = 'explicit') => {
    for (const listener of cookieListeners) listener({ cookie: entry, removed, cause });
  };
  const cookies = {
    getAll: vi.fn(async (filter: { domain?: string; name?: string }) =>
      jar.filter(
        (entry) =>
          (!filter.domain ||
            entry.domain.replace(/^\./, '') === filter.domain ||
            entry.domain.replace(/^\./, '').endsWith(`.${filter.domain}`)) &&
          (!filter.name || filter.name === entry.name),
      ),
    ),
    set: vi.fn(
      async (details: {
        url: string;
        name: string;
        value: string;
        path: string;
        domain?: string;
        expirationDate?: number;
        secure: boolean;
        httpOnly: boolean;
        sameSite?: string;
      }) => {
        const domain = details.domain || new URL(details.url).hostname;
        const index = jar.findIndex(
          (entry) =>
            entry.domain.replace(/^\./, '') === domain.replace(/^\./, '') &&
            entry.path === details.path &&
            entry.name === details.name &&
            !entry.partitionKey &&
            entry.storeId === '0',
        );
        if (details.expirationDate !== undefined && details.expirationDate < Date.now() / 1000) {
          if (index >= 0) changed(jar.splice(index, 1)[0]!, true);
          return null;
        }
        const entry = raw(
          cookie(details.value, {
            host: domain.replace(/^\./, ''),
            hostOnly: !details.domain,
            name: details.name,
            path: details.path,
            expiresAt: details.expirationDate ?? null,
            secure: details.secure,
            httpOnly: details.httpOnly,
            sameSite: details.sameSite ?? 'unspecified',
          }),
        );
        if (index >= 0) changed(jar.splice(index, 1)[0]!, true, 'overwrite');
        jar.push(entry);
        changed(entry, false);
        return entry;
      },
    ),
    remove: vi.fn(),
    onChanged: { addListener: (listener: (typeof cookieListeners)[number]) => cookieListeners.push(listener) },
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/snapshot')) return Response.json({ cookies: snapshot, revision });
    if (url.endsWith('/events') && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Event);
      return Response.json({ ok: true, revision: ++revision });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const warn = vi.fn();
  const context = createContext({
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    fetch,
    console: { warn },
    chrome: {
      cookies,
      storage: {
        local: storage,
        onChanged: { addListener: (listener: (typeof storageListeners)[number]) => storageListeners.push(listener) },
      },
      alarms: {
        create: vi.fn(),
        onAlarm: { addListener: (listener: (typeof alarmListeners)[number]) => alarmListeners.push(listener) },
      },
      runtime: { onStartup: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() } },
    },
  });
  runInContext(
    `${source}\nglobalThis.worker = { normalize, key, fingerprint, reconcile, incoming, readEvents, connect, settle: () => chain };`,
    context,
  );
  const worker = context.worker as Worker;
  await worker.connect();
  state.token = 'test-token';
  return {
    worker,
    cookies,
    storage,
    state,
    fetch,
    posts,
    warn,
    get jar() {
      return jar;
    },
    snapshot(values: Cookie[]) {
      snapshot = values;
    },
    revision(value: number) {
      revision = value;
    },
    replace(values: Cookie[]) {
      jar = values.map(raw);
    },
    changed,
    tokenChanged() {
      for (const listener of storageListeners) listener({ token: {} }, 'local');
    },
    alarm() {
      for (const listener of alarmListeners) listener({ name: 'mica-cookie-reconnect' });
    },
  };
}

function eventStream() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
    cancel,
  });
  return {
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    cancel,
    write(text: string) {
      writer.enqueue(new TextEncoder().encode(text));
    },
    close() {
      writer.close();
    },
  };
}

describe('cookie sync extension service worker', () => {
  it('does not replay events older than the snapshot or a confirmed local write', async () => {
    const local = cookie('new-chrome');
    const h = await harness([local]);
    h.state.baseline[h.worker.key(local)] = await h.worker.fingerprint(cookie('old'));
    h.snapshot([cookie('old')]);
    h.revision(10);
    await h.worker.reconcile('test-token');
    await h.worker.incoming({ cookie: cookie('old'), removed: false, revision: 10 });
    await h.worker.incoming({ cookie: cookie('stale'), removed: true, revision: 9 });
    expect(h.jar).toEqual([raw(local)]);
    await h.worker.incoming({ cookie: cookie('new-mica'), removed: false, revision: 12 });
    expect(h.jar).toEqual([raw(cookie('new-mica'))]);
  });

  it('preserves explicit session expiry and ignores unsupported stores and partitions', async () => {
    const h = await harness();
    expect(h.worker.key(cookie())).not.toBe(h.worker.key(cookie('one', { hostOnly: false })));
    expect(h.worker.normalize({ ...raw(cookie()), expiresAt: null, expirationDate: 123 })).toMatchObject({
      expiresAt: null,
    });
    expect(h.worker.normalize({ ...raw(cookie()), storeId: '1' })).toBeNull();
    expect(h.worker.normalize({ ...raw(cookie()), partitionKey: { topLevelSite: 'https://example.com' } })).toBeNull();
  });

  it('relays incremental changes both ways and suppresses Chrome write echoes and overwrite removals', async () => {
    const h = await harness();
    const incoming = cookie('from-mica');
    const stream = eventStream();
    const reading = h.worker.readEvents(stream.response).catch((error: Error) => error);
    stream.write(`data: ${JSON.stringify({ cookie: incoming, removed: false })}\n\n`);
    await vi.waitFor(() => expect(h.state.baseline[h.worker.key(incoming)]).toBeTypeOf('string'));
    expect(h.jar).toEqual([raw(incoming)]);
    expect(h.posts).toEqual([]);

    const outgoing = cookie('from-chrome');
    h.changed(raw(incoming), true, 'overwrite');
    h.changed(raw(outgoing), false);
    await h.worker.settle();
    expect(h.posts).toEqual([{ cookie: outgoing, removed: false }]);
    expect(h.state.baseline[h.worker.key(outgoing)]).toBe(await h.worker.fingerprint(outgoing));

    h.changed(raw(outgoing), true);
    await h.worker.settle();
    expect(h.posts[1]).toEqual({ cookie: outgoing, removed: true });
    expect(h.state.baseline).toEqual({});
    stream.close();
    expect(await reading).toMatchObject({ message: 'Local event stream ended' });
  });

  it('imports one-sided cookies but leaves first-connect and offline two-sided conflicts untouched', async () => {
    const local = cookie('chrome');
    const remote = cookie('mica');
    const h = await harness([local, cookie('chrome-only', { name: 'local' })]);
    h.snapshot([remote, cookie('mica-only', { name: 'remote' })]);
    await h.worker.reconcile('test-token');
    expect(h.posts).toEqual([{ cookie: cookie('chrome-only', { name: 'local' }), removed: false }]);
    expect(h.jar.map((entry) => entry.value).sort()).toEqual(['chrome', 'chrome-only', 'mica-only']);
    expect(h.state.baseline[h.worker.key(local)]).toBeUndefined();

    h.state.baseline[h.worker.key(local)] = await h.worker.fingerprint(cookie('old'));
    await h.worker.reconcile('test-token');
    expect(h.posts).toHaveLength(1);
    expect(h.jar.find((entry) => entry.name === 'session')?.value).toBe('chrome');
    expect(h.state.baseline[h.worker.key(local)]).toBe(await h.worker.fingerprint(cookie('old')));
  });

  it('reconciles one-sided offline updates and deletions against the shared baseline', async () => {
    const base = cookie();
    const h = await harness([base]);
    h.snapshot([base]);
    await h.worker.reconcile('test-token');
    h.snapshot([cookie('new-mica')]);
    await h.worker.reconcile('test-token');
    expect(h.jar[0]?.value).toBe('new-mica');
    h.replace([cookie('new-chrome')]);
    await h.worker.reconcile('test-token');
    expect(h.posts).toEqual([{ cookie: cookie('new-chrome'), removed: false }]);

    h.snapshot([cookie('new-chrome')]);
    h.replace([]);
    await h.worker.reconcile('test-token');
    expect(h.posts[1]).toEqual({ cookie: cookie('new-chrome'), removed: true });
    expect(h.state.baseline).toEqual({});

    h.replace([base]);
    h.snapshot([base]);
    await h.worker.reconcile('test-token');
    h.snapshot([]);
    await h.worker.reconcile('test-token');
    expect(h.jar).toEqual([]);
    expect(h.state.baseline).toEqual({});
    expect(h.posts).toHaveLength(2);
  });

  it('forgets baseline-only cookies when both sides deleted them, allowing later recreation', async () => {
    const base = cookie();
    const h = await harness();
    h.state.baseline[h.worker.key(base)] = await h.worker.fingerprint(base);
    await h.worker.reconcile('test-token');
    expect(h.state.baseline).toEqual({});
    h.snapshot([base]);
    await h.worker.reconcile('test-token');
    expect(h.jar).toEqual([raw(base)]);
    expect(h.posts).toEqual([]);
  });

  it('deletes only the exact cookie when same-name paths, domains and stores shadow it', async () => {
    const target = cookie('target', { path: '/app', host: 'sub.example.com' });
    const others = [
      cookie('root', { host: target.host }),
      cookie('nested', { host: target.host, path: '/app/deeper' }),
      cookie('parent', { hostOnly: false, path: '/app' }),
    ];
    const h = await harness([...others, target]);
    h.jar.push({ ...raw(target), storeId: '1' }, { ...raw(target), partitionKey: {} });
    await h.worker.incoming({ cookie: target, removed: true });
    await h.worker.settle();
    expect(h.cookies.remove).not.toHaveBeenCalled();
    expect(h.jar).toEqual([...others.map(raw), { ...raw(target), storeId: '1' }, { ...raw(target), partitionKey: {} }]);
    expect(h.cookies.set).toHaveBeenCalledWith(expect.objectContaining({ path: '/app', expirationDate: 1 }));
    expect(h.posts).toEqual([]);
  });

  it('uses ping comments to keep the MV3 worker alive without polling snapshots', async () => {
    const h = await harness();
    h.storage.get.mockClear();
    const stream = eventStream();
    const reading = h.worker.readEvents(stream.response).catch((error: Error) => error);
    stream.write(': connected\n\n: pi');
    stream.write('ng\r\n\r\n:ping\n\n');
    stream.close();
    await reading;
    expect(h.storage.get.mock.calls).toEqual([['token'], ['token']]);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(stream.response.body?.locked).toBe(false);
  });

  it.each(['snapshot', 'parse', 'write', 'status'])(
    'cancels the SSE body and aborts its controller on %s failure',
    async (failure) => {
      const h = await harness();
      const stream = eventStream();
      let signal: AbortSignal | null | undefined;
      h.fetch.mockImplementation(async (url, init) => {
        if (url.endsWith('/events')) {
          signal = init?.signal;
          if (failure === 'status') return new Response(stream.response.body, { status: 503 });
          return stream.response;
        }
        if (failure === 'snapshot') return new Response('', { status: 502 });
        return Response.json({ cookies: [] });
      });
      if (failure === 'parse') stream.write('data: invalid json\n\n');
      if (failure === 'write') {
        h.cookies.set.mockRejectedValueOnce(new Error('write failed'));
        stream.write(`data: ${JSON.stringify({ cookie: cookie(), removed: false })}\n\n`);
      }
      await h.worker.connect();
      expect(signal?.aborted).toBe(true);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(stream.response.body?.locked).toBe(false);
      expect(h.state.baseline).toEqual({});
      expect(h.warn).toHaveBeenCalled();
      h.state.token = '';
      await h.worker.connect();
      expect(h.fetch.mock.calls.filter(([url]) => url.endsWith('/events'))).toHaveLength(1);
    },
  );

  it('closes an active stream when the token changes and reconnects with the new token', async () => {
    const h = await harness();
    const streams = [eventStream(), eventStream()];
    const signals: AbortSignal[] = [];
    h.fetch.mockImplementation(async (url, init) => {
      if (url.endsWith('/snapshot')) return Response.json({ cookies: [] });
      const stream = streams[signals.length]!;
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      signal.addEventListener('abort', () => {
        void stream.response.body?.cancel().catch(() => {});
      });
      return stream.response;
    });
    const connecting = h.worker.connect();
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    h.state.token = 'new-token';
    h.tokenChanged();
    // The mock stream does not implement fetch's abort behavior, so end its pending read.
    streams[0]!.close();
    await connecting;
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(h.fetch.mock.calls.filter(([url]) => url.endsWith('/events'))[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer new-token',
    });
    h.state.token = '';
    streams[1]!.close();
    await h.worker.connect();
    expect(signals[1]?.aborted).toBe(true);
  });
});

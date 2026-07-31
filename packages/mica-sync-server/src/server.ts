import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventHub } from './events.js';
import { SyncStore, type MachineRecord, type StoredSession } from './store.js';

export type SyncServerOptions = {
  port: number;
  host?: string;
  dataDir: string;
  webDir?: string;
};

export type RunningSyncServer = {
  port: number;
  stop(): Promise<void>;
};

type Command =
  | { type: 'run'; id: string; sessionId: string; prompt: string; requestedAt: string }
  | { type: 'abort'; id: string; sessionId: string; requestedAt: string };

const MACHINE_ONLINE_MS = 90_000;
const POLL_HOLD_MS = 25_000;
const SSE_HEARTBEAT_MS = 15_000;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export async function startSyncServer(options: SyncServerOptions): Promise<RunningSyncServer> {
  const store = new SyncStore(options.dataDir);
  const hub = new EventHub();
  const commands = new Map<string, Command[]>();
  const pollWaiters = new Map<string, Array<{ resolve: (commands: Command[]) => void; timer: NodeJS.Timeout }>>();
  const webDir = options.webDir ? resolve(options.webDir) : undefined;

  function enqueueCommand(machineId: string, command: Command): void {
    const queue = commands.get(machineId) ?? [];
    queue.push(command);
    commands.set(machineId, queue);
    const waiters = pollWaiters.get(machineId);
    if (waiters) {
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(queue.splice(0, queue.length));
      }
    }
  }

  function takeCommands(machineId: string): Command[] {
    const queue = commands.get(machineId) ?? [];
    const taken = queue.splice(0, queue.length);
    if (queue.length === 0) commands.delete(machineId);
    return taken;
  }

  function isOnline(machine: MachineRecord): boolean {
    return Date.now() - Date.parse(machine.lastSeen) < MACHINE_ONLINE_MS;
  }

  // ── HTTP server ──

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const handled = await handleRequest(request, response, url, {
        store,
        hub,
        enqueueCommand,
        takeCommands,
        pollWaiters,
        isOnline,
        webDir,
      });
      if (!handled) {
        if (webDir) {
          serveStaticFile(response, webDir, url.pathname);
        } else {
          writeJson(response, 404, { error: 'Not found' });
        }
      }
    } catch (error) {
      writeJson(response, 500, {
        error: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  await new Promise<void>((resolveListen) => server.listen(options.port, options.host ?? '0.0.0.0', resolveListen));

  return {
    port: options.port,
    stop: () =>
      new Promise<void>((resolveStop) => {
        server.close(() => resolveStop());
      }),
  };
}

type HandlerContext = {
  store: SyncStore;
  hub: EventHub;
  enqueueCommand: (machineId: string, command: Command) => void;
  takeCommands: (machineId: string) => Command[];
  pollWaiters: Map<string, Array<{ resolve: (commands: Command[]) => void; timer: NodeJS.Timeout }>>;
  isOnline: (machine: MachineRecord) => boolean;
  webDir?: string;
};

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: HandlerContext,
): Promise<boolean> {
  const { pathname } = url;
  const method = request.method ?? 'GET';

  // ── daemon endpoints (identified by x-machine-id header) ──
  if (pathname === '/daemon/register' && method === 'POST') {
    const body = await readJsonBody(request);
    const machine = ctx.store.upsertMachine({
      id: typeof body.machineId === 'string' ? body.machineId : undefined,
      name: String(body.name ?? ''),
      hostname: String(body.hostname ?? ''),
      platform: String(body.platform ?? ''),
      version: String(body.version ?? ''),
    });
    writeJson(response, 200, { machineId: machine.id, name: machine.name });
    return true;
  }

  if (pathname === '/daemon/beat' && method === 'POST') {
    const machine = machineFromRequest(request, ctx);
    if (!machine) return writeJson(response, 404, { error: 'Unknown machine; register first' });
    const body = await readJsonBody(request);
    const active = body.active;
    ctx.store.updateMachine(machine.id, {
      lastSeen: new Date().toISOString(),
      activeSessionId: active?.sessionId ? String(active.sessionId) : null,
      activeRunning: Boolean(active?.running),
    });
    writeJson(response, 200, { ok: true, serverTime: Date.now() });
    return true;
  }

  if (pathname === '/daemon/poll' && method === 'POST') {
    const machine = machineFromRequest(request, ctx);
    if (!machine) return writeJson(response, 404, { error: 'Unknown machine; register first' });
    ctx.store.updateMachine(machine.id, { lastSeen: new Date().toISOString() });
    const pending = ctx.takeCommands(machine.id);
    if (pending.length > 0) {
      writeJson(response, 200, { commands: pending });
      return true;
    }
    await new Promise<void>((resolvePoll) => {
      const timer = setTimeout(() => {
        removeWaiter(ctx, machine.id, waiter);
        writeJson(response, 200, { commands: [] });
        resolvePoll();
      }, POLL_HOLD_MS);
      const waiter = {
        resolve: (commands: Command[]) => {
          clearTimeout(timer);
          writeJson(response, 200, { commands });
          resolvePoll();
        },
        timer,
      };
      const waiters = ctx.pollWaiters.get(machine.id) ?? [];
      waiters.push(waiter);
      ctx.pollWaiters.set(machine.id, waiters);
    });
    return true;
  }

  if (pathname === '/daemon/session' && method === 'POST') {
    const machine = machineFromRequest(request, ctx);
    if (!machine) return writeJson(response, 404, { error: 'Unknown machine; register first' });
    const body = await readJsonBody(request);
    const session = body.session as StoredSession | undefined;
    const sessionId = String(body.sessionId ?? '');
    if (!session?.id && !sessionId) {
      writeJson(response, 400, { error: 'Missing session' });
      return true;
    }
    if (!session?.id) {
      if (ctx.store.deleteSession(machine.id, sessionId)) {
        ctx.hub.publish(machine.id, sessionId, { type: 'session_removed', sessionId });
      }
      writeJson(response, 200, { ok: true });
      return true;
    }
    if (ctx.store.writeSession(machine.id, session)) {
      // The web client only needs lightweight metadata for live events; the
      // full conversation is fetched via the detail endpoint. Publishing the
      // full snapshot here made SSE buffers grow to ~300KB per save.
      ctx.hub.publish(machine.id, session.id, { type: 'session', session: lightSession(session) });
    }
    writeJson(response, 200, { ok: true });
    return true;
  }

  if (pathname === '/daemon/events' && method === 'POST') {
    const machine = machineFromRequest(request, ctx);
    if (!machine) return writeJson(response, 404, { error: 'Unknown machine; register first' });
    const body = await readJsonBody(request);
    const sessionId = String(body.sessionId ?? '');
    const events = Array.isArray(body.events) ? (body.events as Array<Record<string, unknown>>) : [];
    for (const event of events) {
      ctx.hub.publish(machine.id, sessionId, {
        type: String(event.type ?? 'unknown'),
        ...event,
      });
    }
    if (body.session) {
      const session = body.session as StoredSession;
      if (ctx.store.writeSession(machine.id, session)) {
        ctx.hub.publish(machine.id, sessionId, { type: 'session', session: lightSession(session) });
      }
    }
    writeJson(response, 200, { ok: true });
    return true;
  }

  // ── web endpoints ──
  if (pathname === '/api/status' && method === 'GET') {
    writeJson(response, 200, { ok: true, serverTime: Date.now() });
    return true;
  }

  if (pathname === '/api/machines' && method === 'GET') {
    const machines = ctx.store.listMachines().map((machine) => ({
      ...machine,
      online: ctx.isOnline(machine),
    }));
    writeJson(response, 200, { machines });
    return true;
  }

  const machineMatch = pathname.match(/^\/api\/machines\/([^/]+)\/sessions(?:\/([^/]+))?(\/(events|run|abort))?$/);
  if (machineMatch && method !== 'OPTIONS') {
    const [, machineId, sessionId, , action] = machineMatch;
    const machine = ctx.store.getMachine(machineId!);
    if (!machine) {
      writeJson(response, 404, { error: 'Machine not found' });
      return true;
    }

    if (!sessionId) {
      const sessions = ctx.store.listSessionSummaries(machineId!).map((summary) => ({
        ...summary,
        // Let the web client open SSE immediately on switch without waiting
        // for the detail fetch, and without replaying buffered events that the
        // upcoming detail snapshot already contains.
        snapshotSeq: ctx.hub.snapshotSeq(machineId!, summary.id),
      }));
      writeJson(response, 200, { machine: { ...machine, online: ctx.isOnline(machine) }, sessions });
      return true;
    }

    if (!action) {
      const session = ctx.store.readSession(machineId!, sessionId);
      if (!session) {
        writeJson(response, 404, { error: 'Session not found' });
        return true;
      }
      const full = url.searchParams.get('full') === '1';
      writeJson(response, 200, {
        machine: { ...machine, online: ctx.isOnline(machine) },
        session: full ? session : slimSession(session),
        snapshotSeq: ctx.hub.snapshotSeq(machineId!, sessionId),
      });
      return true;
    }

    if (action === 'events' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      return handleSse(request, response, ctx, machineId!, sessionId, since);
    }

    if (action === 'run' && method === 'POST') {
      if (!ctx.isOnline(machine)) {
        writeJson(response, 409, { error: 'Machine is offline; start `mica daemon` on it and retry.' });
        return true;
      }
      const body = await readJsonBody(request);
      const text = String(body.text ?? '').trim();
      if (!text) {
        writeJson(response, 400, { error: 'Empty message' });
        return true;
      }
      const command: Command = {
        type: 'run',
        id: randomUUID(),
        sessionId: sessionId!,
        prompt: text,
        requestedAt: new Date().toISOString(),
      };
      ctx.enqueueCommand(machineId!, command);
      writeJson(response, 200, { commandId: command.id });
      return true;
    }

    if (action === 'abort' && method === 'POST') {
      const command: Command = {
        type: 'abort',
        id: randomUUID(),
        sessionId: sessionId!,
        requestedAt: new Date().toISOString(),
      };
      ctx.enqueueCommand(machineId!, command);
      writeJson(response, 200, { commandId: command.id });
      return true;
    }
  }

  return false;
}

function handleSse(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: HandlerContext,
  machineId: string,
  sessionId: string,
  since: number,
): boolean {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  response.write(': connected\n\n');

  const unsubscribe = ctx.hub.subscribe(machineId, sessionId, since, (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    response.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);

  request.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  });
  return true;
}

function machineFromRequest(request: IncomingMessage, ctx: HandlerContext): MachineRecord | null {
  const machineId = request.headers['x-machine-id'];
  if (!machineId) return null;
  return ctx.store.getMachine(String(machineId));
}

function removeWaiter(
  ctx: HandlerContext,
  machineId: string,
  target: { resolve: (commands: Command[]) => void; timer: NodeJS.Timeout },
): void {
  const waiters = ctx.pollWaiters.get(machineId) ?? [];
  const index = waiters.indexOf(target);
  if (index >= 0) waiters.splice(index, 1);
  if (waiters.length === 0) ctx.pollWaiters.delete(machineId);
}

/**
 * Detail response used by the web console. The provider `messages` history
 * (and usage records) are only needed to resume a turn on the daemon machine;
 * the web renders `conversationMessages` exclusively. Stripping them cut the
 * largest session payload from ~1.3MB to ~15KB, which was the dominant cost of
 * switching sessions on slow links.
 */
function slimSession(session: StoredSession): StoredSession {
  const snapshot = (session.snapshot ?? {}) as Record<string, unknown>;
  const { messages: _messages, usageHistory: _usage, lastUsage: _last, ...rest } = snapshot;
  return { ...session, snapshot: rest as StoredSession['snapshot'] };
}

/** Lightweight metadata published with live `session` SSE events. */
function lightSession(session: StoredSession): StoredSession {
  const snapshot = (session.snapshot ?? {}) as Record<string, unknown>;
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    turnState: session.turnState,
    revision: session.revision,
    snapshot: {
      providerId: snapshot.providerId,
      model: snapshot.model,
      effort: snapshot.effort,
      role: snapshot.role,
    } as StoredSession['snapshot'],
  };
}

function writeJson(response: ServerResponse, status: number, value: unknown): boolean {
  const body = JSON.stringify(value);
  response.writeHead(status, JSON_HEADERS);
  response.end(body);
  return true;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── static assets ──

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveStaticFile(response: ServerResponse, webDir: string, pathname: string): void {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(webDir, relative));
  if (!filePath.startsWith(resolve(webDir))) {
    writeJson(response, 403, { error: 'Forbidden' });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    writeJson(response, 404, { error: 'Not found' });
    return;
  }
  const extension = extname(filePath).toLowerCase();
  const isHtml = extension === '.html';
  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    // index.html is revalidated on every refresh so the latest bundle is
    // picked up; hashed assets under /assets/ are immutable and cacheable.
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  response.end(readFileSync(filePath));
}

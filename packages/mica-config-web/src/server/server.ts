import { readConfigWebFile, writeConfigWebFile } from './configFiles.js';
import {
  createRole,
  getMcpDetails,
  getPluginsDetails,
  getRolesDetails,
  getSessionDetails,
  getSessionsDetails,
  getSkillsDetails,
  writeRole,
} from './details.js';
import { serveGeneratedStaticAsset } from './staticAssets.js';
import { writeConfigWebState } from './singleton.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigWebConversationDetails } from '../shared/types.js';

const IDLE_EXIT_DELAY_MS = 30_000;

export type ConfigWebServerOptions = {
  token: string;
  preferredPort?: number;
};

export type RunningConfigWebServer = {
  port: number;
  url: string;
  stop(): void;
};

export async function startConfigWebServer(options: ConfigWebServerOptions): Promise<RunningConfigWebServer> {
  let clients = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let conversation: ConfigWebConversationDetails | null = null;

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const scheduleIdleExit = () => {
    clearIdleTimer();
    idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_DELAY_MS);
    idleTimer.unref?.();
  };

  const bun = globalThis.Bun;
  if (!bun) throw new Error('Config web server requires Bun runtime');

  if (process.env.MICA_CONFIG_WEB_DEV === '1') {
    return startDevConfigWebServer(
      options,
      bun,
      clearIdleTimer,
      scheduleIdleExit,
      () => clients,
      (next) => {
        clients = next;
      },
      () => conversation,
      (next) => {
        conversation = next;
      },
    );
  }

  const webServer = bun.serve({
    hostname: '127.0.0.1',
    port: options.preferredPort ?? 0,
    async fetch(request: Request, server: Bun.Server<unknown>) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        return handleApiRequest(request, server, url, options.token, clients, {
          get: () => conversation,
          set: (next) => {
            conversation = next;
            broadcastWebSocketEvent(server, 'conversation.updated');
          },
        });
      }
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!isAuthorized(url, options.token)) return json({ error: 'Unauthorized' }, 401);
      }
      return serveGeneratedStaticAsset(url.pathname) ?? json({ error: 'Config web assets are not built' }, 500);
    },
    websocket: {
      open(socket: Bun.ServerWebSocket<unknown>) {
        socket.subscribe('config-web-events');
        clients += 1;
        clearIdleTimer();
      },
      close() {
        clients = Math.max(0, clients - 1);
        if (clients === 0) scheduleIdleExit();
      },
    },
  });
  const webPort = webServer.port;

  const state = { pid: process.pid, port: webPort, token: options.token };
  writeConfigWebState(state);
  scheduleIdleExit();

  return {
    port: webPort,
    url: `http://127.0.0.1:${webPort}/?token=${encodeURIComponent(options.token)}`,
    stop() {
      clearIdleTimer();
      webServer.stop(true);
    },
  };
}

async function startDevConfigWebServer(
  options: ConfigWebServerOptions,
  bun: NonNullable<typeof globalThis.Bun>,
  clearIdleTimer: () => void,
  scheduleIdleExit: () => void,
  getClients: () => number,
  setClients: (clients: number) => void,
  getConversation: () => ConfigWebConversationDetails | null,
  setConversation: (conversation: ConfigWebConversationDetails) => void,
): Promise<RunningConfigWebServer> {
  const apiServer = bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request, server: Bun.Server<unknown>) {
      const url = new URL(request.url);
      if (!isAuthorized(url, options.token)) return json({ error: 'Unauthorized' }, 401);
      return handleApiRequest(request, server, url, options.token, getClients(), {
        get: getConversation,
        set: (next) => {
          setConversation(next);
          broadcastWebSocketEvent(server, 'conversation.updated');
        },
      });
    },
    websocket: {
      open(socket: Bun.ServerWebSocket<unknown>) {
        socket.subscribe('config-web-events');
        setClients(getClients() + 1);
        clearIdleTimer();
      },
      close() {
        const nextClients = Math.max(0, getClients() - 1);
        setClients(nextClients);
        if (nextClients === 0) scheduleIdleExit();
      },
    },
  });

  const { createServer } = await import('vite');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
  const viteServer = await createServer({
    root,
    server: {
      host: '127.0.0.1',
      port: options.preferredPort ?? 0,
      strictPort: false,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiServer.port}`,
          ws: true,
        },
      },
    },
    logLevel: 'silent',
  });
  await viteServer.listen();

  const webAddress = viteServer.httpServer?.address();
  const webPort = typeof webAddress === 'object' && webAddress ? webAddress.port : apiServer.port;
  writeConfigWebState({ pid: process.pid, port: webPort, token: options.token });
  scheduleIdleExit();

  return {
    port: webPort,
    url: `http://127.0.0.1:${webPort}/?token=${encodeURIComponent(options.token)}`,
    stop() {
      clearIdleTimer();
      apiServer.stop(true);
      void viteServer.close();
    },
  };
}

async function handleApiRequest(
  request: Request,
  server: Bun.Server<unknown>,
  url: URL,
  token: string,
  clients: number,
  conversation: {
    get(): ConfigWebConversationDetails | null;
    set(details: ConfigWebConversationDetails): void;
  },
): Promise<Response | undefined> {
  if (!isAuthorized(url, token)) return json({ error: 'Unauthorized' }, 401);

  if (url.pathname === '/api/ping') return json({ ok: true, clients });
  if (url.pathname === '/api/details/mcp') return json(await getMcpDetails());
  if (url.pathname === '/api/details/skills') return json(getSkillsDetails());
  if (url.pathname === '/api/details/plugins') return json(getPluginsDetails());
  if (url.pathname === '/api/details/sessions') return json(getSessionsDetails());
  if (url.pathname === '/api/details/session') {
    try {
      return json(getSessionDetails(url.searchParams.get('id') ?? ''));
    } catch (error) {
      return json({ error: formatError(error) }, 404);
    }
  }
  if (url.pathname === '/api/details/roles') return json(getRolesDetails());

  if (url.pathname === '/api/files/role') {
    try {
      const body = (await request.json()) as { name?: unknown; content?: unknown };
      if (typeof body.name !== 'string') return json({ error: 'name must be string' }, 400);
      if (request.method === 'POST') {
        if (body.content !== undefined && typeof body.content !== 'string') {
          return json({ error: 'content must be string' }, 400);
        }
        return json(createRole(body.name, body.content ?? ''));
      }
      if (request.method === 'PUT') {
        if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
        return json(writeRole(body.name, body.content));
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

  if (url.pathname === '/api/details/conversation') {
    if (request.method === 'GET') return json(conversation.get());
    if (request.method === 'PUT') {
      try {
        const body = (await request.json()) as unknown;
        if (!isConversationDetails(body)) return json({ error: 'Invalid conversation payload' }, 400);
        conversation.set(body);
        return json(body);
      } catch (error) {
        return json({ error: formatError(error) }, 400);
      }
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  if (url.pathname === '/api/events') {
    if (server.upgrade(request, { data: {} })) return undefined;
    return json({ error: 'Upgrade failed' }, 400);
  }

  if (url.pathname === '/api/files/config') {
    try {
      if (request.method === 'GET') return json(readConfigWebFile());
      if (request.method === 'PUT') {
        const body = (await request.json()) as { content?: unknown };
        if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
        return json(writeConfigWebFile(body.content));
      }
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  return json({ error: 'Not found' }, 404);
}

function isAuthorized(url: URL, token: string): boolean {
  return url.searchParams.get('token') === token;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function broadcastWebSocketEvent(server: Bun.Server<unknown>, event: string): void {
  server.publish('config-web-events', JSON.stringify({ type: event }));
}

function isConversationDetails(value: unknown): value is ConfigWebConversationDetails {
  if (!value || typeof value !== 'object') return false;
  const details = value as Partial<ConfigWebConversationDetails>;
  return (
    typeof details.providerId === 'string' &&
    (details.protocol === 'openai_chat_completions' || details.protocol === 'openai_responses') &&
    typeof details.model === 'string' &&
    typeof details.updatedAt === 'string' &&
    Array.isArray(details.items) &&
    details.items.every(isConversationItem)
  );
}

function isConversationItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as ConfigWebConversationDetails['items'][number];
  return (
    Number.isInteger(item.sequence) &&
    item.sequence > 0 &&
    ['system', 'user', 'assistant', 'tool_call', 'tool_result', 'unknown'].includes(item.type) &&
    typeof item.content === 'string' &&
    (item.callId === undefined || typeof item.callId === 'string') &&
    (item.toolName === undefined || typeof item.toolName === 'string') &&
    (item.role === undefined || typeof item.role === 'string')
  );
}

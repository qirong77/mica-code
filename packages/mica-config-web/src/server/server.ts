import { readConfigWebFile, writeConfigWebFile } from './configFiles.js';
import {
  createMcpServer,
  createRole,
  createSkill,
  deleteMcpServer,
  deleteRole,
  deleteSkill,
  getMcpDetails,
  getPluginsDetails,
  getRolesDetails,
  getSessionDetails,
  getSessionsDetails,
  getSkillsDetails,
  writeMcpServer,
  writeRole,
  writeSessionDetails,
  writeSkill,
} from './details.js';
import { serveGeneratedStaticAsset } from './staticAssets.js';
import { writeConfigWebState } from './singleton.js';
import { resolveConfigWebAdvertisedUrl, resolveConfigWebBindHost } from './publicUrl.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDLE_EXIT_DELAY_MS = 30_000;

const DEFAULT_PORT = 13987;
function readPreferredPort(): number | undefined {
  const raw = process.env.MICA_CONFIG_WEB_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MICA_CONFIG_WEB_PORT: ${raw}`);
  }
  return port;
}

export type ConfigWebServerOptions = {
  preferredPort?: number;
};

export type RunningConfigWebServer = {
  port: number;
  url: string;
  stop(): void;
};

export async function startConfigWebServer(options: ConfigWebServerOptions): Promise<RunningConfigWebServer> {
  const preferredPort = options.preferredPort ?? readPreferredPort();
  const bindHost = resolveConfigWebBindHost();
  const persistent = process.env.MICA_CONFIG_WEB_PERSIST === '1';
  let clients = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const scheduleIdleExit = () => {
    if (persistent) return;
    // Keep the Vite debug server alive while iterating on config-web UI.
    if (process.env.MICA_CONFIG_WEB_DEV === '1') return;
    clearIdleTimer();
    idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_DELAY_MS);
    idleTimer.unref?.();
  };

  const bun = globalThis.Bun;
  if (!bun) throw new Error('Config web server requires Bun runtime');

  if (process.env.MICA_CONFIG_WEB_DEV === '1') {
    return startDevConfigWebServer(
      preferredPort,
      bun,
      bindHost,
      persistent,
      clearIdleTimer,
      scheduleIdleExit,
      () => clients,
      (next) => {
        clients = next;
      },
    );
  }

  const webServer = bun.serve({
    hostname: bindHost,
    port: preferredPort ?? DEFAULT_PORT,
    async fetch(request: Request, server: Bun.Server<unknown>) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        return handleApiRequest(request, server, url, clients);
      }
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
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

  const state = { pid: process.pid, port: webPort, host: bindHost, persistent };
  writeConfigWebState(state);
  scheduleIdleExit();

  return {
    port: webPort,
    url: resolveConfigWebAdvertisedUrl(webPort),
    stop() {
      clearIdleTimer();
      webServer.stop(true);
    },
  };
}

async function startDevConfigWebServer(
  preferredPort: number | undefined,
  bun: NonNullable<typeof globalThis.Bun>,
  bindHost: string,
  persistent: boolean,
  clearIdleTimer: () => void,
  scheduleIdleExit: () => void,
  getClients: () => number,
  setClients: (clients: number) => void,
): Promise<RunningConfigWebServer> {
  const apiServer = bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request, server: Bun.Server<unknown>) {
      const url = new URL(request.url);
      return handleApiRequest(request, server, url, getClients());
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
    configFile: resolve(root, 'vite.config.ts'),
    server: {
      host: bindHost,
      port: preferredPort ?? DEFAULT_PORT,
      strictPort: false,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiServer.port}`,
          ws: true,
        },
      },
    },
    logLevel: 'info',
  });
  await viteServer.listen();

  const webAddress = viteServer.httpServer?.address();
  const webPort = typeof webAddress === 'object' && webAddress ? webAddress.port : apiServer.port;
  writeConfigWebState({ pid: process.pid, port: webPort, host: bindHost, persistent });
  scheduleIdleExit();

  return {
    port: webPort,
    url: resolveConfigWebAdvertisedUrl(webPort),
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
  clients: number,
): Promise<Response | undefined> {
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

  if (url.pathname === '/api/files/session') {
    try {
      if (request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
      const body = (await request.json()) as { id?: unknown; content?: unknown };
      if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
      if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
      return json(writeSessionDetails(body.id, body.content));
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

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
      if (request.method === 'DELETE') {
        return json(deleteRole(body.name));
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

  if (url.pathname === '/api/files/mcp') {
    try {
      const body = (await request.json()) as { name?: unknown; content?: unknown };
      if (typeof body.name !== 'string') return json({ error: 'name must be string' }, 400);
      if (request.method === 'POST') {
        if (body.content !== undefined && typeof body.content !== 'string') {
          return json({ error: 'content must be string' }, 400);
        }
        return json(await createMcpServer(body.name, body.content ?? ''));
      }
      if (request.method === 'PUT') {
        if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
        return json(await writeMcpServer(body.name, body.content));
      }
      if (request.method === 'DELETE') {
        return json(await deleteMcpServer(body.name));
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

  if (url.pathname === '/api/files/skill') {
    try {
      const body = (await request.json()) as { name?: unknown; content?: unknown };
      if (typeof body.name !== 'string') return json({ error: 'name must be string' }, 400);
      if (request.method === 'POST') {
        if (body.content !== undefined && typeof body.content !== 'string') {
          return json({ error: 'content must be string' }, 400);
        }
        return json(createSkill(body.name, body.content ?? ''));
      }
      if (request.method === 'PUT') {
        if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
        return json(writeSkill(body.name, body.content));
      }
      if (request.method === 'DELETE') {
        return json(deleteSkill(body.name));
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

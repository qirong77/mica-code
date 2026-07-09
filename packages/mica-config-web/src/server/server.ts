import { readConfigWebFile, writeConfigWebFile } from './configFiles.js';
import { writeConfigWebState } from './singleton.js';
import type { ConfigWebSection } from '../shared/types.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const apiServer = bun.serve({
    hostname: '127.0.0.1',
    port: options.preferredPort ?? 0,
    async fetch(request: Request, server: Bun.Server<unknown>) {
      const url = new URL(request.url);
      if (!isAuthorized(url, options.token)) return json({ error: 'Unauthorized' }, 401);

      if (url.pathname === '/api/ping') {
        return json({ ok: true, clients });
      }

      if (url.pathname === '/api/events') {
        if (server.upgrade(request, { data: {} })) return undefined;
        return json({ error: 'Upgrade failed' }, 400);
      }

      if (url.pathname.startsWith('/api/files/')) {
        const section = url.pathname.slice('/api/files/'.length) as ConfigWebSection;
        if (!isSection(section)) return json({ error: 'Unknown section' }, 404);
        try {
          if (request.method === 'GET') return json(readConfigWebFile(section));
          if (request.method === 'PUT') {
            const body = (await request.json()) as { content?: unknown };
            if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
            return json(writeConfigWebFile(section, body.content));
          }
        } catch (error) {
          return json({ error: formatError(error) }, 400);
        }
        return json({ error: 'Method not allowed' }, 405);
      }

      return json({ error: 'Not found' }, 404);
    },
    websocket: {
      open() {
        clients += 1;
        clearIdleTimer();
      },
      close() {
        clients = Math.max(0, clients - 1);
        if (clients === 0) scheduleIdleExit();
      },
    },
  });

  const { createServer } = await import('vite');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
  const webServer = await createServer({
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
  await webServer.listen();

  const webAddress = webServer.httpServer?.address();
  const webPort = typeof webAddress === 'object' && webAddress ? webAddress.port : apiServer.port;

  const state = { pid: process.pid, port: webPort, token: options.token, updatedAt: new Date().toISOString() };
  writeConfigWebState(state);
  scheduleIdleExit();

  return {
    port: webPort,
    url: `http://127.0.0.1:${webPort}/?token=${encodeURIComponent(options.token)}`,
    stop() {
      clearIdleTimer();
      apiServer.stop(true);
      void webServer.close();
    },
  };
}

function isAuthorized(url: URL, token: string): boolean {
  return url.searchParams.get('token') === token;
}

function isSection(value: string): value is ConfigWebSection {
  return value === 'config' || value === 'mcp' || value === 'skills' || value === 'plugins';
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

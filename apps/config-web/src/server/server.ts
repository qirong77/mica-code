import { isRecord } from '@packages/mica-common/guards.js';
import { runConfigWebAction } from '@packages/mica-config-ui/index.js';
import { CONFIG_WEB_EVENTS_PATH, httpRoutes, matchHttpAction } from '../httpRoutes.js';
import type { ViteDevServer } from 'vite';
import { CONFIG_WEB_PORT_ENV, DEFAULT_CONFIG_WEB_PORT, parseRuntimePort } from '@packages/mica-web-shared/index.js';
import { serveGeneratedStaticAsset } from './staticAssets.js';
import { devHeartbeat } from './devHeartbeat.js';
import { writeConfigWebState } from './singleton.js';
import { resolveConfigWebAdvertisedUrl, resolveConfigWebBindHost } from './publicUrl.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDLE_EXIT_DELAY_MS = 30_000;

/** 环境变量给的端口；未设置时 `undefined`（用默认值），设了但非法则直接抛错。 */
export function readPreferredPort(): number | undefined {
  const raw = process.env[CONFIG_WEB_PORT_ENV]?.trim();
  if (!raw) return undefined;
  const port = parseRuntimePort(raw, 0);
  // 显式配置写错就直接报错，不落回默认值——否则「填了却没生效」比启动失败更难查
  if (port === 0) {
    throw new Error(`Invalid ${CONFIG_WEB_PORT_ENV}: ${raw}`);
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

/** Dev serves the page through Vite. Both modes use the same API and heartbeat. */
export async function startConfigWebServer(options: ConfigWebServerOptions): Promise<RunningConfigWebServer> {
  const preferredPort = options.preferredPort ?? readPreferredPort();
  const bindHost = resolveConfigWebBindHost();
  const persistent = process.env.MICA_CONFIG_WEB_PERSIST === '1';
  const dev = process.env.MICA_CONFIG_WEB_DEV === '1';
  const bun = globalThis.Bun;
  if (!bun) throw new Error('Config web server requires Bun runtime');

  let clients = 0;
  let stopped = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let vite: ViteDevServer | undefined;
  function scheduleIdleExit() {
    clearTimeout(idleTimer);
    if (stopped || persistent || dev || clients > 0) return;
    idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_DELAY_MS);
    idleTimer.unref?.();
  }

  const server = bun.serve({
    hostname: dev ? '127.0.0.1' : bindHost,
    port: dev ? 0 : (preferredPort ?? DEFAULT_CONFIG_WEB_PORT),
    fetch(request: Request, server: Bun.Server<unknown>) {
      const url = new URL(request.url);
      if (url.pathname === CONFIG_WEB_EVENTS_PATH) {
        return server.upgrade(request, { data: {} }) ? undefined : json({ error: 'Upgrade failed' }, 400);
      }
      if (dev || url.pathname.startsWith('/api/')) return handleConfigApi(request, url);
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      return serveGeneratedStaticAsset(url.pathname) ?? json({ error: 'Config web assets are not built' }, 500);
    },
    websocket: {
      open(socket: Bun.ServerWebSocket<unknown>) {
        socket.subscribe('config-web-events');
        clients += 1;
        clearTimeout(idleTimer);
      },
      close() {
        clients = Math.max(0, clients - 1);
        if (!clients) scheduleIdleExit();
      },
    },
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(idleTimer);
    server.stop(true);
    void vite?.close();
  }

  try {
    let port = server.port;
    if (dev) {
      const { createServer } = await import('vite');
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
      vite = await createServer({
        root,
        configFile: resolve(root, 'vite.config.ts'),
        plugins: [devHeartbeat()],
        server: {
          host: bindHost,
          port: preferredPort ?? DEFAULT_CONFIG_WEB_PORT,
          strictPort: false,
          proxy: { '/api': `http://127.0.0.1:${server.port}` },
        },
        logLevel: 'info',
      });
      await vite.listen();
      const address = vite.httpServer?.address();
      if (address && typeof address === 'object') port = address.port;
    }
    writeConfigWebState({ pid: process.pid, port, host: bindHost, persistent });
    scheduleIdleExit();
    return { port, url: resolveConfigWebAdvertisedUrl(port), stop };
  } catch (error) {
    stop();
    throw error;
  }
}

export async function handleConfigApi(request: Request, url = new URL(request.url)): Promise<Response> {
  const query = Object.fromEntries(url.searchParams);
  const action = matchHttpAction(url.pathname, request.method, query.view);
  if (action === 404) return json({ error: 'Not found' }, 404);
  if (action === 405) return json({ error: 'Method not allowed' }, 405);
  try {
    let input: Record<string, unknown> = query;
    if (request.method !== 'GET') {
      const parsed: unknown = await request.json().catch(() => null);
      input = isRecord(parsed) ? parsed : {};
      if (action === 'createRole' || action === 'createSkill') input.content ??= '';
    } else if (action === 'readSessionConversationPage') {
      input.tail = query.tail === '1';
    }
    return json(await runConfigWebAction(action, input));
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      url.pathname === httpRoutes.readSessionDetails.path ? 404 : 400,
    );
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

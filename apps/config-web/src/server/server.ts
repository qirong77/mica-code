import { runConfigWebAction, type ConfigWebActionName } from '@packages/mica-config-ui/index.js';
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

/**
 * 浏览器端的 Config Web：把 `packages/mica-config-ui` 的动作表挂成 HTTP 路由，并托管由
 * `bun run build:config-web` 内嵌进来的页面产物。桌面端不用这个服务——它在运行时里把同一
 * 张动作表直接暴露成 IPC（见 apps/desktop 的 src/host/configWeb.js）。
 */
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
      if (url.pathname.startsWith('/api/')) return handleApiRequest(request, server, url);
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
      return handleApiRequest(request, server, new URL(request.url));
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

/* ------------------------------------------------------------------ HTTP → 动作 */

type ApiCall = { action: ConfigWebActionName; input: Record<string, unknown> };

const NOT_FOUND = Symbol('not-found');
const METHOD_NOT_ALLOWED = Symbol('method-not-allowed');

/**
 * 路径与方法 → 动作表。路径是前端 api 实现的既有约定，保持稳定；参数校验、错误语义都在
 * packages/mica-config-ui 的 actions.ts 里，这里只做搬运与状态码映射。
 */
async function handleApiRequest(
  request: Request,
  server: Bun.Server<unknown>,
  url: URL,
): Promise<Response | undefined> {
  if (url.pathname === '/api/events') {
    if (server.upgrade(request, { data: {} })) return undefined;
    return json({ error: 'Upgrade failed' }, 400);
  }

  try {
    const call = await resolveApiCall(request, url);
    if (call === NOT_FOUND) return json({ error: 'Not found' }, 404);
    if (call === METHOD_NOT_ALLOWED) return json({ error: 'Method not allowed' }, 405);
    return json(await runConfigWebAction(call.action, call.input));
  } catch (error) {
    return json({ error: formatError(error) }, url.pathname === '/api/details/session' ? 404 : 400);
  }
}

async function resolveApiCall(
  request: Request,
  url: URL,
): Promise<ApiCall | typeof NOT_FOUND | typeof METHOD_NOT_ALLOWED> {
  const method = request.method;
  const query = Object.fromEntries(url.searchParams.entries());
  const get = (action: ConfigWebActionName, input: Record<string, unknown> = {}): ApiCall => ({
    action,
    input,
  });
  const body = method === 'GET' ? {} : await readBody(request);

  switch (url.pathname) {
    case '/api/ping':
      return method === 'GET' ? get('ping') : METHOD_NOT_ALLOWED;

    case '/api/files/config':
      if (method === 'GET') return get('readConfigFile');
      if (method === 'PUT') return get('writeConfigFile', { content: body.content });
      return METHOD_NOT_ALLOWED;

    case '/api/details/session':
      if (method !== 'GET') return METHOD_NOT_ALLOWED;
      if (query.view === 'json') return get('readSessionContent', { id: query.id });
      if (query.view === 'conversation') return get('readSessionConversationPage', query);
      if (query.view === 'item') return get('readSessionItem', query);
      if (query.view === 'context') return get('readSessionContextAnalysis', { id: query.id });
      return get('readSessionDetails', { id: query.id });

    case '/api/files/session':
      if (method !== 'PUT') return METHOD_NOT_ALLOWED;
      return get('writeSession', { id: body.id, content: body.content });

    case '/api/details/mcp':
      return method === 'GET' ? get('readMcpDetails') : METHOD_NOT_ALLOWED;
    case '/api/details/skills':
      return method === 'GET' ? get('readSkillsDetails') : METHOD_NOT_ALLOWED;
    case '/api/details/roles':
      return method === 'GET' ? get('readRolesDetails') : METHOD_NOT_ALLOWED;
    case '/api/details/plugins':
      return method === 'GET' ? get('readPluginsDetails') : METHOD_NOT_ALLOWED;
    case '/api/details/sessions':
      return method === 'GET' ? get('readSessionsDetails') : METHOD_NOT_ALLOWED;

    case '/api/files/mcp':
    case '/api/files/skill':
    case '/api/files/role':
      return resolveFileCall(url.pathname, method, body, get);

    default:
      return NOT_FOUND;
  }
}

/** role / skill / mcp 三个文件接口的形状一致：POST 新建、PUT 保存、DELETE 删除 */
function resolveFileCall(
  pathname: string,
  method: string,
  body: Record<string, unknown>,
  get: (action: ConfigWebActionName, input?: Record<string, unknown>) => ApiCall,
): ApiCall | typeof METHOD_NOT_ALLOWED {
  const kind = pathname.slice('/api/files/'.length);
  const names = {
    role: { read: 'readRolesDetails', create: 'createRole', write: 'writeRole', remove: 'deleteRole' },
    skill: { read: 'readSkillsDetails', create: 'createSkill', write: 'writeSkill', remove: 'deleteSkill' },
    mcp: { read: 'readMcpDetails', create: 'createMcpServer', write: 'writeMcpServer', remove: 'deleteMcpServer' },
  }[kind] as
    | { read: ConfigWebActionName; create: ConfigWebActionName; write: ConfigWebActionName; remove: ConfigWebActionName }
    | undefined;
  if (!names) return METHOD_NOT_ALLOWED;

  if (method === 'POST') return get(names.create, { name: body.name, content: body.content ?? '' });
  if (method === 'PUT') return get(names.write, { name: body.name, content: body.content });
  if (method === 'DELETE') return get(names.remove, { name: body.name });
  return METHOD_NOT_ALLOWED;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const parsed = await request.json().catch(() => null);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
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

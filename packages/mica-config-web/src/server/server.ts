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
  writeSkill,
} from './details.js';
import {
  clearConversation,
  ConversationMessageError,
  createConversation,
  createConversationFolder,
  deleteConversation,
  deleteConversationFolder,
  getConversationWorkspace,
  patchConversation,
  patchConversationFolder,
  sendConversationMessage,
} from './conversationWorkspace.js';
import { serveGeneratedStaticAsset } from './staticAssets.js';
import { writeConfigWebState } from './singleton.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigWebConversationDetails, ConfigWebConversationStreamEvent } from '../shared/types.js';

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
  let clients = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let conversation: ConfigWebConversationDetails | null = null;

  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };

  const scheduleIdleExit = () => {
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
    port: preferredPort ?? DEFAULT_PORT,
    async fetch(request: Request, server: Bun.Server<unknown>) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        return handleApiRequest(request, server, url, clients, {
          get: () => conversation,
          set: (next) => {
            conversation = next;
            broadcastWebSocketEvent(server, 'conversation.updated');
          },
        });
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

  const state = { pid: process.pid, port: webPort };
  writeConfigWebState(state);
  scheduleIdleExit();

  return {
    port: webPort,
    url: `http://127.0.0.1:${webPort}`,
    stop() {
      clearIdleTimer();
      webServer.stop(true);
    },
  };
}

async function startDevConfigWebServer(
  preferredPort: number | undefined,
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
      return handleApiRequest(request, server, url, getClients(), {
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
    configFile: resolve(root, 'vite.config.ts'),
    server: {
      host: '127.0.0.1',
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
  writeConfigWebState({ pid: process.pid, port: webPort });
  scheduleIdleExit();

  return {
    port: webPort,
    url: `http://127.0.0.1:${webPort}`,
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
  conversation: {
    get(): ConfigWebConversationDetails | null;
    set(details: ConfigWebConversationDetails): void;
  },
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

  if (url.pathname === '/api/conversation/workspace') {
    if (request.method === 'GET') return json(getConversationWorkspace());
    return json({ error: 'Method not allowed' }, 405);
  }

  if (url.pathname === '/api/conversation') {
    try {
      if (request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        return json(createConversation({
          title: typeof body.title === 'string' ? body.title : undefined,
          folderId: 'folderId' in body ? (body.folderId as string | null) : undefined,
          providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          effort: typeof body.effort === 'string' ? body.effort : undefined,
          role: typeof body.role === 'string' ? body.role : undefined,
        }));
      }
      if (request.method === 'PUT') {
        const body = (await request.json()) as Record<string, unknown>;
        if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
        return json(patchConversation({
          id: body.id,
          title: typeof body.title === 'string' ? body.title : undefined,
          folderId: 'folderId' in body ? (body.folderId as string | null) : undefined,
          pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
          providerId: typeof body.providerId === 'string' ? body.providerId : undefined,
          model: typeof body.model === 'string' ? body.model : undefined,
          effort: typeof body.effort === 'string' ? body.effort : undefined,
          role: typeof body.role === 'string' ? body.role : undefined,
        }));
      }
      if (request.method === 'DELETE') {
        const body = (await request.json()) as { id?: unknown };
        if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
        return json(deleteConversation(body.id));
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

  if (url.pathname === '/api/conversation/clear') {
    try {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const body = (await request.json()) as { id?: unknown };
      if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
      return json(clearConversation(body.id));
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

  if (url.pathname === '/api/conversation/send') {
    try {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const body = (await request.json()) as { id?: unknown; content?: unknown };
      if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
      if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
      return json(await sendConversationMessage({ id: body.id, content: body.content }));
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

  if (url.pathname === '/api/conversation/send-stream') {
    try {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const body = (await request.json()) as { id?: unknown; content?: unknown };
      if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
      if (typeof body.content !== 'string') return json({ error: 'content must be string' }, 400);
      return streamConversationMessage(request, body.id, body.content);
    } catch (error) {
      return json({ error: formatError(error) }, 400);
    }
  }

  if (url.pathname === '/api/conversation/folder') {
    try {
      if (request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { name?: unknown };
        return json(createConversationFolder({
          name: typeof body.name === 'string' ? body.name : undefined,
        }));
      }
      if (request.method === 'PUT') {
        const body = (await request.json()) as { id?: unknown; name?: unknown; collapsed?: unknown };
        if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
        return json(patchConversationFolder({
          id: body.id,
          name: typeof body.name === 'string' ? body.name : undefined,
          collapsed: typeof body.collapsed === 'boolean' ? body.collapsed : undefined,
        }));
      }
      if (request.method === 'DELETE') {
        const body = (await request.json()) as { id?: unknown };
        if (typeof body.id !== 'string' || !body.id.trim()) return json({ error: 'id is required' }, 400);
        return json(deleteConversationFolder(body.id));
      }
      return json({ error: 'Method not allowed' }, 405);
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function streamConversationMessage(request: Request, id: string, content: string): Response {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: ConfigWebConversationStreamEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const fallbackCallIds = new Map<string, string[]>();
      const onRequestAbort = () => abortController.abort();
      request.signal.addEventListener('abort', onRequestAbort, { once: true });

      void sendConversationMessage(
        { id, content },
        {
          signal: abortController.signal,
          onThinking: (delta) => emit({ type: 'thinking_delta', content: delta }),
          onText: (delta) => emit({ type: 'text_delta', content: delta }),
          onToolCall: (toolName, args, callId) => {
            const resolvedCallId = callId ?? crypto.randomUUID();
            if (!callId) {
              const queued = fallbackCallIds.get(toolName) ?? [];
              queued.push(resolvedCallId);
              fallbackCallIds.set(toolName, queued);
            }
            emit({ type: 'tool_call', callId: resolvedCallId, toolName, arguments: args });
          },
          onToolResult: (toolName, result, callId) => {
            const queued = fallbackCallIds.get(toolName);
            const resolvedCallId = callId ?? queued?.shift() ?? '';
            emit({ type: 'tool_result', callId: resolvedCallId, toolName, content: result });
          },
        },
      )
        .then((session) => emit({ type: 'done', session }))
        .catch((error) =>
          emit(
            error instanceof ConversationMessageError
              ? {
                  type: 'error',
                  message: error.message,
                  session: error.session,
                  inputCommitted: error.inputCommitted,
                }
              : { type: 'error', message: formatError(error) },
          ),
        )
        .finally(() => {
          request.signal.removeEventListener('abort', onRequestAbort);
          if (!closed) controller.close();
          closed = true;
        });
    },
    cancel() {
      closed = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-content-type-options': 'nosniff',
    },
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

import { fromMicaCookie, toMicaPayload, type SyncCookie } from './cookies.js';

/**
 * 受控浏览器的 HTTP 客户端。
 *
 * 地址来自运行时注入的 `MICA_BROWSER_URL`（桌面端把主进程的浏览器服务代理到自己的端口上），
 * 端点目录在 `apps/desktop/src/main/browser/browser-docs.js`：读全量、批量写、批量删三个，
 * 是这次为「把登录态搬进/搬出这个浏览器」补上的那三个。
 */

export const MAX_COOKIES_PER_REQUEST = 500;

export class BrowserUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailable';
  }
}

export type BrowserResponse = { ok?: boolean; error?: string } & Record<string, unknown>;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type MicaBrowserClient = {
  readonly available: boolean;
  listAll(options?: { limit?: number }): Promise<{ cookies: SyncCookie[]; total: number; truncated: boolean }>;
  setCookies(cookies: SyncCookie[]): Promise<number>;
  removeCookies(cookies: SyncCookie[]): Promise<number>;
};

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  };
}

async function request(
  base: string,
  path: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<BrowserResponse> {
  const response = await fetchImpl(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let parsed: BrowserResponse = {};
  try {
    parsed = text ? (JSON.parse(text) as BrowserResponse) : {};
  } catch {
    throw new BrowserUnavailable(`受控浏览器返回了非 JSON：${text.slice(0, 120)}`);
  }
  if (!response.ok || parsed.ok === false) {
    throw new BrowserUnavailable(parsed.error || `受控浏览器返回 ${response.status}`);
  }
  return parsed;
}

export function createMicaBrowserClient({
  baseUrl = process.env.MICA_BROWSER_URL || '',
  fetchImpl = globalThis.fetch as FetchLike,
  timeoutMs = 20_000
}: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {}): MicaBrowserClient {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const ready = Boolean(base);

  function requireBase(): string {
    if (!ready) {
      throw new BrowserUnavailable(
        '没有 MICA_BROWSER_URL：受控浏览器只有桌面端提供，请在桌面应用里打开这个面板'
      );
    }
    return base;
  }

  return {
    available: ready,

    async listAll({ limit = 20000 } = {}) {
      const base = requireBase();
      const query = new URLSearchParams({ limit: String(limit) });
      const body = await request(base, `/browser/cookies/all?${query}`, {}, fetchImpl, timeoutMs);
      const raw = Array.isArray(body.cookies) ? (body.cookies as Record<string, unknown>[]) : [];
      const cookies = raw
        .map((entry) => fromMicaCookie(entry))
        .filter((entry): entry is SyncCookie => entry !== null);
      return {
        cookies,
        total: Number(body.total ?? raw.length),
        truncated: Boolean(body.truncated)
      };
    },

    async setCookies(cookies) {
      const base = requireBase();
      let written = 0;
      for (const batch of chunk(cookies, MAX_COOKIES_PER_REQUEST)) {
        const body = await request(
          base,
          '/browser/cookies/set',
          jsonBody({ cookies: batch.map((cookie) => toMicaPayload(cookie)) }),
          fetchImpl,
          timeoutMs
        );
        written += Number(body.written ?? 0);
        const failed = Array.isArray(body.failed) ? body.failed : [];
        if (failed.length > 0) {
          throw new BrowserUnavailable(
            `写入受控浏览器失败：${JSON.stringify(failed.slice(0, 3))}`
          );
        }
      }
      return written;
    },

    async removeCookies(cookies) {
      const base = requireBase();
      let removed = 0;
      for (const batch of chunk(cookies, MAX_COOKIES_PER_REQUEST)) {
        const body = await request(
          base,
          '/browser/cookies/remove',
          jsonBody({ cookies: batch.map((cookie) => toMicaPayload(cookie)) }),
          fetchImpl,
          timeoutMs
        );
        removed += Number(body.removed ?? 0);
      }
      return removed;
    }
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

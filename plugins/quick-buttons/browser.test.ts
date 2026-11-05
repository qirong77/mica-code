import { describe, expect, it, vi } from 'vitest';
import { openInControlledBrowser, type FetchLike } from './browser.js';

const response = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(handler as FetchLike);
}

describe('openInControlledBrowser', () => {
  it('posts the address as a visible window owned by this session', async () => {
    const fetchImpl = fakeFetch(() => response(200, { ok: true, browser: { id: 'b1' } }));
    const result = await openInControlledBrowser({
      url: 'https://example.com/a',
      label: '需求单',
      owner: 'session-1',
      baseUrl: 'http://127.0.0.1:7321/',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7321/browser/browsers');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'x-mica-owner': 'session-1' });
    expect(JSON.parse(String(init?.body))).toEqual({
      url: 'https://example.com/a',
      label: '需求单',
      show: true,
    });
  });

  it('falls back to the injected environment when no address is passed', async () => {
    const before = { url: process.env.MICA_BROWSER_URL, owner: process.env.MICA_BROWSER_OWNER };
    process.env.MICA_BROWSER_URL = 'http://127.0.0.1:9999';
    process.env.MICA_BROWSER_OWNER = 'session-env';
    try {
      const fetchImpl = fakeFetch(() => response(200, { ok: true }));
      expect(await openInControlledBrowser({ url: 'https://a.com', fetchImpl })).toEqual({ ok: true });
      expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ 'x-mica-owner': 'session-env' });
    } finally {
      if (before.url === undefined) delete process.env.MICA_BROWSER_URL;
      else process.env.MICA_BROWSER_URL = before.url;
      if (before.owner === undefined) delete process.env.MICA_BROWSER_OWNER;
      else process.env.MICA_BROWSER_OWNER = before.owner;
    }
  });

  it('refuses to open a window nobody can find again', async () => {
    // 没有归属的窗口在顶栏没有入口，主进程会把它当成泄漏回收掉
    const fetchImpl = fakeFetch(() => response(200, { ok: true }));
    const result = await openInControlledBrowser({
      url: 'https://a.com',
      owner: ' ',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('归属');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports why the browser service said no', async () => {
    const rejected = await openInControlledBrowser({
      url: 'https://a.com',
      owner: 's',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: fakeFetch(() => response(400, { ok: false, error: 'url 不合法' })),
    });
    expect(rejected).toEqual({ ok: false, error: 'url 不合法' });

    const http = await openInControlledBrowser({
      url: 'https://a.com',
      owner: 's',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: fakeFetch(() => response(500, {})),
    });
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.error).toContain('500');
  });

  it('does not throw when the request itself fails', async () => {
    const result = await openInControlledBrowser({
      url: 'https://a.com',
      owner: 's',
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: fakeFetch(() => {
        throw new Error('connect ECONNREFUSED');
      }),
    });
    expect(result).toEqual({ ok: false, error: 'connect ECONNREFUSED' });
  });

  it('says the host has no controlled browser at all', async () => {
    const result = await openInControlledBrowser({ url: 'https://a.com', owner: 's', baseUrl: ' ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('受控浏览器');
  });
});

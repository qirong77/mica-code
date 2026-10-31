import { afterEach, describe, expect, it, vi } from 'vitest';
import { LRUCache } from 'lru-cache';
import { WebSearchTool, type WebSearchOptions } from './WebSearchTool.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  WebSearchTool.clearCache();
});

function createTool(overrides: Partial<WebSearchOptions> = {}) {
  return new WebSearchTool({
    baseUrl: overrides.baseUrl ?? 'http://searx.local:8080',
    defaultCount: overrides.defaultCount ?? 5,
    ...overrides,
  });
}

describe('WebSearchTool', () => {
  it('is a read-only tool', () => {
    expect(createTool().readOnly).toBe(true);
  });

  it('queries the SearXNG json endpoint and maps results', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse({
        results: [
          { title: 'A', url: 'https://a.example', content: 'snippet a' },
          { title: 'B', url: 'https://b.example', content: 'snippet b' },
          { title: 'C', url: 'https://c.example', content: 'snippet c' },
        ],
        answers: ['42'],
        infoboxes: [{ infobox: 'SearXNG', content: 'metasearch engine', id: 'https://example.org/x' }],
        suggestions: ['related one', 'related two'],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const output = await createTool().execute({ query: 'hello world', count: 2 });

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://searx.local:8080/search?q=hello+world&format=json');
    expect(output).toContain('2 results via SearXNG');
    expect(output).toContain('https://a.example');
    expect(output).toContain('snippet b');
    expect(output).not.toContain('https://c.example');
    expect(output).toContain('Answers: 42');
    expect(output).toContain('metasearch engine');
    expect(output).toContain('related one');
  });

  it('uses the configured default count when the model does not pass one', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      jsonResponse({
        results: [
          { title: 'A', url: 'https://a.example', content: 'a' },
          { title: 'B', url: 'https://b.example', content: 'b' },
          { title: 'C', url: 'https://c.example', content: 'c' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const output = await createTool({ defaultCount: 2 }).execute({ query: 'q' });

    expect(output).toContain('2 results via SearXNG');
    expect(output).not.toContain('https://c.example');
  });

  it('explains how to enable json output when the instance returns 403', async () => {
    const onFailure = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403, statusText: 'Forbidden' })),
    );

    await expect(createTool({ onFailure }).execute({ query: 'q' })).rejects.toThrow(/search\.formats/);
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('403'), expect.stringContaining('settings.yml'));
  });

  it('reports an unreachable instance together with the configured address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    await expect(createTool({ baseUrl: 'http://searx.local:9999' }).execute({ query: 'q' })).rejects.toThrow(
      /无法连接 SearXNG（http:\/\/searx\.local:9999）/,
    );
  });

  it('surfaces non-403 http failures as-is', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' })),
    );

    await expect(createTool().execute({ query: 'q' })).rejects.toThrow('SearXNG HTTP 502 Bad Gateway');
  });

  it('aborts an active request without reporting a service failure', async () => {
    const controller = new AbortController();
    const onFailure = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
          }),
      ),
    );

    const request = createTool({ onFailure }).execute({ query: 'q' }, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('does not fetch or return cached results after the caller has aborted', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ title: 'A' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = createTool();
    await tool.execute({ query: 'q' });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ query: 'q' }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['<html>login</html>', 'null', '{"results":{}}'])('reports invalid JSON results: %s', async (body) => {
    const onFailure = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    await expect(createTool({ onFailure }).execute({ query: 'q' })).rejects.toThrow('SearXNG 返回内容不可读');
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('不可读'), expect.stringContaining('JSON'));
  });

  it('keeps answers and suggestions when serving a cached result', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [], answers: ['42'], suggestions: ['next'] }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = createTool();
    await tool.execute({ query: 'q' });
    const cached = await tool.execute({ query: 'q' });
    expect(cached).toContain('via cache');
    expect(cached).toContain('Answers: 42');
    expect(cached).toContain('Related queries: next');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels an oversized streaming response before retaining it in the cache', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
              },
              cancel,
            }),
          ),
      ),
    );
    await expect(createTool().execute({ query: 'large' })).rejects.toThrow('超过');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a response that stalls after its headers when the caller stops', async () => {
    const cancel = vi.fn();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull() {
                ready();
              },
              cancel,
            }),
          ),
      ),
    );
    const controller = new AbortController();
    const onFailure = vi.fn();
    const request = createTool({ onFailure }).execute({ query: 'stall' }, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('bounds the retained cache size under many large independent searches', async () => {
    const set = vi.spyOn(LRUCache.prototype, 'set');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          results: [{ title: 'large', content: 'x'.repeat(80_000) }],
        }),
      ),
    );
    const tool = createTool();
    for (let index = 0; index < 100; index++) await tool.execute({ query: `large-${index}` });
    const cache = set.mock.instances[0]!;
    expect(cache.maxSize).toBeGreaterThan(0);
    expect(cache.calculatedSize).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(cache.size).toBeLessThan(100);
  });

  it('uses changed settings on the next call and isolates the old cache', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ results: [{ title: 'A' }, { title: 'B' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const values = { baseUrl: 'http://old.local', defaultCount: 1 };
    const onSuccess = vi.fn();
    const tool = createTool({ getOptions: () => values, onSuccess });
    expect(await tool.execute({ query: 'q' })).toContain('1 results');
    values.baseUrl = 'http://new.local';
    values.defaultCount = 2;
    expect(await tool.execute({ query: 'q' })).toContain('2 results');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://old.local/search?q=q&format=json',
      'http://new.local/search?q=q&format=json',
    ]);
    expect(onSuccess).toHaveBeenLastCalledWith('http://new.local');
  });
});

it('times out a response stalled after headers, reports the failure, and allows a fresh retry', async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const cancel = vi.fn();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ pull: ready, cancel })));
  vi.stubGlobal('fetch', fetcher);
  const onFailure = vi.fn();
  const tool = createTool({ onFailure });
  const request = tool.execute({ query: 'deadline' });
  await started;
  deadline.abort(new DOMException('search deadline exceeded', 'TimeoutError'));
  await expect(request).rejects.toThrow('deadline');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(onFailure).toHaveBeenCalledTimes(1);
  vi.mocked(AbortSignal.timeout).mockReturnValue(new AbortController().signal);
  fetcher.mockImplementation(async () => jsonResponse({ results: [{ title: 'recovered' }] }));
  expect(await tool.execute({ query: 'deadline' })).toContain('recovered');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSearchTool } from './WebSearchTool.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  WebSearchTool.clearCache();
});

function createTool(overrides: { baseUrl?: string; defaultCount?: number; onFailure?: () => void } = {}) {
  return new WebSearchTool({
    baseUrl: overrides.baseUrl ?? 'http://searx.local:8080',
    defaultCount: overrides.defaultCount ?? 5,
    onFailure: overrides.onFailure,
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
});

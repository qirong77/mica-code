import { afterEach, describe, expect, it, vi } from 'vitest';
import { getToolDefinitions, isToolReadOnly } from '../registry.js';
import { ToolWebSearch } from '../ToolWebSearch.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  ToolWebSearch.clearCache();
});

describe('ToolWebSearch', () => {
  it('is registered as a read-only builtin tool', () => {
    expect(getToolDefinitions().some((tool) => tool.name === 'web_search')).toBe(true);
    expect(isToolReadOnly('web_search')).toBe(true);
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

    const output = await new ToolWebSearch()._searchSearxng('hello world', 2, 'http://searx.local:8080');

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://searx.local:8080/search?q=hello+world&format=json');
    expect(output).toContain('2 results via SearXNG');
    expect(output).toContain('https://a.example');
    expect(output).toContain('snippet b');
    expect(output).not.toContain('https://c.example');
    expect(output).toContain('Answers: 42');
    expect(output).toContain('metasearch engine');
    expect(output).toContain('related one');
  });

  it('explains how to enable json output when the instance returns 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403, statusText: 'Forbidden' })));

    await expect(new ToolWebSearch()._searchSearxng('q', 5, 'http://searx.local')).rejects.toThrow(
      /search\.formats/,
    );
  });

  it('reports an unreachable instance together with the configured address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    await expect(new ToolWebSearch()._searchSearxng('q', 5, 'http://searx.local:9999')).rejects.toThrow(
      /无法连接 SearXNG（http:\/\/searx\.local:9999）/,
    );
  });

  it('surfaces non-403 http failures as-is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' })));

    await expect(new ToolWebSearch()._searchSearxng('q', 5, 'http://searx.local')).rejects.toThrow(
      'SearXNG HTTP 502 Bad Gateway',
    );
  });
});

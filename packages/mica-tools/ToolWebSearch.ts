import { LRUCache } from 'lru-cache';
import { micaConfig } from '@packages/mica-config/index.js';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { finalizeTextOutput } from './utils/outputLimits.js';

// 自托管 SearXNG 实例，需要在 settings.yml 的 search.formats 中开启 json。
// https://docs.searxng.org/dev/search_api.html
const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8080';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 20;
const DEFAULT_COUNT = 5;
const MAX_OUTPUT_LENGTH = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

type SearchResult = {
  title: string;
  link: string;
  snippet: string;
};

type SearxngResponse = {
  results?: { title?: string; url?: string; content?: string }[];
  answers?: unknown[];
  infoboxes?: { infobox?: string; content?: string; id?: string }[];
  suggestions?: string[];
};

const resultCache = new LRUCache<string, SearchResult[]>({
  max: 500,
  ttl: CACHE_TTL_MS,
});

function resolveSearxngUrl(): string {
  const configured = micaConfig.get().searxngUrl || process.env.SEARXNG_URL || DEFAULT_SEARXNG_URL;
  return String(configured).trim().replace(/\/+$/, '');
}

function buildResponseText(engine: string, query: string, results: SearchResult[], extras: string[]): string {
  const lines: string[] = [`Search results for "${query}" (${results.length} results via ${engine}):`, ''];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.link}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  }

  if (extras.length > 0) {
    lines.push('--- 附加信息 ---');
    for (const e of extras) lines.push(e);
  }

  return finalizeTextOutput(lines.join('\n'), { maxChars: MAX_OUTPUT_LENGTH, label: '搜索结果' });
}

export class ToolWebSearch extends MicaTool {
  static clearCache(): void {
    resultCache.clear();
  }

  constructor() {
    super(
      'web_search',
      '搜索网络信息，返回结果标题、链接和摘要。用于查询最新信息、官方文档、API/模型/provider 行为、价格、版本、法规或任何可能变化的事实。先用 web_search 发现 URL，再用 web_fetch 获取完整内容。',
      {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '搜索查询' },
          count: { type: 'number', description: `返回结果数量（默认 ${DEFAULT_COUNT}，最大 ${MAX_RESULTS}）` },
        },
        required: ['query'],
      },
      { readOnly: true },
    );
  }

  async execute(input: Record<string, unknown>, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const query = String(input.query);
    const requestedCount = typeof input.count === 'number' ? input.count : DEFAULT_COUNT;
    const count = Math.min(Math.max(1, requestedCount), MAX_RESULTS);

    const cacheKey = `${query}:${count}`;
    const cached = resultCache.get(cacheKey);
    if (cached) {
      return buildResponseText('cache', query, cached.slice(0, count), []);
    }

    return await this._searchSearxng(query, count, resolveSearxngUrl());
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `search ${truncateDisplayText(input.query as string, 6)}`;
  }

  public async _searchSearxng(query: string, count: number, baseUrl: string): Promise<string> {
    const params = new URLSearchParams({ q: query, format: 'json' });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/search?${params.toString()}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法连接 SearXNG（${baseUrl}）：${reason}。请确认实例正在运行，并用 config.json 的 searxngUrl 或 SEARXNG_URL 指定地址。`,
      );
    }

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(
          `SearXNG（${baseUrl}）返回 403：该实例未开启 JSON 输出，请在 settings.yml 的 search.formats 中加入 json。`,
        );
      }
      throw new Error(`SearXNG HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SearxngResponse;
    const results: SearchResult[] = (data.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? '',
      link: r.url ?? '',
      snippet: r.content ?? '',
    }));

    const extras: string[] = [];
    if (data.answers?.length) {
      extras.push(`Answers: ${data.answers.map((a) => String(a)).join(' | ')}`);
    }
    for (const box of (data.infoboxes ?? []).slice(0, 2)) {
      if (box?.infobox) {
        extras.push(`Infobox: ${box.infobox} — ${box.content ?? ''}${box.id ? ` (${box.id})` : ''}`);
      }
    }
    if (data.suggestions?.length) {
      extras.push(`Related queries: ${data.suggestions.slice(0, 8).join(', ')}`);
    }

    if (results.length > 0) {
      resultCache.set(`${query}:${count}`, results);
    }

    return buildResponseText('SearXNG', query, results, extras);
  }
}

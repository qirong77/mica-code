import { LRUCache } from 'lru-cache';
import { micaConfig } from '@packages/mica-config/index.js';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { finalizeTextOutput } from './utils/outputLimits.js';
// https://serper.dev/dashboard
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 20;
const DEFAULT_COUNT = 5;
const MAX_OUTPUT_LENGTH = 30_000;

type SearchResult = {
  title: string;
  link: string;
  snippet: string;
};

type SerperResponse = {
  organic?: { title: string; link: string; snippet: string }[];
  answerBox?: { title?: string; answer?: string; snippet?: string; link?: string };
  knowledgeGraph?: { title?: string; type?: string; description?: string };
};

const resultCache = new LRUCache<string, SearchResult[]>({
  max: 500,
  ttl: CACHE_TTL_MS,
});

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

    const apiKey = micaConfig.get().serperApiKey || process.env.SERPER_API_KEY;
    if (!apiKey) {
      return '未配置 serperApiKey（配置文件 ~/.mica/config.json）或 SERPER_API_KEY 环境变量。';
    }

    return await this._searchSerper(query, count, apiKey);
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `search ${truncateDisplayText(input.query as string, 6)}`;
  }

  public async _searchSerper(query: string, count: number, apiKey: string): Promise<string> {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: count }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Serper HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SerperResponse;
    const results: SearchResult[] = (data.organic ?? []).slice(0, count).map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet ?? '',
    }));

    const extras: string[] = [];
    if (data.answerBox) {
      const a = data.answerBox;
      extras.push(`Answer box: ${a.title || a.answer || a.snippet || ''}`);
    }
    if (data.knowledgeGraph) {
      const k = data.knowledgeGraph;
      extras.push(`Knowledge graph: ${k.title} (${k.type}) — ${k.description || ''}`);
    }

    if (results.length > 0) {
      resultCache.set(`${query}:${count}`, results);
    }

    return buildResponseText('Serper', query, results, extras);
  }
}

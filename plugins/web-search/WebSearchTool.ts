import { LRUCache } from 'lru-cache';
import { MicaTool } from '@packages/mica-tools/index.js';
import type { ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { truncateDisplayText } from '@packages/mica-tools/utils/display.js';
import { finalizeTextOutput } from '@packages/mica-tools/utils/outputLimits.js';

/**
 * `web_search` 工具本体。
 *
 * 它只认构造时传进来的 `baseUrl`：地址来自插件设置（`ctx.settings`），内核不再持有
 * 「搜索服务在哪」这个知识。缓存是模块级的——同一个查询在一次会话里被反复问到时不必
 * 再打一次 SearXNG。
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 20;
const MAX_OUTPUT_LENGTH = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;

export type WebSearchOptions = {
  /** 解析好的 SearXNG 根地址（不带末尾斜杠）。 */
  baseUrl: string;
  /** 模型没有指定 count 时的条数。 */
  defaultCount: number;
  /** 请求失败时上报（插件用来写健康状态）；不阻塞搜索结果。 */
  onFailure?: (message: string, hint?: string) => void;
};

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

export class WebSearchTool extends MicaTool {
  private readonly options: WebSearchOptions;

  static clearCache(): void {
    resultCache.clear();
  }

  constructor(options: WebSearchOptions) {
    super(
      'web_search',
      '搜索网络信息，返回结果标题、链接和摘要。用于查询最新信息、官方文档、API/模型/provider 行为、价格、版本、法规或任何可能变化的事实。先用 web_search 发现 URL，再用 web_fetch 获取完整内容。',
      {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '搜索查询' },
          count: { type: 'number', description: `返回结果数量（默认 ${options.defaultCount}，最大 ${MAX_RESULTS}）` },
        },
        required: ['query'],
      },
      { readOnly: true },
    );
    this.options = options;
  }

  async execute(input: Record<string, unknown>, _callbacks?: ToolExecuteCallbacks): Promise<string> {
    const query = String(input.query);
    const defaultCount = Math.min(Math.max(1, this.options.defaultCount), MAX_RESULTS);
    const requestedCount = typeof input.count === 'number' ? input.count : defaultCount;
    const count = Math.min(Math.max(1, requestedCount), MAX_RESULTS);

    const cacheKey = `${this.options.baseUrl}|${query}:${count}`;
    const cached = resultCache.get(cacheKey);
    if (cached) return buildResponseText('cache', query, cached.slice(0, count), []);

    return await this.search(query, count, cacheKey);
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `Searching the web for "${truncateDisplayText(String(input.query ?? ''), 6)}"`;
  }

  private async search(query: string, count: number, cacheKey: string): Promise<string> {
    const { baseUrl } = this.options;
    const params = new URLSearchParams({ q: query, format: 'json' });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/search?${params.toString()}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fail(`连不上 SearXNG（${baseUrl}）：${reason}`, '确认实例在运行，或在插件设置里改地址。');
      throw new Error(
        `无法连接 SearXNG（${baseUrl}）：${reason}。请确认实例正在运行，并在 Web Search 插件设置里指定地址。`,
      );
    }

    if (!response.ok) {
      if (response.status === 403) {
        this.fail(
          `SearXNG（${baseUrl}）返回 403：实例未开启 JSON 输出`,
          '在实例的 settings.yml 的 search.formats 里加入 json 后重启。',
        );
        throw new Error(
          `SearXNG（${baseUrl}）返回 403：该实例未开启 JSON 输出，请在 settings.yml 的 search.formats 中加入 json。`,
        );
      }
      this.fail(`SearXNG 返回 HTTP ${response.status}`, '检查实例状态与地址是否正确。');
      throw new Error(`SearXNG HTTP ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SearxngResponse;
    const results: SearchResult[] = (data.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? '',
      link: r.url ?? '',
      snippet: r.content ?? '',
    }));

    const extras: string[] = [];
    if (data.answers?.length) extras.push(`Answers: ${data.answers.map((a) => String(a)).join(' | ')}`);
    for (const box of (data.infoboxes ?? []).slice(0, 2)) {
      if (box?.infobox) {
        extras.push(`Infobox: ${box.infobox} — ${box.content ?? ''}${box.id ? ` (${box.id})` : ''}`);
      }
    }
    if (data.suggestions?.length) extras.push(`Related queries: ${data.suggestions.slice(0, 8).join(', ')}`);

    if (results.length > 0) resultCache.set(cacheKey, results);
    return buildResponseText('SearXNG', query, results, extras);
  }

  private fail(message: string, hint?: string): void {
    this.options.onFailure?.(message, hint);
  }
}

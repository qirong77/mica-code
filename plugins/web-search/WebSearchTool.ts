import { LRUCache } from 'lru-cache';
import { MicaTool } from '@packages/mica-tools/index.js';
import type { ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { truncateDisplayText } from '@packages/mica-tools/utils/display.js';
import { finalizeTextOutput } from '@packages/mica-tools/utils/outputLimits.js';

/**
 * `web_search` 工具本体。
 *
 * 地址在调用时从插件设置读取，内核不再持有「搜索服务在哪」这个知识。
 * 缓存是模块级的——同一个查询在一次会话里被反复问到时不必
 * 再打一次 SearXNG。
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 20;
const MAX_OUTPUT_LENGTH = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type WebSearchOptions = {
  /** 解析好的 SearXNG 根地址（不带末尾斜杠）。 */
  baseUrl: string;
  /** 模型没有指定 count 时的条数。 */
  defaultCount: number;
  /** 常驻会话每次调用读取最新设置。 */
  getOptions?: () => Pick<WebSearchOptions, 'baseUrl' | 'defaultCount'>;
  /** 请求失败时上报（插件用来写健康状态）；不阻塞搜索结果。 */
  onFailure?: (message: string, hint?: string) => void;
  onSuccess?: (baseUrl: string) => void;
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

const resultCache = new LRUCache<string, { results: SearchResult[]; extras: string[] }>({
  max: 500,
  maxSize: 4 * 1024 * 1024,
  maxEntrySize: 256 * 1024,
  sizeCalculation: (value, key) => (JSON.stringify(value).length + key.length) * 2,
  ttl: CACHE_TTL_MS,
});

/** 在解码 JSON 前限制响应，取消也覆盖「收到响应头后不再吐正文」的情况。 */
async function readSearchResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('搜索响应超过 2 MiB，请减少返回内容');
  }
  if (!response.body) throw new Error('搜索响应为空');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('搜索响应超过 2 MiB，请减少返回内容');
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
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

  async execute(input: Record<string, unknown>, callbacks?: ToolExecuteCallbacks): Promise<string> {
    callbacks?.signal?.throwIfAborted();
    const query = String(input.query ?? '').trim();
    if (!query) throw new Error('搜索查询不能为空');
    const { baseUrl, defaultCount } = this.options.getOptions?.() ?? this.options;
    const requestedCount = typeof input.count === 'number' && Number.isFinite(input.count) ? input.count : defaultCount;
    const count = Math.min(Math.max(1, Math.round(Number.isFinite(requestedCount) ? requestedCount : 5)), MAX_RESULTS);

    const cacheKey = JSON.stringify([baseUrl, query, count]);
    const cached = resultCache.get(cacheKey);
    if (cached) return buildResponseText('cache', query, cached.results, cached.extras);

    const result = await this.search(baseUrl, query, count, cacheKey, callbacks?.signal);
    this.options.onSuccess?.(baseUrl);
    return result;
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `Searching the web for "${truncateDisplayText(String(input.query ?? ''), 6)}"`;
  }

  private async search(
    baseUrl: string,
    query: string,
    count: number,
    cacheKey: string,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const params = new URLSearchParams({ q: query, format: 'json' });
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/search?${params.toString()}`, {
        signal,
      });
    } catch (error) {
      callerSignal?.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      this.fail(`连不上 SearXNG（${baseUrl}）：${reason}`, '确认实例在运行，或在插件设置里改地址。');
      throw new Error(
        `无法连接 SearXNG（${baseUrl}）：${reason}。请确认实例正在运行，并在 Web Search 插件设置里指定地址。`,
      );
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
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

    let data: SearxngResponse;
    try {
      data = (await readSearchResponse(response, signal)) as SearxngResponse;
      callerSignal?.throwIfAborted();
      if (
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        ['results', 'answers', 'infoboxes', 'suggestions'].some((key) => {
          const value = (data as Record<string, unknown>)[key];
          return value !== undefined && !Array.isArray(value);
        })
      )
        throw new Error('返回内容不是搜索结果对象');
    } catch (error) {
      callerSignal?.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      this.fail(`SearXNG 返回内容不可读：${reason}`, '确认地址指向 SearXNG，且实例已开启 JSON 输出。');
      throw new Error(`SearXNG 返回内容不可读：${reason}`);
    }
    const results: SearchResult[] = (data.results ?? [])
      .filter((r) => r && typeof r === 'object')
      .slice(0, count)
      .map((r) => ({
        title: String(r.title ?? ''),
        link: String(r.url ?? ''),
        snippet: String(r.content ?? ''),
      }));

    const extras: string[] = [];
    if (data.answers?.length) extras.push(`Answers: ${data.answers.map((a) => String(a)).join(' | ')}`);
    for (const box of (data.infoboxes ?? []).slice(0, 2)) {
      if (box?.infobox) {
        extras.push(`Infobox: ${box.infobox} — ${box.content ?? ''}${box.id ? ` (${box.id})` : ''}`);
      }
    }
    if (data.suggestions?.length) extras.push(`Related queries: ${data.suggestions.slice(0, 8).join(', ')}`);

    resultCache.set(cacheKey, { results, extras });
    return buildResponseText('SearXNG', query, results, extras);
  }

  private fail(message: string, hint?: string): void {
    this.options.onFailure?.(message, hint);
  }
}

import { LRUCache } from 'lru-cache';
import TurndownService from 'turndown';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber, formatSize, truncateMiddle } from './utils/outputLimits.js';

const MAX_URL_LENGTH = 2000;
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const DEFAULT_MAX_CHARS = 30_000;
const HARD_MAX_CHARS = 100_000;
const QUERY_CONTEXT_CHARS = 1_500;

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

type CacheEntry = {
  bytes: number;
  code: number;
  codeText: string;
  content: string;
  contentType: string;
  finalUrl: string;
};

const urlCache = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
});

function isRedirectStatus(code: number): boolean {
  return [301, 302, 307, 308].includes(code);
}

function stripHtmlNoise(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/data:image\/[^;\s"']+;base64,[A-Za-z0-9+/=]+/g, '[base64 image omitted]');
}

function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function pickRelevantSections(content: string, query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  if (terms.length === 0) return content;

  const paragraphs = content.split(/\n{2,}/).filter(Boolean);
  const scored = paragraphs
    .map((paragraph, index) => {
      const lower = paragraph.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      return { paragraph, index, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .sort((a, b) => a.index - b.index);

  if (scored.length === 0) {
    return `未找到与 query 直接匹配的段落，返回页面开头部分。\n\n${content.slice(0, QUERY_CONTEXT_CHARS * 2)}`;
  }

  return scored.map((item) => item.paragraph).join('\n\n---\n\n');
}

function buildResponseText(params: {
  status: number;
  statusText: string;
  content: string;
  bytes: number;
  url: string;
  finalUrl: string;
  durationMs: number;
  prompt: string;
  query: string;
  maxChars: number;
  originalChars: number;
}): string {
  const header = [
    `HTTP ${params.status} ${params.statusText}`,
    `URL: ${params.url}`,
    params.finalUrl !== params.url ? `最终 URL: ${params.finalUrl}` : undefined,
    `下载大小: ${formatSize(params.bytes)}`,
    `内容字符数: ${params.originalChars}`,
    `返回上限: ${params.maxChars} 字符`,
    `耗时: ${(params.durationMs / 1000).toFixed(1)}s`,
    params.query ? `Query: ${params.query}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  const body = `${header}\n\n--- 内容 ---\n${params.content}`;
  if (params.prompt) {
    return `${body}\n\n--- 你的要求 ---\n${params.prompt}`;
  }
  return body;
}

let turndownService: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  }
  return turndownService;
}

export class ToolWebFetch extends MicaTool {
  constructor() {
    super('web_fetch', '抓取 URL 内容，HTML 自动转 Markdown 返回。', {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: '要抓取的 URL' },
        prompt: {
          type: 'string',
          description: '对内容的处理要求，会附加在内容后面交给模型（可选）',
        },
        query: {
          type: 'string',
          description: '只返回与该查询相关的页面片段，用于减少 token 消耗（可选）',
        },
        max_chars: {
          type: 'number',
          description: `最多返回字符数，默认 ${DEFAULT_MAX_CHARS}，最大 ${HARD_MAX_CHARS}`,
        },
      },
      required: ['url'],
    });
  }

  async execute(
    input: { url: string; prompt?: string; query?: string; max_chars?: number },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const { url, prompt = '', query = '' } = input;
    const maxChars = clampNumber(input.max_chars, DEFAULT_MAX_CHARS, 1_000, HARD_MAX_CHARS);
    this._validateUrl(url);

    const cached = urlCache.get(url);
    if (cached) {
      return this._formatCached(cached, url, prompt, query, maxChars);
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const onAbort = () => controller.abort();
    callbacks?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await this._fetchWithRedirects(url, controller.signal);
      clearTimeout(timeout);
      callbacks?.signal?.removeEventListener('abort', onAbort);

      if (result.type === 'redirect') {
        return `检测到跨域重定向。请用以下 URL 重新请求：\n原始: ${result.originalUrl}\n重定向: ${result.redirectUrl}`;
      }

      const { rawBuffer, status, statusText, contentType, finalUrl } = result;
      const bytes = rawBuffer.length;
      const content = this._extractContent(rawBuffer, contentType);

      urlCache.set(
        url,
        { bytes, code: status, codeText: statusText, content, contentType, finalUrl },
        { size: Math.max(1, Buffer.byteLength(content)) },
      );

      return this._formatCached(
        { bytes, code: status, codeText: statusText, content, contentType, finalUrl },
        url,
        prompt,
        query,
        maxChars,
        Date.now() - start,
      );
    } catch (error: any) {
      clearTimeout(timeout);
      callbacks?.signal?.removeEventListener('abort', onAbort);
      if (error.name === 'AbortError') {
        return `请求超时: ${url}`;
      }
      return `抓取失败: ${error.message}`;
    }
  }

  onToolUseDisplayText(input: Record<string, any>): string {
    return `fetch ${truncateDisplayText(input.url as string, 6)}`;
  }

  private _formatCached(
    entry: CacheEntry,
    url: string,
    prompt: string,
    query: string,
    maxChars: number,
    durationMs = 0,
  ): string {
    const focused = query ? pickRelevantSections(entry.content, query) : entry.content;
    const content = truncateMiddle(focused, maxChars, query ? '相关内容过大' : '网页内容过大');
    return buildResponseText({
      status: entry.code,
      statusText: entry.codeText,
      content,
      bytes: entry.bytes,
      url,
      finalUrl: entry.finalUrl,
      durationMs,
      prompt,
      query,
      maxChars,
      originalChars: focused.length,
    });
  }

  private _extractContent(rawBuffer: Buffer, contentType: string): string {
    if (contentType.includes('text/html')) {
      const html = stripHtmlNoise(rawBuffer.toString('utf-8'));
      return cleanText(getTurndown().turndown(html));
    }

    if (contentType.includes('application/json')) {
      const text = rawBuffer.toString('utf-8');
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return cleanText(text);
      }
    }

    if (!contentType.includes('text/') && contentType) {
      return `非文本响应 (${contentType})，未尝试解析为正文。`;
    }

    return cleanText(rawBuffer.toString('utf-8'));
  }

  private _validateUrl(url: string): void {
    if (url.length > MAX_URL_LENGTH) {
      throw new Error(`URL 超过 ${MAX_URL_LENGTH} 字符限制`);
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('无效 URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('只支持 http/https 协议');
    }

    if (parsed.username || parsed.password) {
      throw new Error('不允许在 URL 中包含用户名/密码');
    }

    if (parsed.hostname.split('.').length < 2) {
      throw new Error('无效域名');
    }
  }

  private async _fetchWithRedirects(
    url: string,
    signal: AbortSignal,
    depth = 0,
  ): Promise<
    | { type: 'redirect'; originalUrl: string; redirectUrl: string }
    | { type: 'content'; rawBuffer: Buffer; status: number; statusText: string; contentType: string; finalUrl: string }
  > {
    if (depth > MAX_REDIRECTS) {
      throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
    }

    let targetUrl = url;
    if (targetUrl.startsWith('http://')) {
      targetUrl = targetUrl.replace('http://', 'https://');
    }

    const response = await fetch(targetUrl, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'text/html,text/markdown,text/plain,application/json,*/*' },
    });

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向响应缺少 Location 头');

      const redirectUrl = new URL(location, targetUrl).toString();

      if (!this._isSameHost(url, redirectUrl)) {
        return { type: 'redirect', originalUrl: url, redirectUrl };
      }

      return this._fetchWithRedirects(redirectUrl, signal, depth + 1);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_CONTENT_LENGTH) {
      throw new Error(`内容大小超过 ${formatSize(MAX_CONTENT_LENGTH)} 限制`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_CONTENT_LENGTH) {
      throw new Error(`内容大小超过 ${formatSize(MAX_CONTENT_LENGTH)} 限制`);
    }

    return {
      type: 'content',
      rawBuffer: Buffer.from(arrayBuffer),
      status: response.status,
      statusText: response.statusText,
      contentType,
      finalUrl: targetUrl,
    };
  }

  private _isSameHost(a: string, b: string): boolean {
    try {
      const strip = (h: string) => h.replace(/^www\./, '');
      return strip(new URL(a).hostname) === strip(new URL(b).hostname);
    } catch {
      return false;
    }
  }
}

import { LRUCache } from 'lru-cache';
import TurndownService from 'turndown';
import { MicaTool, ToolExecuteCallbacks } from './MicaTool';

const MAX_URL_LENGTH = 2000;
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const MAX_MARKDOWN_LENGTH = 60_000;

const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

type CacheEntry = {
  bytes: number;
  code: number;
  codeText: string;
  content: string;
  contentType: string;
};

const urlCache = new LRUCache<string, CacheEntry>({
  maxSize: MAX_CACHE_SIZE_BYTES,
  ttl: CACHE_TTL_MS,
});

function isRedirectStatus(code: number): boolean {
  return [301, 302, 307, 308].includes(code);
}

function buildResponseText(
  status: number,
  statusText: string,
  content: string,
  bytes: number,
  url: string,
  durationMs: number,
  prompt: string,
): string {
  const header = [
    `HTTP ${status} ${statusText}`,
    `URL: ${url}`,
    `大小: ${bytes} 字节`,
    `耗时: ${(durationMs / 1000).toFixed(1)}s`,
  ].join('\n');

  if (prompt) {
    return `${header}\n\n--- 内容 ---\n${content}\n\n--- 你的要求 ---\n${prompt}`;
  }
  return `${header}\n\n${content}`;
}

let turndownService: TurndownService | null = null;
function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService();
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
      },
      required: ['url'],
    });
  }

  async execute(
    input: { url: string; prompt?: string },
    callbacks?: ToolExecuteCallbacks,
  ): Promise<string> {
    const { url, prompt = '' } = input;
    this._validateUrl(url);

    const cached = urlCache.get(url);
    if (cached) {
      return buildResponseText(
        cached.code,
        cached.codeText,
        cached.content,
        cached.bytes,
        url,
        0,
        prompt,
      );
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

      const { rawBuffer, status, statusText, contentType } = result;
      const bytes = rawBuffer.length;

      let content: string;
      if (contentType.includes('text/html')) {
        const html = rawBuffer.toString('utf-8');
        content = getTurndown().turndown(html);
      } else {
        content = rawBuffer.toString('utf-8');
      }

      if (content.length > MAX_MARKDOWN_LENGTH) {
        content = content.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[内容已截断]';
      }

      urlCache.set(url, { bytes, code: status, codeText: statusText, content, contentType }, {
        size: Math.max(1, Buffer.byteLength(content)),
      });

      return buildResponseText(
        status,
        statusText,
        content,
        bytes,
        url,
        Date.now() - start,
        prompt,
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
    return `fetch ${input.url}`;
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
    | { type: 'content'; rawBuffer: Buffer; status: number; statusText: string; contentType: string }
  > {
    if (depth > MAX_REDIRECTS) {
      throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
    }

    // Upgrade http to https
    let targetUrl = url;
    if (targetUrl.startsWith('http://')) {
      targetUrl = targetUrl.replace('http://', 'https://');
    }

    const response = await fetch(targetUrl, {
      signal,
      redirect: 'manual',
      headers: { 'Accept': 'text/html,text/markdown,text/plain,*/*' },
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
      throw new Error(`内容大小超过 ${MAX_CONTENT_LENGTH / 1024 / 1024}MB 限制`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_CONTENT_LENGTH) {
      throw new Error(`内容大小超过 ${MAX_CONTENT_LENGTH / 1024 / 1024}MB 限制`);
    }

    return {
      type: 'content',
      rawBuffer: Buffer.from(arrayBuffer),
      status: response.status,
      statusText: response.statusText,
      contentType,
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

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { prepareImageForApi } from '@packages/mica-common/index.js';
import { MicaTool, type ToolExecuteCallbacks } from './MicaTool.js';
import type { ToolResult } from './types.js';
import { truncateDisplayText } from './utils/display.js';
import { formatSize } from './utils/outputLimits.js';
import { getPathOwnershipContext } from './utils/pathOwnership.js';

const MAX_SOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 15_000;

type LoadedImage = {
  buffer: Buffer;
  resolvedSource: string;
};

export class ToolReadImage extends MicaTool {
  constructor() {
    super(
      'read_image',
      '读取本地图片路径或 HTTP/HTTPS 图片 URL，并将图片嵌入当前对话供模型直接查看。用户提供图片路径或链接时使用此工具。',
      {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: '本地图片路径（支持绝对路径、相对路径和 ~/）或 http/https 图片 URL',
          },
        },
        required: ['source'],
      },
      { readOnly: true },
    );
  }

  async execute(input: { source: string }, callbacks?: ToolExecuteCallbacks): Promise<ToolResult> {
    const source = input.source.trim();
    if (!source) throw new Error('图片路径或 URL 不能为空');
    throwIfAborted(callbacks?.signal);

    const loaded = isHttpUrl(source)
      ? await loadNetworkImage(source, callbacks?.signal)
      : await loadLocalImage(source, callbacks);
    throwIfAborted(callbacks?.signal);

    const processed = await prepareImageForApi(loaded.buffer);
    throwIfAborted(callbacks?.signal);
    const dimensions = processed.width && processed.height ? `${processed.width}x${processed.height}` : 'unknown';
    const sourceDescription =
      loaded.resolvedSource === source ? source : `${source} (resolved to ${loaded.resolvedSource})`;
    const summary = [
      `Image loaded from ${sourceDescription}`,
      `Format: ${processed.mediaType}`,
      `Dimensions: ${dimensions}`,
      `API payload size: ${formatSize(processed.buffer.length)} (original)`,
    ].join('\n');

    return [
      { type: 'text', text: summary },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: processed.mediaType,
          data: processed.buffer.toString('base64'),
        },
      },
    ];
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    return `read image ${truncateDisplayText(String(input.source ?? ''), 11)}`;
  }
}

async function loadLocalImage(source: string, callbacks?: ToolExecuteCallbacks): Promise<LoadedImage> {
  const ownership = getPathOwnershipContext(callbacks?.context);
  const cwd = ownership?.cwd ?? process.cwd();
  const expanded = source === '~' ? homedir() : source.startsWith('~/') ? resolve(homedir(), source.slice(2)) : source;
  const filePath = resolve(cwd, expanded);
  const stats = await stat(filePath);
  if (!stats.isFile()) throw new Error(`${filePath} 不是文件`);
  if (stats.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`图片大小超过 ${formatSize(MAX_SOURCE_IMAGE_BYTES)} 限制`);
  }
  const buffer = await readFile(filePath, { signal: callbacks?.signal });
  return { buffer, resolvedSource: filePath };
}

async function loadNetworkImage(source: string, externalSignal?: AbortSignal): Promise<LoadedImage> {
  const url = new URL(source);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的 URL 协议: ${url.protocol}`);
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`图片下载超过 ${NETWORK_TIMEOUT_MS / 1000} 秒`)),
    NETWORK_TIMEOUT_MS,
  );
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'image/jpeg,image/png,image/gif,image/webp,image/*;q=0.8' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') {
        throw new Error(`重定向到不支持的 URL 协议: ${finalUrl.protocol}`);
      }
    }
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error(`图片大小超过 ${formatSize(MAX_SOURCE_IMAGE_BYTES)} 限制`);
    }
    const buffer = await readBoundedResponse(response, MAX_SOURCE_IMAGE_BYTES);
    return { buffer, resolvedSource: response.url || source };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`图片大小超过 ${formatSize(maxBytes)} 限制`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function isHttpUrl(source: string): boolean {
  try {
    const url = new URL(source);
    if (url.protocol === 'http:' || url.protocol === 'https:') return true;
    if (/^[a-z][a-z\d+.-]*:/i.test(source)) throw new Error(`不支持的 URL 协议: ${url.protocol}`);
    return false;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('不支持的 URL 协议')) throw error;
    return false;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('图片读取已取消');
}

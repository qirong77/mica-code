import { micaAgent } from '@packages/mica-agent/index.js';
import type { ProviderDefinition, ProviderProtocol } from '@packages/mica-config/index.js';

/**
 * 起标题的那次模型请求。
 *
 * 走 `micaAgent.createSubAgent`，不经过当前会话：插件有自己的地址、key、协议和模型，
 * 与用户在用的 provider 完全无关，也不该把标题请求算进会话上下文。
 */
export type TitleRequestConfig = {
  baseUrl: string;
  apiKey: string;
  protocol: ProviderProtocol;
  model: string;
  prompt: string;
};

export type TitleRequestResult = {
  title: string;
  usage?: { promptTokens?: number; completionTokens?: number };
};

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TITLE_CHARS = 60;
/** 模型返回的「标题：xxx」「Title: xxx」这类前缀，剥掉。 */
const TITLE_PREFIX_PATTERN = /^\s*(?:标题|会话标题|title|session title)\s*[:：]\s*/i;

export function isTitleRequestConfigured(config: TitleRequestConfig): boolean {
  return Boolean(config.baseUrl.trim() && config.model.trim());
}

export function buildTitleProvider(config: TitleRequestConfig): ProviderDefinition {
  return {
    id: 'session-rename',
    name: 'Session Rename',
    api_base: config.baseUrl,
    api_key: config.apiKey,
    protocol: config.protocol,
    models: [config.model],
    // 起标题用不到推理参数，也不该因为模型名猜错而多发一段 reasoning 配置。
    supportsEffort: false,
  };
}

export async function requestSessionTitle(
  config: TitleRequestConfig,
  transcript: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TitleRequestResult> {
  const client = micaAgent.createSubAgent({
    model: config.model,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    provider: buildTitleProvider(config),
    effort: 'none',
    systemPrompt: config.prompt,
  });

  const raw = await withTimeout(client.query(transcript), options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);
  const usage = client.lastUsage as { promptTokens?: number; completionTokens?: number } | undefined;
  return { title: sanitizeTitle(raw), usage };
}

/**
 * 把模型返回的东西压成一个能当标题的字符串。
 *
 * 模型常常带解释、加引号、套代码块，或者直接给出两行；标题只要第一行正文。
 */
export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const withoutFences = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  const firstLine =
    withoutFences
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  const stripped = firstLine
    .replace(TITLE_PREFIX_PATTERN, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^[-*#>\s]+/, '')
    .replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, '')
    .replace(/[。．.]+$/, '')
    .trim();
  if (!stripped) return '';
  return stripped.length > MAX_TITLE_CHARS ? stripped.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…' : stripped;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error('aborted');
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`起标题超时（${timeoutMs}ms）`)), timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

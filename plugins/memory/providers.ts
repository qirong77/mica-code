/**
 * 整理器的独立 provider 客户端。
 *
 * 为什么不用宿主的模型客户端：整理记忆通常希望用更便宜的模型，或者干脆用另一家
 * 协议 / 另一个 key（宿主的 provider 配置属于主对话，不该被一个后台任务改）。所以
 * 这里只发一次「system + user → 文本」的请求，协议跟宿主一样支持 Chat Completions
 * 与 Responses，配置来自插件自己的设置。
 *
 * 没有工具、没有多轮、没有流式：整理器要的是一段确定的 JSON，任何额外能力都只会让
 * 失败面变大。
 */

export type CuratorProtocol = 'openai_chat_completions' | 'openai_responses';

export const CURATOR_PROTOCOLS: readonly CuratorProtocol[] = ['openai_chat_completions', 'openai_responses'] as const;

export type CuratorProviderConfig = {
  /** 例如 `https://api.openai.com/v1`；也接受直接写到端点的地址。 */
  baseUrl: string;
  apiKey: string;
  protocol: CuratorProtocol;
  model: string;
  timeoutMs?: number;
};

export type CuratorCompletionRequest = {
  system: string;
  user: string;
  signal?: AbortSignal;
};

export const DEFAULT_CURATOR_TIMEOUT_MS = 60_000;

export class CuratorProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CuratorProviderError';
  }
}

export async function requestCuratorCompletion(
  config: CuratorProviderConfig,
  request: CuratorCompletionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const endpoint = resolveEndpoint(config.baseUrl, config.protocol);
  const timeout = config.timeoutMs ?? DEFAULT_CURATOR_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(
        config.protocol === 'openai_responses'
          ? {
              model: config.model,
              instructions: request.system,
              input: request.user,
            }
          : {
              model: config.model,
              messages: [
                { role: 'system', content: request.system },
                { role: 'user', content: request.user },
              ],
              stream: false,
            },
      ),
      signal,
    });

    if (!response.ok) {
      const detail = await readErrorBody(response);
      throw new CuratorProviderError(
        `记忆整理请求失败：HTTP ${response.status}${detail ? ` · ${detail}` : ''}`,
        response.status,
      );
    }

    const data = (await response.json()) as unknown;
    const text = config.protocol === 'openai_responses' ? readResponsesText(data) : readChatText(data);
    if (!text.trim()) throw new CuratorProviderError('记忆整理请求返回了空内容');
    return text;
  } catch (error) {
    if (error instanceof CuratorProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new CuratorProviderError(
        request.signal?.aborted ? '记忆整理请求被取消' : `记忆整理请求超时（${Math.round(timeout / 1000)}s）`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CuratorProviderError(`记忆整理请求无法完成：${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function resolveEndpoint(baseUrl: string, protocol: CuratorProtocol): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) throw new CuratorProviderError('记忆整理 provider 未配置接口地址');
  const suffix = protocol === 'openai_responses' ? '/responses' : '/chat/completions';
  if (trimmed.endsWith(suffix)) return trimmed;
  return `${trimmed}${suffix}`;
}

function readChatText(data: unknown): string {
  const choices = readArray(readRecord(data)?.choices);
  const message = readRecord(readRecord(choices[0])?.message);
  return readText(message?.content);
}

function readResponsesText(data: unknown): string {
  const record = readRecord(data);
  const direct = typeof record?.output_text === 'string' ? record.output_text : '';
  if (direct.trim()) return direct;

  const parts: string[] = [];
  for (const item of readArray(record?.output)) {
    for (const content of readArray(readRecord(item)?.content)) {
      const text = readRecord(content)?.text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

function readText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      const text = readRecord(part)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    // 只留一小段：错误体偶尔会把整段请求回显出来（可能含用户内容）。
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return '';
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

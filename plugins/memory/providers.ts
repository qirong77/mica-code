import type { PluginModelsApi } from '@packages/mica-plugin/index.js';

/**
 * 整理器的模型请求。
 *
 * 整理记忆通常希望用更便宜的模型，或者干脆用另一家协议 / 另一个 key——这些都属于插件
 * 设置，不该改动主对话的 provider。所以请求只描述「用哪个地址/协议/模型、system 与
 * user 是什么」，发出去与用量记账都由宿主的 `ctx.models` 负责：这笔整理开销因此也会
 * 出现在会话的 Stats 里，而不是只活在插件日志里。
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
  models: PluginModelsApi,
  config: CuratorProviderConfig,
  request: CuratorCompletionRequest,
): Promise<string> {
  try {
    const result = await models.request({
      purpose: '整理记忆',
      system: request.system,
      user: request.user,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      protocol: config.protocol,
      timeoutMs: config.timeoutMs ?? DEFAULT_CURATOR_TIMEOUT_MS,
      signal: request.signal,
    });
    if (!result.text.trim()) throw new CuratorProviderError('记忆整理请求返回了空内容');
    return result.text;
  } catch (error) {
    if (error instanceof CuratorProviderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CuratorProviderError(`记忆整理请求无法完成：${message}`);
  }
}

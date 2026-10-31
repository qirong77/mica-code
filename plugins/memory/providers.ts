import type { PluginLlmApi } from '@packages/mica-plugin/index.js';

/**
 * 整理器的模型请求。
 *
 * 整理记忆通常希望用更便宜的模型，或者干脆用另一家协议 / 另一个 key——这些都属于插件
 * 设置，不该改动主对话的 provider。接口地址 / Key / 协议 / 模型来自清单的 `llm` 声明
 * （`ctx.llm`），发出去与用量记账也由宿主负责：这笔整理开销因此也会出现在会话的
 * Stats 里，而不是只活在插件日志里。
 *
 * 没有工具、没有多轮、没有流式：整理器要的是一段确定的 JSON，任何额外能力都只会让
 * 失败面变大。
 */

export type CuratorProtocol = 'openai_chat_completions' | 'openai_responses';

export type CuratorCompletionRequest = {
  system: string;
  user: string;
  signal?: AbortSignal;
  owner?: unknown;
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

export async function requestCuratorCompletion(llm: PluginLlmApi, request: CuratorCompletionRequest): Promise<string> {
  try {
    const result = await llm.request({
      purpose: '整理记忆',
      system: request.system,
      user: request.user,
      timeoutMs: DEFAULT_CURATOR_TIMEOUT_MS,
      signal: request.signal,
      ...(request.owner === undefined ? {} : { owner: request.owner }),
    });
    if (!result.text.trim()) throw new CuratorProviderError('记忆整理请求返回了空内容');
    return result.text;
  } catch (error) {
    if (error instanceof CuratorProviderError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CuratorProviderError(`记忆整理请求无法完成：${message}`);
  }
}

import { createSubAgent } from './providers/createModelClient.js';
import type { AgentUsageRecord, IAgent, ModelClientOptions } from './index.js';

/**
 * 「发一次 system + user，拿回一段文本」的唯一实现。
 *
 * 两个调用方共用它：
 *
 * - CLI 的 `createPluginModels`：插件自己问模型（起标题、写提交说明、整理记忆），
 *   请求结束把用量记进会话；
 * - 配置页的「测试连接」：同样的一次最小请求，只是不记账。
 *
 * 协议分支（Chat Completions / Responses）、endpoint 拼接、超时与中断因此不会出现
 * 「插件一条路、测试一条路」，测通了的配置就是插件真正会用的那条路。
 */

export type ModelTextClient = Pick<IAgent, 'query' | 'usageHistory'> & {
  lastUsage?: AgentUsageRecord;
};

export type ModelTextRequest = {
  baseUrl: string;
  apiKey?: string;
  protocol?: 'openai_chat_completions' | 'openai_responses';
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 测试注入点；默认用 `micaAgent.createSubAgent`。 */
  createClient?: (options: ModelClientOptions) => ModelTextClient;
};

export type ModelTextResult = {
  text: string;
  usage: AgentUsageRecord | undefined;
  /** 本次请求产生的全部用量记录（失败时可能已有部分）。 */
  usageHistory: AgentUsageRecord[];
};

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export async function runModelTextRequest(request: ModelTextRequest): Promise<ModelTextResult> {
  const baseUrl = request.baseUrl.trim();
  const model = request.model.trim();
  if (!baseUrl || !model) throw new Error('模型请求缺少接口地址或模型');

  const createClient = request.createClient ?? ((options: ModelClientOptions) => createSubAgent(options));
  const client = createClient({
    model,
    apiKey: request.apiKey ?? '',
    baseURL: baseUrl,
    provider: buildProvider(baseUrl, model, request),
    // 后台任务不该顺手发 reasoning 参数：模型名猜错会白花一笔 token。
    effort: 'none',
    systemPrompt: request.system,
  });

  const timeoutMs = clampModelTimeout(request.timeoutMs);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  else request.signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const text = await withTimeout(client.query(request.user, { signal: controller.signal }), timeoutMs, controller);
    return { text, usage: client.lastUsage, usageHistory: client.usageHistory.slice() };
  } catch (error) {
    // 失败的那一次也可能已经烧掉 token（超时的长回复、被中断的流）：把已产生的用量
    // 挂在错误上，调用方据此决定要不要记账，而不是丢掉整条记录。
    if (error && typeof error === 'object') {
      Object.assign(error, { usageHistory: client.usageHistory.slice() });
    }
    throw error;
  } finally {
    request.signal?.removeEventListener('abort', forwardAbort);
  }
}

function buildProvider(
  baseUrl: string,
  model: string,
  request: Pick<ModelTextRequest, 'apiKey' | 'protocol'>,
): {
  id: string;
  name: string;
  api_base: string;
  api_key: string;
  protocol: 'openai_chat_completions' | 'openai_responses';
  models: string[];
  supportsEffort: boolean;
} {
  return {
    id: 'plugin-helper',
    name: 'Plugin helper',
    api_base: baseUrl,
    api_key: request.apiKey ?? '',
    protocol: request.protocol ?? 'openai_chat_completions',
    models: [model],
    supportsEffort: false,
  };
}

export function clampModelTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Number(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/**
 * 超时必须真的中断请求：只 reject 的话，这个请求会继续跑到模型把 reasoning 吐完，
 * 白烧 token 还拖慢下一轮。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`模型请求超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

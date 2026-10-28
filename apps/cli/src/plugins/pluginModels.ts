import {
  buildSubagentUsageRecord,
  micaAgent,
  type AgentUsageRecord,
  type IAgent,
  type ModelClientOptions,
} from '@packages/mica-agent/index.js';
import type { ProviderDefinition } from '@packages/mica-config/index.js';
import type {
  PluginModelRequest,
  PluginModelResult,
  PluginModelsHandler,
  PluginModelUsage,
} from '@packages/mica-plugin/index.js';

/**
 * `ctx.models` 的宿主实现：替插件发一次「system + user → 文本」请求，并把用量记进
 * 当前会话。
 *
 * 为什么由宿主发，而不是让插件自己 fetch：
 *
 * - 记账只有宿主做得到。插件拿不到会话写面（`ctx.session` 只有 describe/messages/rename），
 *   自己请求的那一次开销就没人记，Stats 里永远缺这一块；
 * - 协议分支（Chat Completions / Responses）、endpoint 拼接、超时、中断只有一份实现，
 *   不会出现「commit 插件超时 60s、起标题插件超时 20s」这种各自漂移。
 *
 * `origin: 'plugin'` 的记录与委派子代理共用 `subagentUsageHistory`：两者都是本会话
 * 产生、但不进主上下文的开销，混进 `usageHistory` 会污染 ctx 与 lastUsage。
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

/** 插件请求结束后交给宿主的记账输入。 */
export type PluginModelUsageEntry = {
  pluginId: string;
  purpose: string;
  model: string;
  requests: AgentUsageRecord[];
  status: 'completed' | 'failed';
  startedAt: string;
  finishedAt: string;
};

export type PluginModelRecorder = (entry: PluginModelUsageEntry) => void;

/** 只实现用到的那几面：测试可以塞一个假客户端进来，不必真起 provider。 */
export type PluginModelClient = Pick<IAgent, 'query' | 'usageHistory'> & {
  lastUsage?: AgentUsageRecord;
};

export type CreatePluginModelsOptions = {
  /** 每次请求结束调用一次（成功/失败都调）：宿主据此把开销记进会话。 */
  record?: PluginModelRecorder;
  /** 测试注入点。 */
  createClient?: (options: ModelClientOptions) => PluginModelClient;
};

export function createPluginModels(options: CreatePluginModelsOptions = {}): PluginModelsHandler {
  const createClient = options.createClient ?? ((clientOptions: ModelClientOptions) => micaAgent.createSubAgent(clientOptions));

  return async (pluginId, request) => runPluginRequest({ pluginId, request, createClient, record: options.record });
}

async function runPluginRequest(input: {
  pluginId: string;
  request: PluginModelRequest;
  createClient: (options: ModelClientOptions) => PluginModelClient;
  record?: PluginModelRecorder;
}): Promise<PluginModelResult> {
  const { pluginId, request, createClient, record } = input;
  const baseUrl = request.baseUrl.trim();
  const model = request.model.trim();
  if (!baseUrl || !model) {
    throw new Error('插件的模型请求缺少接口地址或模型');
  }

  const client = createClient({
    model,
    apiKey: request.apiKey ?? '',
    baseURL: baseUrl,
    provider: buildProvider(pluginId, request, baseUrl, model),
    // 后台任务不该顺手发 reasoning 参数：模型名猜错会白花一笔 token。
    effort: 'none',
    systemPrompt: request.system,
  });

  const timeoutMs = clampTimeout(request.timeoutMs);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  else request.signal?.addEventListener('abort', forwardAbort, { once: true });

  const startedAt = new Date().toISOString();
  try {
    const text = await withTimeout(client.query(request.user, { signal: controller.signal }), timeoutMs, controller);
    record?.({
      pluginId,
      purpose: request.purpose,
      model,
      requests: client.usageHistory.slice(),
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    return { text, usage: toPluginUsage(client.lastUsage) };
  } catch (error) {
    // 失败的请求也可能已经产生了 provider 用量（例如超时的长回复）：有就记，没有就不写空记录。
    if (client.usageHistory.length > 0) {
      record?.({
        pluginId,
        purpose: request.purpose,
        model,
        requests: client.usageHistory.slice(),
        status: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    }
    throw error;
  } finally {
    request.signal?.removeEventListener('abort', forwardAbort);
  }
}

function buildProvider(
  pluginId: string,
  request: PluginModelRequest,
  baseUrl: string,
  model: string,
): ProviderDefinition {
  return {
    id: `plugin:${pluginId}`,
    name: `Plugin ${pluginId}`,
    api_base: baseUrl,
    api_key: request.apiKey ?? '',
    protocol: request.protocol ?? 'openai_chat_completions',
    models: [model],
    supportsEffort: false,
  };
}

function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Number(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function toPluginUsage(usage: AgentUsageRecord | undefined): PluginModelUsage | null {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

/**
 * 超时必须真的中断请求：只 reject 的话，这个请求会继续跑到模型把 reasoning 吐完，
 * 白烧 token 还拖慢下一轮。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`插件模型请求超时（${Math.round(timeoutMs / 1000)}s）`));
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

/** 记账目标：会话的 agent。命令上下文里可能没有（`mica commit`），那就只发请求不入账。 */
export type PluginUsageOwner = {
  recordSubagentUsage?(record: ReturnType<typeof buildSubagentUsageRecord>): void;
  readonly isRunning?: boolean;
};

/**
 * 把一次插件模型请求写进会话的 `subagentUsageHistory`。
 *
 * turn 正在跑时不要插一次保存：那一轮自己的 checkpoint 会带上刚追加的用量。turn
 * 之外（`turn:before` 的自动起标题、命令里手动触发）不会有别的保存时机，只留在内存里
 * 就等于没记，所以空闲时立刻落盘。
 */
export function recordPluginModelUsage(entry: PluginModelUsageEntry, owner: {
  agent?: PluginUsageOwner | null;
  save?: () => void;
}): void {
  const agent = owner.agent;
  if (!agent?.recordSubagentUsage || entry.requests.length === 0) return;
  agent.recordSubagentUsage(
    buildSubagentUsageRecord({
      taskId: `plugin:${entry.pluginId}:${entry.purpose}`,
      origin: 'plugin',
      pluginId: entry.pluginId,
      subagentType: `plugin:${entry.pluginId}`,
      description: entry.purpose,
      model: entry.model,
      status: entry.status,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      requests: entry.requests,
    }),
  );
  if (agent.isRunning !== true) owner.save?.();
}

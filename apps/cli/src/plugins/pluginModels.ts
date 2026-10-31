import {
  buildSubagentUsageRecord,
  runModelTextRequest,
  type AgentUsageRecord,
  type ModelClientOptions,
  type ModelTextClient,
} from '@packages/mica-agent/index.js';
import type { PluginModelRequest, PluginModelsHandler, PluginModelUsage } from '@packages/mica-plugin/index.js';
import { createPluginLogger } from '@packages/mica-plugin/PluginLog.js';
import type { SessionController } from '../session/SessionController.js';

/**
 * `ctx.models` 的宿主实现：替插件发一次「system + user → 文本」请求，并把用量记进
 * 当前会话。
 *
 * 为什么由宿主发，而不是让插件自己 fetch：
 *
 * - 记账只有宿主做得到。插件拿不到会话写面（`ctx.session` 只有 describe/messages/rename），
 *   自己请求的那一次开销就没人记，Stats 里永远缺这一块；
 * - 协议分支（Chat Completions / Responses）、endpoint 拼接、超时、中断只有一份实现
 *   （`mica-agent/modelText.ts`，配置页的「测试连接」用的是同一个），不会出现
 *   「commit 插件超时 60s、起标题插件超时 20s」这种各自漂移。
 *
 * `origin: 'plugin'` 的记录与委派子代理共用 `subagentUsageHistory`：两者都是本会话
 * 产生、但不进主上下文的开销，混进 `usageHistory` 会污染 ctx 与 lastUsage。
 */

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

/** 主配置的接口信息：插件声明「跟随主配置」时由宿主解析出来。 */
export type MainProviderConfig = {
  baseUrl: string;
  apiKey: string;
  protocol?: PluginModelRequest['protocol'];
  model: string;
};

export type CreatePluginModelsOptions = {
  /** 每次请求结束调用一次（成功/失败都调）：宿主据此把开销记进会话。 */
  record?: PluginModelRecorder;
  /** 在发起请求时绑定记账目标，防止后台请求结束前切换会话导致串账。 */
  captureRecorder?: (owner?: unknown) => PluginModelRecorder | undefined;
  /**
   * 「跟随主配置」的解析入口。缺省时这种请求直接报错，而不是悄悄发到一个猜出来的地址。
   * 传函数而不是快照：会话可能在运行中被切到别的 provider。参数是插件点名的模型
   * （`cheap/xxx` 这类前缀决定该由哪个 provider 服务），没有就用会话当前的。
   */
  resolveMainProvider?: (model?: string, owner?: unknown) => MainProviderConfig;
  /** 测试注入点。 */
  createClient?: (options: ModelClientOptions) => ModelTextClient;
};

export function createPluginModels(options: CreatePluginModelsOptions = {}): PluginModelsHandler {
  return async (pluginId, request) => {
    const resolved = applyMainProvider(request, options.resolveMainProvider);
    const model = resolved.model.trim();
    const startedAt = new Date().toISOString();
    const record = options.captureRecorder?.(request.owner) ?? options.record;
    try {
      const result = await runModelTextRequest({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        protocol: resolved.protocol,
        model,
        system: request.system,
        user: request.user,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        createClient: options.createClient,
      });
      safelyRecord(record, {
        pluginId,
        purpose: request.purpose,
        model,
        requests: result.usageHistory,
        status: 'completed',
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return { text: result.text, usage: toPluginUsage(result.usage) };
    } catch (error) {
      // 失败的请求也可能已经产生了 provider 用量（例如超时的长回复）：有就记，
      // 没有就不写空记录。
      const requests = usageHistoryOf(error);
      if (requests.length > 0) {
        safelyRecord(record, {
          pluginId,
          purpose: request.purpose,
          model,
          requests,
          status: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
      throw error;
    }
  };
}

/**
 * 「跟随主配置」时把地址 / Key / 协议 / 模型补齐。
 *
 * 插件不掌握 provider 配置（这是边界），所以这一步只能在宿主做：会话切到别的 provider
 * 之后，同一个插件请求跟着走，插件自己不需要知道。
 */
function applyMainProvider(
  request: PluginModelRequest,
  resolve: CreatePluginModelsOptions['resolveMainProvider'],
): { baseUrl: string; apiKey: string; protocol: PluginModelRequest['protocol']; model: string } {
  if (!request.useMainProvider) {
    return { baseUrl: request.baseUrl, apiKey: request.apiKey ?? '', protocol: request.protocol, model: request.model };
  }
  const requested = request.model.trim();
  const main = resolve?.(requested || undefined, request.owner);
  if (!main) throw new Error('插件请求要求跟随主配置，但宿主没有提供主配置');
  return {
    baseUrl: main.baseUrl,
    apiKey: main.apiKey,
    // 协议也归主配置：插件自己那四项在「跟随」时整体不生效，混用会出现
    // 「地址是 Responses 的、协议按 Chat Completions 拼端点」这种 404。
    protocol: main.protocol,
    // 插件点名了模型就用它的，否则用主配置当前的模型。
    model: requested || main.model,
  };
}

function safelyRecord(record: PluginModelRecorder | undefined, entry: PluginModelUsageEntry): void {
  try {
    record?.(entry);
  } catch (error) {
    // Recording is local. A recording failure must not resend an already paid
    // request through the provider fallback or replace its original error.
    try {
      createPluginLogger(entry.pluginId).error('plugin:model-usage-save-failed', {
        purpose: entry.purpose,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch { /* A failing disk cannot alter the completed model result. */ }
  }
}

function usageHistoryOf(error: unknown): AgentUsageRecord[] {
  const history = (error as { usageHistory?: unknown }).usageHistory;
  return Array.isArray(history) ? (history as AgentUsageRecord[]) : [];
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

/** 记账目标：会话的 agent。命令上下文里可能没有（`mica commit`），那就只发请求不入账。 */
export type PluginUsageOwner = {
  recordSubagentUsage?(record: ReturnType<typeof buildSubagentUsageRecord>): void;
  readonly isRunning?: boolean;
};

/** 每次请求开始时捕获会话 id；同一个 agent/controller 可以在等待期间 resume 别的会话。 */
export function capturePluginModelUsageRecorder(
  controller: Pick<SessionController, 'getCurrentSessionId' | 'recordSubagentUsageForSession'>,
): PluginModelRecorder {
  const sessionId = controller.getCurrentSessionId();
  return (entry) => {
    if (entry.requests.length > 0) {
      controller.recordSubagentUsageForSession(sessionId, pluginUsageRecord(entry));
    }
  };
}

/**
 * 把一次插件模型请求写进会话的 `subagentUsageHistory`。
 *
 * turn 正在跑时不要插一次保存：那一轮自己的 checkpoint 会带上刚追加的用量。turn
 * 之外（`turn:before` 的自动起标题、命令里手动触发）不会有别的保存时机，只留在内存里
 * 就等于没记，所以空闲时立刻落盘。
 */
export function recordPluginModelUsage(
  entry: PluginModelUsageEntry,
  owner: {
    agent?: PluginUsageOwner | null;
    save?: () => void;
  },
): void {
  const agent = owner.agent;
  if (!agent?.recordSubagentUsage || entry.requests.length === 0) return;
  agent.recordSubagentUsage(pluginUsageRecord(entry));
  if (!agent.isRunning) owner.save?.();
}

function pluginUsageRecord(entry: PluginModelUsageEntry): ReturnType<typeof buildSubagentUsageRecord> {
  return buildSubagentUsageRecord({
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
  });
}

/** 测试注入用：替身只需实现 query 与 usageHistory。 */
export type PluginModelClient = ModelTextClient;

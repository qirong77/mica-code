import { wrapPromptXml } from '@packages/mica-common/promptXml.js';
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

/** A returned promise delays completion until local accounting finishes; other return values are ignored. */
export type PluginModelRecorder = (entry: PluginModelUsageEntry) => unknown;

/**
 * 一次插件模型请求在**运行轨迹**里的落点。
 *
 * 记账（上面的 recorder）回答「花了多少 token」，轨迹回答「什么时候花的、等了多久、
 * 失败在哪一步」——两者不能互相替代：Stats 只有金额，复盘要的是金额背后的那一次请求。
 * 三个请求回调原样交给 `runModelTextRequest`，`finish` 在成功与失败时都要调一次。
 */
export type PluginModelTrace = {
  onRequestStart: (info: { messageCount: number; tools?: unknown }) => void;
  onRequestEnd: (info: {
    durationMs: number;
    firstTokenMs?: number;
    attempts: number;
    outcome: 'completed' | 'error' | 'aborted';
    toolCalls?: number;
    error?: string;
  }) => void;
  onRetry: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  finish(outcome: 'completed' | 'error' | 'aborted', error?: unknown, usage?: readonly AgentUsageRecord[]): void;
};

/** 主配置的接口信息：插件声明「跟随主配置」时由宿主解析出来。 */
export type MainProviderConfig = {
  providerId?: string;
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
  /**
   * 把这次请求记进运行轨迹（harness 复盘用）。没有会话可归属（`mica commit` 这类
   * 一次性命令）时返回 undefined，请求照常发、只是不进轨迹。
   */
  trace?: (info: {
    pluginId: string;
    purpose: string;
    model: string;
    providerId: string;
    protocol: NonNullable<PluginModelRequest['protocol']>;
    input: string;
    owner?: unknown;
  }) => PluginModelTrace | undefined;
};

export function createPluginModels(options: CreatePluginModelsOptions = {}): PluginModelsHandler {
  return async (pluginId, request) => {
    const resolved = applyMainProvider(request, options.resolveMainProvider);
    const model = resolved.model.trim();
    const startedAt = new Date().toISOString();
    const record = options.captureRecorder?.(request.owner) ?? options.record;
    const trace = openTrace(options.trace, {
      pluginId,
      purpose: request.purpose,
      model,
      providerId: resolved.providerId ?? 'plugin-helper',
      protocol: resolved.protocol ?? 'openai_chat_completions',
      input: request.user,
      owner: request.owner,
    });
    try {
      const result = await runModelTextRequest({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        protocol: resolved.protocol,
        providerId: resolved.providerId,
        model,
        system: wrapPromptXml('injection', request.system, {
          source: 'plugin',
          plugin: pluginId,
          section: 'model-system',
        }),
        user: request.user,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        createClient: options.createClient,
        ...(trace
          ? {
              observer: {
                onRequestStart: trace.onRequestStart,
                onRequestEnd: trace.onRequestEnd,
                onRetry: trace.onRetry,
              },
            }
          : {}),
      });
      finishTrace(trace, 'completed', undefined, result.usageHistory);
      await safelyRecord(record, {
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
      finishTrace(trace, isPluginAbort(error, request.signal) ? 'aborted' : 'error', error, requests);
      if (requests.length > 0) {
        await safelyRecord(record, {
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
 * 打开这次请求的运行轨迹。轨迹是观察面，失败只写日志：一个观测方的问题不该让插件
 * 的模型请求发不出去，也不该替换请求本身的错误。
 */
function openTrace(
  trace: CreatePluginModelsOptions['trace'],
  info: { pluginId: string; purpose: string; model: string; providerId: string; protocol: NonNullable<PluginModelRequest['protocol']>; input: string; owner?: unknown },
): PluginModelTrace | undefined {
  if (!trace) return undefined;
  try {
    return trace(info);
  } catch (error) {
    logTraceFailure(info.pluginId, info.purpose, error);
    return undefined;
  }
}

function finishTrace(
  trace: PluginModelTrace | undefined,
  outcome: 'completed' | 'error' | 'aborted',
  error: unknown,
  usage: readonly AgentUsageRecord[],
): void {
  if (!trace) return;
  try {
    trace.finish(outcome, error, usage);
  } catch (failure) {
    logTraceFailure('plugin', outcome, failure);
  }
}

function logTraceFailure(pluginId: string, purpose: string, error: unknown): void {
  try {
    createPluginLogger(pluginId).warn('plugin:model-trace-failed', {
      purpose,
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    /* A failing disk cannot alter the completed model result. */
  }
}

/**
 * 调用方中断与「请求失败」要分开：provider 的流被 abort 时可能抛一个普通的 Error
 * （SDK 自己包装过），只有信号本身才是可靠的判据——与 provider 里定 `request:end`
 * 的口径一致，否则同一次中断会在 request:end 记 aborted、在 run:finish 记 error。
 */
function isPluginAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'AgentAbortError');
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
): { baseUrl: string; apiKey: string; protocol: PluginModelRequest['protocol']; model: string; providerId?: string } {
  if (!request.useMainProvider) {
    return { baseUrl: request.baseUrl, apiKey: request.apiKey ?? '', protocol: request.protocol, model: request.model };
  }
  const requested = request.model.trim();
  const main = resolve?.(requested || undefined, request.owner);
  if (!main) throw new Error('插件请求要求跟随主配置，但宿主没有提供主配置');
  return {
    baseUrl: main.baseUrl,
    apiKey: main.apiKey,
    providerId: main.providerId,
    // 协议也归主配置：插件自己那四项在「跟随」时整体不生效，混用会出现
    // 「地址是 Responses 的、协议按 Chat Completions 拼端点」这种 404。
    protocol: main.protocol,
    // 插件点名了模型就用它的，否则用主配置当前的模型。
    model: requested || main.model,
  };
}

async function safelyRecord(record: PluginModelRecorder | undefined, entry: PluginModelUsageEntry): Promise<void> {
  try {
    await record?.(entry);
  } catch (error) {
    // Recording is local. A recording failure must not resend an already paid
    // request through the provider fallback or replace its original error.
    try {
      createPluginLogger(entry.pluginId).error('plugin:model-usage-save-failed', {
        purpose: entry.purpose,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      /* A failing disk cannot alter the completed model result. */
    }
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

/** 每次请求开始时捕获会话 id；同一个 agent/controller 可以在等待期间 resume 别的会话。 */
export function capturePluginModelUsageRecorder(
  controller: Pick<SessionController, 'getCurrentSessionId' | 'recordSubagentUsageForSession'>,
): PluginModelRecorder {
  const sessionId = controller.getCurrentSessionId();
  return async (entry) => {
    if (entry.requests.length > 0) {
      await controller.recordSubagentUsageForSession(sessionId, pluginUsageRecord(entry));
    }
  };
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

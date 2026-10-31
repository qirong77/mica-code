import { buildSubagentUsageRecord, type AgentUsageRecord } from '@packages/mica-agent/index.js';
import type {
  PluginSubagentThread,
  PluginSubagentThreadAskOptions,
  PluginSubagentThreadOptions,
  PluginSubagentThreadUsage,
} from '@packages/mica-plugin/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { buildSubagentToolFilter } from './subagentToolFilter.js';

/**
 * `ctx.subagents.thread()` 的宿主实现：一条**可复用**的隔离子代理。
 *
 * 与 `run` / `background` 的区别只有一处，但很关键：这些都是「派一次任务」，跑完就
 * 丢掉；线程是被插件持有的一整个子代理，它的消息数组就是这条线程的上下文，所以
 * 追问能看到上一轮读过什么。旁问（`/btw` 与桌面端抽屉）就是这种形态。
 *
 * 三件事由宿主负责，插件拿不到也不需要：
 * - **建子代理**：从当前会话的 agent 上拷一份 client 配置，system prompt 整体替换；
 * - **工具边界**：主会话专属工具（`primaryAgentOnly`）始终不进线程，否则旁问线程能
 *   改主流程的会话状态；
 * - **记账**：每一次 `ask` 只记它自己新产生的请求（`origin: 'plugin'`），追问不会把
 *   前面的请求重复计费；空闲时立刻落盘，turn 内交给本轮 checkpoint。
 */

export type PluginSubagentThreadHostOptions = {
  owner: AgentRuntime;
  pluginId: string;
  /** 线程标识，进用量记录（Stats 里区分同插件的多条旁问线程）。 */
  threadId: string;
  options: PluginSubagentThreadOptions;
  /** 记完一次请求后调用：宿主决定要不要立刻落盘（turn 内不要插一次保存）。 */
  persistUsage?: (owner: AgentRuntime) => void;
};

export function createPluginThread(input: PluginSubagentThreadHostOptions): PluginSubagentThread {
  const { owner, pluginId, threadId, options } = input;
  const child = owner.createSubAgent({
    systemPrompt: options.systemPrompt,
    tools: options.tools ?? true,
    toolFilter: buildSubagentToolFilter(options),
    ...(options.model ? { model: options.model } : {}),
  });
  const taskId = `plugin:${pluginId}:thread:${threadId}`;
  let recordedRequests = 0;
  let disposed = false;
  let answering = false;
  // 关闭线程要能停下正在跑的那一轮：dispose 之后没人看结果，继续跑完只是白烧 token。
  const shutdown = new AbortController();

  const recordUsage = (startedAt: string, status: 'completed' | 'failed' | 'killed', description: string): void => {
    const history = child.usageHistory ?? [];
    const requests = history.slice(recordedRequests);
    recordedRequests = history.length;
    if (requests.length === 0) return;
    owner.recordSubagentUsage(
      buildSubagentUsageRecord({
        taskId,
        origin: 'plugin',
        pluginId,
        subagentType: options.type,
        description,
        model: child.model,
        effort: 'none',
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        requests,
      }),
    );
    input.persistUsage?.(owner);
  };

  const usage = (): PluginSubagentThreadUsage => {
    const history = child.usageHistory ?? [];
    const last = child.lastUsage ?? history[history.length - 1];
    return {
      requests: history.length,
      last: toThreadUsage(last),
    };
  };

  return {
    async ask(question, askOptions: PluginSubagentThreadAskOptions = {}) {
      if (disposed) throw new Error('这条子代理线程已经关闭，需要重新创建');
      const text = String(question ?? '').trim();
      if (!text) throw new Error('问题不能为空');
      // 复用的是同一个子代理，消息数组不是并发安全的：主对话那边也这么要求，
      // 让第二个问题排队由调用方（插件）决定，而不是在这里悄悄串行。
      if (answering) throw new Error('这条子代理线程还在回答上一个问题');

      answering = true;
      attachCallbacks(child, askOptions);
      const startedAt = new Date().toISOString();
      const signal = askOptions.signal ? AbortSignal.any([askOptions.signal, shutdown.signal]) : shutdown.signal;
      try {
        const answer = await child.query(text, {
          signal,
          ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        });
        recordUsage(startedAt, 'completed', askOptions.description ?? options.description ?? options.type);
        return answer;
      } catch (error) {
        recordUsage(
          startedAt,
          signal.aborted ? 'killed' : 'failed',
          askOptions.description ?? options.description ?? options.type,
        );
        throw error;
      } finally {
        answering = false;
        detachCallbacks(child);
      }
    },

    usage,

    dispose() {
      if (disposed) return;
      disposed = true;
      shutdown.abort(new Error('这条子代理线程已经关闭'));
      detachCallbacks(child);
    },
  };
}

/** 线程默认不挂回调：终端里的旁问只有一条 notice，实时事件没人消费。 */
function attachCallbacks(
  child: ReturnType<AgentRuntime['createSubAgent']>,
  options: PluginSubagentThreadAskOptions,
): void {
  child.onText = options.onText;
  child.onThinking = options.onThinking;
  child.onToolCall = options.onToolCall;
  child.onToolResult = options.onToolResult;
}

function detachCallbacks(child: ReturnType<AgentRuntime['createSubAgent']>): void {
  child.onText = undefined;
  child.onThinking = undefined;
  child.onToolCall = undefined;
  child.onToolResult = undefined;
}

function toThreadUsage(usage: AgentUsageRecord | undefined): PluginSubagentThreadUsage['last'] {
  if (!usage) return null;
  return {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  };
}

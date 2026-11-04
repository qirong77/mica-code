import { recordSubagentTaskUsage } from '@packages/mica-agent/index.js';
import { micaContext } from '@packages/mica-context/index.js';
import type { CompactResult } from '@packages/mica-context/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from './AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';

/**
 * 把「这段 provider 历史压小」这件事本身做成内核能力。
 *
 * 策略（什么时候压、压哪一种、压几次）归插件；这里只回答「怎么压」：`quick` 走本地
 * 清理，`model` 走摘要子代理。放在内核的理由是它是所有压缩入口共用的实现细节——
 * `/compact llm`、模型压缩、将来别的插件要用的是同一份 CompactionService 与同一套
 * 用量记账，各写一份迟早会在「摘要请求算不算用量」这种问题上分叉。
 */

export type CompactMessagesMode = 'quick' | 'model';

export type CompactMessagesResult = {
  messages: unknown[];
  savedTokens: number;
};

export async function compactAgentMessages(
  agent: AgentRuntime,
  messages: unknown[],
  options: {
    mode: CompactMessagesMode;
    summarize?: (transcript: string, prompt: string) => Promise<string>;
    signal?: AbortSignal;
    preserveRecentMessages?: number;
    preserveRecentRounds?: number;
    preserveLatestUserMessage?: boolean;
  },
): Promise<CompactMessagesResult> {
  const { mode, summarize } = options;
  options.signal?.throwIfAborted();
  const service = new micaContext.CompactionService();
  const budget = {
    contextWindowSize: agent.config.provider.contextWindowSize,
    preserveRecentMessages: options.preserveRecentMessages,
    preserveRecentRounds: options.preserveRecentRounds,
    preserveLatestUserMessage: options.preserveLatestUserMessage,
  };
  if (mode === 'quick') {
    const result = await service.compact({ messages, options: { toolResultsOnly: true, ...budget } });
    return { messages: result.messages, savedTokens: Math.max(0, result.savedTokenEstimate) };
  }

  const result = await service.compact({
    messages,
    signal: options.signal,
    // 插件给了自己的摘要请求就用它：换模型是插件的策略，分段、预算与重试仍归内核。
    summarize: summarize ?? ((transcript, prompt) => summarizeWithSubAgent(agent, transcript, prompt, options.signal)),
    options: budget,
  });
  options.signal?.throwIfAborted();
  return { messages: result.messages, savedTokens: Math.max(0, result.savedTokenEstimate) };
}

async function summarizeWithSubAgent(
  agent: AgentRuntime,
  transcript: string,
  prompt: string,
  signal?: AbortSignal,
  pluginId?: string,
): Promise<string> {
  // 摘要必须走子代理、禁用工具：它共享父代理的工具注册表，session_* 之类的
  // 工具会去改正在被压缩的会话本身（与 /compact llm 同一条路径）。
  const subAgent = agent.createSubAgent({ systemPrompt: prompt, tools: false }, {
    helper: { kind: 'compaction', purpose: 'summarize', ...(pluginId ? { pluginId } : {}) },
  });
  const startedAt = new Date().toISOString();
  let status: 'completed' | 'failed' | 'aborted' = 'failed';
  try {
    const summary = await subAgent.query(
      [
        'Summarize this conversation into a compact checkpoint for the next coding agent.',
        'Preserve concrete paths, commands, validation results, user constraints, and pending work.',
        'Return only the requested <analysis> and <summary> blocks.',
        '',
        transcript,
      ].join('\n'),
      { signal },
    );
    status = 'completed';
    return summary;
  } finally {
    // 摘要请求不进主 usageHistory（那会污染 ctx 与 lastUsage），但要记进
    // subagentUsageHistory，否则这次开销在 Stats 里不可见。
    recordSubagentTaskUsage(agent, subAgent, {
      taskId: 'compact-summary',
      subagentType: 'compact',
      description: '模型压缩摘要',
      model: agent.config.model,
      effort: 'none',
      // 插件经 `ctx.agent.compactIdleHistory` 发起、又没配自己的摘要模型时，这笔钱是插件
      // 花出去的：记在插件名下，统计页才看得见「谁在压」。内核自己压的（/compact、
      // mica compact）没有插件可归属，仍落成 helper。
      ...(pluginId ? { origin: 'plugin' as const, pluginId } : {}),
      status: signal?.aborted ? 'killed' : status,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
}

/** 「没有可清理内容」与真正的失败要分开：前者不是错误，只是这次没压出东西。 */
export function isNothingToCompact(error: unknown): boolean {
  return micaContext.isCompactionNotNeededError(error);
}

/**
 * 一条请求里消息之外的开销（系统提示词 + 工具定义）。
 *
 * 确定性估算来自运行时（`estimateRequestOverheadTokens`，插件那边 `estimateTokens()`
 * 用的也是它）；上一次真实请求与当时估算的差额更贴近实际，但只有在它确实对应这份历史
 * 时才算数——条数对不上说明中间又聊过或已经压过一次，宁可用确定性估算。
 */
export function requestOverheadTokens(
  agent: AgentRuntime,
  input: { beforeTokenEstimate: number; beforeCount: number; lastUsage?: unknown },
): number {
  const usage = input.lastUsage as { inputTokens?: number; messageCount?: number } | undefined;
  const inputTokens = Number(usage?.inputTokens) || 0;
  const messageCount = Number(usage?.messageCount) || 0;
  const matchesHistory = inputTokens > 0 && (messageCount <= 0 || Math.abs(messageCount - input.beforeCount) <= 2);
  return micaContext.resolveRequestOverhead({
    estimated: agent.estimateRequestOverheadTokens?.() ?? 0,
    measured: matchesHistory ? inputTokens - input.beforeTokenEstimate : 0,
  });
}

/**
 * 把当前会话**已经存下来的**历史压缩一次，并落盘。
 *
 * 与 `compactAgentMessages('quick')` 的区别是改哪一份：那个改的是一次请求即将发送的
 * 历史（不落盘、随请求结束消失），这个改的是会话文件本身——所以它能在用户还没按下
 * 发送时就把上下文降下来，下一轮请求不必再为膨胀的历史付费。
 *
 * `quick` 只做本地清理（工具过程聚合成一条占位调用、思考与媒体清掉），不调用模型、
 * 不改对话正文；`model` 把用户与助手的对话交给模型写成一段 checkpoint 摘要，工具调用
 * 与结果不进摘要输入（它们只让摘要请求变长，不进结论）。
 *
 * 调用方必须已经独占这条会话（持有 turn lease）：这里会直接覆盖会话文件。
 */
export async function compactIdleSessionHistory(input: {
  agent: AgentRuntime;
  sessionController: SessionController;
  /** 触发这次压缩的插件 id（插件经 `ctx.agent.compactIdleHistory` 调用时由宿主传入）。 */
  pluginId?: string;
  /** 压哪一种；缺省 `quick`。 */
  mode?: CompactMessagesMode;
  /** `mode: 'model'` 的摘要请求；不给就用宿主的摘要子代理（会话模型）。 */
  summarize?: (transcript: string, prompt: string) => Promise<string>;
  /** 落盘时要写回的对话记录（含 notice）；不给就退回 agent 自己的投影。 */
  conversationMessages?: () => MicaUiConversationMessage[] | undefined;
  /**
   * 压缩已应用到内存、还没落盘的那一刻。插件在这里写会话状态与 notice，随后它们
   * 会和压缩结果一起被存下去——晚于落盘再写只能等下一轮，用户可能已经关了页面。
   *
   * 抛错会回滚这次压缩并不落盘。
   */
  afterApply?: (result: { savedTokens: number; beforeTokens: number; afterTokens: number }) => void;
}): Promise<{ savedTokens: number; beforeTokens: number; afterTokens: number } | null> {
  const { agent, sessionController } = input;
  const mode = input.mode ?? 'quick';
  const snapshot = agent.getSnapshot();
  if (snapshot.messages.length < 2) return null;

  const service = new micaContext.CompactionService();
  let result: CompactResult;
  try {
    result =
      mode === 'model'
        ? await service.compact({
            messages: snapshot.messages,
            // 插件给了自己的摘要请求就用它（换模型是插件的策略），否则走会话模型的摘要子代理。
            summarize:
              input.summarize ??
              ((transcript, prompt) =>
                summarizeWithSubAgent(agent, transcript, prompt, undefined, input.pluginId)),
            options: { summaryInput: 'dialogue', contextWindowSize: snapshot.contextWindowSize },
          })
        : await service.compact({
            messages: snapshot.messages,
            // 与 `/compact` 同一个实现：整段工具过程聚合成一条占位调用、丢掉思考、
            // 替换媒体块，对话正文原样保留。
            options: { toolResultsOnly: true, contextWindowSize: snapshot.contextWindowSize },
          });
  } catch (error) {
    // 「没有可压的内容」是常态（干净的会话每次都会走到这里），不是故障。
    if (isNothingToCompact(error)) return null;
    throw error;
  }
  if (result.messages.length === 0) return null;

  try {
    agent.loadSnapshot({
      ...snapshot,
      messages: result.messages,
      // 用量统计不跟着压缩走：清掉会把压缩前的开销从 Stats 里抹掉。
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
      // loadSnapshot 整组替换该字段：显式带上，别丢掉摘要/插件请求刚记的用量。
      subagentUsageHistory: agent.getSubagentUsageHistory(),
    });
  } catch (error) {
    agent.loadSnapshot(snapshot);
    throw error;
  }

  // 估算只覆盖消息；真实请求还带系统提示词与工具定义。加回这块固定开销之后，notice 与
  // ctx 徽标才和 provider 的 inputTokens 同一口径（压缩不改它，所以节省量不变）。
  const overhead = requestOverheadTokens(agent, {
    beforeTokenEstimate: result.beforeTokenEstimate,
    beforeCount: result.beforeCount,
    lastUsage: snapshot.lastUsage,
  });
  const savedTokens = Math.max(0, result.savedTokenEstimate);
  const beforeTokens = Math.max(0, result.beforeTokenEstimate + overhead);
  const afterTokens = Math.max(0, result.afterTokenEstimate + overhead);
  const summary = { savedTokens, beforeTokens, afterTokens };
  try {
    input.afterApply?.(summary);
  } catch (error) {
    // 回调里通常是插件写会话状态或发 notice 失败：退回压缩前的快照，别让磁盘上出现
    // 「压了但没记账」的半状态。
    agent.loadSnapshot(snapshot);
    throw error;
  }

  const conversationMessages = input.conversationMessages?.();
  sessionController.saveCurrent({
    preserveTitle: true,
    ...(conversationMessages ? { conversationMessages } : {}),
    // 压缩后的上下文占用：`lastUsage` 仍是压缩前那次真实请求（Stats 的对账口径，
    // 也是重试与自动压缩判断阈值的依据），所以界面上的 ctx 徽标读这一份，否则压完
    // 输入框左下角还写着压缩前的数字，看着像「没生效」。与 `mica compact` 同一种写法：
    // 下一次真实请求会把它替换掉。
    ...(result.afterTokenEstimate > 0
      ? { displayUsage: { totalTokens: afterTokens, compactedAt: new Date().toISOString() } }
      : {}),
  });
  return summary;
}

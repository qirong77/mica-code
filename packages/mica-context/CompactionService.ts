import type { AssistantMessage, Message, TextContent, ToolCall, UserMessage } from '@earendil-works/pi-ai';
import { contentText } from '@earendil-works/pi-ai/utils/text';
import { estimateContextTokens, estimateTextTokens } from './tokenEstimate.js';

export const COMPACT_SUMMARY_PREFIX = '[Mica compact checkpoint]';
export const COMPACT_BOUNDARY_PREFIX = '[Mica compact boundary]';

const DEFAULT_MIN_MESSAGES = 4;
const MAX_SUMMARY_TRANSCRIPT_CHARS = 16_000;
const RETRY_DROP_RATIO = 0.2;
// ── 摘要输入的块状呈现 ──────────────────────────────────────────────────
// pi 消息里一次模型回复包含正文、思考与工具调用，工具结果单独成条。摘要输入按
// 「轮」重组，避免模型自己配对散落的调用与结果：一轮里的正文、思考、工具
// 调用合成一块，所有工具结果合成一块，同类工具再聚合，指向性参数（路径 / 命令 /
// pattern）与错误信号保留。
const TRANSCRIPT_USER_CHARS = 6_000;
const TRANSCRIPT_MODEL_CHARS = 2_400;
const TRANSCRIPT_THINKING_CHARS = 800;
const TRANSCRIPT_TOOL_ARGUMENT_CHARS = 200;
const TRANSCRIPT_TOOL_RESULT_CHARS = 900;
/** 同类工具最多逐条列几次；长轮里同一个工具可能跑几十次。 */
const TRANSCRIPT_SAME_TOOL_CALLS = 3;
const TRANSCRIPT_SAME_TOOL_RESULTS = 6;
/**
 * 结果正文会被截断，但「这次动了哪些文件」是指向性信息，值得单独补一行：
 * 摘要里「改了哪些文件」几乎全靠它，截断后再从正文里找就找不回来了。
 */
const TRANSCRIPT_RESULT_PATH_PATTERN =
  /[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|md|json|css|html|yml|yaml|sh)/g;
const TRANSCRIPT_RESULT_PATHS = 12;
// 调用参数里的路径是「这次动了哪些文件」的唯一线索，一个路径二三十字符，
// 比截断后的参数正文便宜得多，所以上限给得比结果侧宽。
const TRANSCRIPT_TOOL_CALL_FILES = 60;
/** 信号行按整行抽，但压缩成一行的 JSON 结果会整行进来，等于把 head 又抄一遍。 */
const TRANSCRIPT_SIGNAL_LINE_CHARS = 200;
/** 依赖目录与构建产物里的路径对摘要没有意义，它们会把真有信息的那几个挤掉。 */
const TRANSCRIPT_PATH_NOISE = /(^|\/)(node_modules|\.git|dist|out|temp|\.backups)\//;
/** 参数里能说明「这次调用做了什么」的字段，按优先级取第一个。 */
const TRANSCRIPT_ARGUMENT_HINTS = [
  'command',
  'cmd',
  'script',
  'path',
  'file_path',
  'pattern',
  'query',
  'url',
  'name',
];
const OLD_MESSAGE_STRING_CHARS = 4_000;
const DEFAULT_MAX_RECENT_TOKENS = 12_000;
const AGGRESSIVE_MAX_RECENT_TOKENS = 8_000;
const DEFAULT_PRUNE_ONLY_THRESHOLD_RATIO = 0.3;
const DEFAULT_TARGET_CONTEXT_RATIO = 0.35;
const DEFAULT_RECENT_CONTEXT_RATIO = 0.12;
const DEFAULT_SUMMARY_INPUT_TOKENS = 80_000;
const DEFAULT_SUMMARY_INPUT_CONTEXT_RATIO = 0.5;
const MIN_SUMMARY_INPUT_TOKENS = 8_000;
const TOOL_RESULT_PLACEHOLDER = '[Old tool result content cleared during compact]';
const TOOL_ARGUMENTS_PLACEHOLDER = { _truncated: true, note: 'tool arguments cleared during compact' };
// ── 快速压缩的聚合形态 ──────────────────────────────────────────────────
// 压缩区（受保护区之前的历史）里的全部工具调用与结果合并成「一条调用 + 一条结果」：
// pi 的 toolCall 与 toolResult 必须配对，而结果清空后留下的只是信封。说明文本
// 里写明「不是真实结果」，模型据此知道要重读 / 重跑。
const AGGREGATE_CALL_ID = 'mica_compact';
const AGGREGATE_NOTE_PREFIX = '[Mica compact]';
/** 说明里最多列几种工具，其余折成 `+N more kinds`。 */
const AGGREGATE_NOTE_MAX_KINDS = 8;
/** 说明里「哪种工具调了几次」的分段标记；重复压缩据此还原计数。 */
const AGGREGATE_NOTE_KINDS_MARKER = '(not a real result): ';
const AGGREGATE_NOTE_KINDS_END = '. Outputs cleared';
const AGGREGATE_NOTE_KIND = /^(.*) × (\d+)$/;
const AGGREGATE_NOTE_EXTRA = /^\+(\d+) more kinds$/;
// 快速压缩（prune-only）找不到单条消息内可清理内容时，允许本地丢弃最早轮次。
// 只有节省量达到这两个下限之一才丢弃，避免把内容本来就不多的小会话也删掉。
const MIN_LOCAL_ROUND_DROP_SAVED_TOKENS = 8_000;
const MIN_LOCAL_ROUND_DROP_SAVED_RATIO = 0.05;

export type CompactInput = {
  messages: Message[];
  /**
   * 生成摘要的模型调用。只有需要 checkpoint 的路径（`/compact llm`、headless
   * `mica compact --session`、自动模型压缩）会用到它；`toolResultsOnly` 只做本地
   * 替换、不调用模型，所以允许缺省（缺省时走到摘要路径会明确报错）。
   */
  summarize?(transcript: string, prompt: string): Promise<string>;
  options?: CompactOptions;
  signal?: AbortSignal;
};

export type CompactMode = 'summarized' | 'pruned';
export type CompactStrategy = 'prune_only' | 'summary_with_recent' | 'summary_only_fallback' | 'tool_results_only';

export type CompactOptions = {
  customInstructions?: string;
  keepRecentRounds?: number;
  aggressive?: boolean;
  force?: boolean;
  preview?: boolean;
  pruneOnly?: boolean;
  /**
   * 只清理工具过程：把压缩区里的全部工具调用与结果聚合成一条占位调用、丢掉思考、
   * 把媒体块（图片/文档）换成占位符。用户与助手的正文原样保留，不生成 checkpoint、
   * 不丢轮次、不调用模型（可重复执行）。
   */
  toolResultsOnly?: boolean;
  /**
   * 摘要请求里放什么：`full`（默认）连工具调用、工具结果与思考一起放进去，`dialogue`
   * 只放用户与助手的对话正文。
   *
   * 手动「模型压缩」用 `dialogue`：用户要的是「把这段对话总结一下」，工具过程几十万
   * token 只会把摘要输入撑满、把对话本身挤掉。
   */
  summaryInput?: 'full' | 'dialogue';
  maxPromptTooLongRetries?: number;
  lightweightPrune?: boolean;
  forceSummary?: boolean;
  summarizeThresholdRatio?: number;
  contextWindowSize?: number;
  toolResultPlaceholder?: string;
  pruneOnlyThresholdRatio?: number;
  targetContextRatio?: number;
  maxRecentTokens?: number;
  minRecentRounds?: number;
  maxRecentRounds?: number;
  summaryInputTokenBudget?: number;
  /** Keep newest messages verbatim, extending the boundary to keep tool pairs together. */
  preserveRecentMessages?: number;
  /** Keep newest user rounds verbatim to protect the current task during automatic compaction. */
  preserveRecentRounds?: number;
  /** Keep the latest user request verbatim while summarizing older batches within that turn. */
  preserveLatestUserMessage?: boolean;
};

export type CompactResult = {
  messages: Message[];
  summary: string;
  mode: CompactMode;
  strategy: CompactStrategy;
  beforeCount: number;
  afterCount: number;
  summarizedCount: number;
  keptCount: number;
  beforeTokenEstimate: number;
  afterTokenEstimate: number;
  savedTokenEstimate: number;
  savedRatio: number;
  boundaryIndex: number;
  promptTooLongRetries: number;
  forced: boolean;
  preview: boolean;
  contextWindowSize?: number;
  contextUsageRatio?: number;
  lightweightTokenEstimate?: number;
  targetContextRatio?: number;
  pruneOnlyThresholdRatio?: number;
  recentTokenEstimate?: number;
  summaryInputTokenEstimate?: number;
  reducedRecentRounds?: number;
  /** toolResultsOnly：被聚合成占位调用的工具结果消息数。 */
  toolResultsReplaced?: number;
  /** toolResultsOnly：被丢弃的 thinking 块数。 */
  reasoningItemsDropped?: number;
  /** toolResultsOnly：被聚合成一条占位调用的工具调用数。 */
  toolCallsAggregated?: number;
  /** toolResultsOnly：被替换为占位符的媒体块数（图片/文档）。 */
  mediaItemsReplaced?: number;
};

export class CompactionNotNeededError extends Error {
  constructor(message = '当前会话内容较少，暂不需要 compact') {
    super(message);
    this.name = 'CompactionNotNeededError';
  }
}

export class CompactionPromptTooLongError extends Error {
  constructor(message = 'Compact request is still too long after retries') {
    super(message);
    this.name = 'CompactionPromptTooLongError';
  }
}

export function isCompactionNotNeededError(error: unknown): boolean {
  return error instanceof CompactionNotNeededError;
}

export class CompactionService {
  async compact(input: CompactInput): Promise<CompactResult> {
    input.signal?.throwIfAborted();
    const originalMessages = input.messages;
    const beforeCount = originalMessages.length;
    const options = input.options ?? {};
    // 快速压缩（/compact）：把整段工具过程聚合成一条占位调用、丢掉思考、替换媒体块。
    // 用户与助手正文原样保留，不生成 boundary/summary、不调用模型，所以连续执行不会
    // 丢失对话信息（没有可清理内容时报 not needed）。
    if (options.toolResultsOnly) return compactToolResultsOnly(originalMessages, options);
    const minMessages = options.force ? 2 : DEFAULT_MIN_MESSAGES;
    if (beforeCount < minMessages) {
      throw new CompactionNotNeededError();
    }

    const activeStartIndex = findLastCompactBoundaryIndex(originalMessages) + 1;
    const activeMessages = originalMessages.slice(activeStartIndex);
    if (activeMessages.length < minMessages) {
      throw new CompactionNotNeededError();
    }
    if (!options.lightweightPrune && !options.preserveLatestUserMessage && groupMessagesByRound(activeMessages).length < 2) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    const beforeTokenEstimate = estimateMessagesTokens(originalMessages);
    const compactedActiveMessages = options.lightweightPrune
      ? compactMessagesForCheckpoint(activeMessages, options)
      : cloneJson(activeMessages);
    const prunedMessageCount = countChangedMessages(activeMessages, compactedActiveMessages);
    const budget = getCompactBudget(options, beforeTokenEstimate);
    const pruneOnlyThresholdRatio = getPruneOnlyThresholdRatio(options);
    const targetContextRatio = getTargetContextRatio(options);
    let lightweightTokenEstimate: number | undefined;

    if (options.lightweightPrune) {
      const lightweightBoundaryMessage = createCompactBoundaryMessage(
        {
          mode: 'pruned',
          strategy: 'prune_only',
          beforeCount,
          beforeTokenEstimate,
          prunedCount: prunedMessageCount,
          keptCount: activeMessages.length,
          trigger: 'manual',
          contextWindowSize: budget.contextWindowSize,
          pruneOnlyThresholdRatio,
          targetContextRatio,
        },
      );
      const lightweightMessages = [lightweightBoundaryMessage, ...compactedActiveMessages];
      lightweightTokenEstimate = estimateMessagesTokens(lightweightMessages);
      const lightweightUsageRatio = usageRatio(lightweightTokenEstimate, budget.contextWindowSize);
      if (
        prunedMessageCount > 0 &&
        lightweightTokenEstimate < beforeTokenEstimate &&
        (options.pruneOnly ||
          (!options.forceSummary &&
            budget.contextWindowSize &&
            lightweightUsageRatio !== undefined &&
            lightweightUsageRatio <= pruneOnlyThresholdRatio))
      ) {
        const savedTokenEstimate = Math.max(0, beforeTokenEstimate - lightweightTokenEstimate);
        const savedRatio = beforeTokenEstimate > 0 ? savedTokenEstimate / beforeTokenEstimate : 0;
        return {
          messages: options.preview ? cloneJson(originalMessages) : lightweightMessages,
          summary: 'Lightweight compact pruned media, documents, base64 payloads, and tool results.',
          mode: 'pruned',
          strategy: 'prune_only',
          beforeCount,
          afterCount: lightweightMessages.length,
          summarizedCount: 0,
          keptCount: activeMessages.length,
          beforeTokenEstimate,
          afterTokenEstimate: lightweightTokenEstimate,
          savedTokenEstimate,
          savedRatio,
          boundaryIndex: activeStartIndex - 1,
          promptTooLongRetries: 0,
          forced: Boolean(options.force),
          preview: Boolean(options.preview),
          contextWindowSize: budget.contextWindowSize,
          contextUsageRatio: lightweightUsageRatio,
          lightweightTokenEstimate,
          targetContextRatio,
          pruneOnlyThresholdRatio,
          recentTokenEstimate: estimateMessagesTokens(compactedActiveMessages),
          summaryInputTokenEstimate: 0,
          reducedRecentRounds: 0,
        };
      }
    }

    if (options.pruneOnly) {
      const roundDrop = buildLocalRoundDrop({
        messages: activeMessages,
        compactedMessages: compactedActiveMessages,
        previewMessages: originalMessages,
        options,
        beforeCount,
        beforeTokenEstimate,
        boundaryIndex: activeStartIndex - 1,
        budget,
        pruneOnlyThresholdRatio,
        targetContextRatio,
      });
      if (roundDrop) return roundDrop;
      throw new CompactionNotNeededError('当前会话没有可本地清理的内容，暂不需要快速压缩');
    }

    if (groupMessagesByRound(activeMessages).length < 2 && !options.preserveLatestUserMessage) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    const protectedStart = protectedRecentStart(activeMessages, options);
    let splitIndex = Math.min(chooseRecentStartIndex(activeMessages, compactedActiveMessages, options), protectedStart);
    splitIndex = adjustStartForToolPairs(activeMessages, splitIndex);
    // One user turn may contain hundreds of tool batches. Keep its exact request
    // separately so the accumulated work can still be summarized.
    if (splitIndex <= 0 && options.preserveLatestUserMessage && protectedStart > 0) {
      splitIndex = protectedStart;
    }
    if (splitIndex <= 0 && options.force) {
      splitIndex = Math.min(chooseForcedRecentStartIndex(activeMessages, compactedActiveMessages, options), protectedStart);
      splitIndex = adjustStartForToolPairs(activeMessages, splitIndex);
    }

    let messagesToSummarize = compactedActiveMessages.slice(0, splitIndex);
    let keptMessages = (protectedStart < activeMessages.length || options.preserveLatestUserMessage
      ? activeMessages : compactedActiveMessages).slice(splitIndex);
    if (messagesToSummarize.length === 0 && options.force && protectedStart === activeMessages.length) {
      messagesToSummarize = compactedActiveMessages;
      keptMessages = [];
    }
    if (messagesToSummarize.length === 0) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    const latestUserIndex = options.preserveLatestUserMessage ? findLatestUserIndex(activeMessages) : -1;
    if (latestUserIndex >= 0 && latestUserIndex < splitIndex) {
      keptMessages = [activeMessages[latestUserIndex], ...keptMessages];
    }
    const protectedMessages = new Set(activeMessages.slice(protectedStart));
    if (latestUserIndex >= 0) protectedMessages.add(activeMessages[latestUserIndex]!);
    let summarizedMessageCount = messagesToSummarize.length;
    messagesToSummarize = fitMessagesToSummaryBudget(
      messagesToSummarize,
      getSummaryInputTokenBudget(options),
      options,
    );
    if (messagesToSummarize.length === 0) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    const maxRetries = options.maxPromptTooLongRetries ?? (options.aggressive ? 4 : 3);
    const prompt = getCompactPrompt(options.customInstructions);
    let promptTooLongRetries = 0;
    let summary = '';
    let summaryInputTokenEstimate = 0;

    const shrinkSummaryInput = (): void => {
      const previousPayload = stringifyValue(stripPromptTooLongRetryMarker(messagesToSummarize));
      const nextMessages = fitMessagesToSummaryBudget(
        truncateHeadForPromptTooLongRetry(messagesToSummarize),
        getSummaryInputTokenBudget(options),
        options,
      );
      const nextPayload = stringifyValue(stripPromptTooLongRetryMarker(nextMessages));
      if (nextPayload === previousPayload) throw new CompactionPromptTooLongError();
      messagesToSummarize = nextMessages;
    };

    const summarizeCurrentMessages = async (): Promise<void> => {
      const summarize = input.summarize;
      if (!summarize) {
        throw new Error('compact requires a summarize callback for model summarization');
      }
      for (;;) {
        input.signal?.throwIfAborted();
        const transcript = buildTranscript(messagesToSummarize, {
          dialogueOnly: options.summaryInput === 'dialogue',
        });
        summaryInputTokenEstimate = estimateTokens(transcript);
        try {
          summary = cleanSummary(await summarize(transcript, prompt));
          input.signal?.throwIfAborted();
        } catch (error) {
          if (!isPromptTooLongError(error) || promptTooLongRetries >= maxRetries) throw error;
          promptTooLongRetries++;
          shrinkSummaryInput();
          continue;
        }

        if (looksLikePromptTooLongResponse(summary)) {
          if (promptTooLongRetries >= maxRetries) {
            throw new CompactionPromptTooLongError();
          }
          promptTooLongRetries++;
          shrinkSummaryInput();
          continue;
        }
        break;
      }

      if (!summary.trim()) throw new Error('Compact summary is empty');
    };

    await summarizeCurrentMessages();

    let finalKeptMessages = options.preserveRecentRounds || options.preserveRecentMessages
      ? keptMessages
      : compactKeptMessages(keptMessages, options, getRecentTokenBudget(options));
    const initialKeptRounds = groupMessagesByRound(finalKeptMessages).length;
    let reducedRecentRounds = 0;
    let strategy: CompactStrategy = finalKeptMessages.length > 0 ? 'summary_with_recent' : 'summary_only_fallback';

    while (finalKeptMessages.length > 0) {
      const candidateMessages = buildSummarizedMessages(
        summary,
        finalKeptMessages,
        beforeCount,
        beforeTokenEstimate,
        summarizedMessageCount,
        promptTooLongRetries,
        options,
        budget,
        lightweightTokenEstimate,
        strategy,
        pruneOnlyThresholdRatio,
        targetContextRatio,
      );
      if (estimateMessagesTokens(candidateMessages) <= budget.targetContextTokens) break;

      const nextKeptMessages = dropOldestRecentRound(finalKeptMessages);
      if (nextKeptMessages.length === finalKeptMessages.length) break;

      const movedToSummary = finalKeptMessages.slice(0, finalKeptMessages.length - nextKeptMessages.length);
      if (movedToSummary.some((message) => protectedMessages.has(message))) break;
      summarizedMessageCount += movedToSummary.length;
      messagesToSummarize = fitMessagesToSummaryBudget(
        [createCompactSummaryMessage(summary, true), ...movedToSummary],
        getSummaryInputTokenBudget(options),
        options,
      );
      finalKeptMessages = options.preserveRecentRounds || options.preserveRecentMessages
        ? nextKeptMessages
        : compactKeptMessages(nextKeptMessages, options, Math.floor(getRecentTokenBudget(options) * 0.75));
      const nextKeptRounds = groupMessagesByRound(finalKeptMessages).length;
      reducedRecentRounds = Math.max(reducedRecentRounds, Math.max(0, initialKeptRounds - nextKeptRounds));
      strategy = finalKeptMessages.length > 0 ? 'summary_with_recent' : 'summary_only_fallback';
      await summarizeCurrentMessages();
    }

    if (finalKeptMessages.length === 0) {
      strategy = 'summary_only_fallback';
      reducedRecentRounds = Math.max(reducedRecentRounds, initialKeptRounds);
    }

    const summaryMessage = createCompactSummaryMessage(summary, finalKeptMessages.length > 0);
    const boundaryMessage = createCompactBoundaryMessage(
      {
        mode: 'summarized',
        strategy,
        beforeCount,
        beforeTokenEstimate,
        summarizedCount: summarizedMessageCount,
        keptCount: finalKeptMessages.length,
        keptTokenEstimate: estimateMessagesTokens(finalKeptMessages),
        keptCompacted:
          estimateMessagesTokens(finalKeptMessages) < estimateMessagesTokens(activeMessages.slice(splitIndex)),
        promptTooLongRetries,
        trigger: 'manual',
        contextWindowSize: budget.contextWindowSize,
        pruneOnlyThresholdRatio,
        targetContextRatio,
        lightweightTokenEstimate,
        summaryInputTokenEstimate,
        reducedRecentRounds,
      },
    );
    const compactMessages = [boundaryMessage, summaryMessage, ...finalKeptMessages];
    const afterTokenEstimate = estimateMessagesTokens(compactMessages);
    const savedTokenEstimate = Math.max(0, beforeTokenEstimate - afterTokenEstimate);
    const savedRatio = beforeTokenEstimate > 0 ? savedTokenEstimate / beforeTokenEstimate : 0;
    const contextUsageRatio = usageRatio(afterTokenEstimate, budget.contextWindowSize);

    if (!options.preview && afterTokenEstimate >= beforeTokenEstimate && !options.aggressive && !options.force) {
      throw new CompactionNotNeededError('compact 后预计不会节省上下文，已保留原会话');
    }

    return {
      messages: options.preview ? cloneJson(originalMessages) : compactMessages,
      summary,
      mode: 'summarized',
      strategy,
      beforeCount,
      afterCount: compactMessages.length,
      summarizedCount: summarizedMessageCount,
      keptCount: finalKeptMessages.length,
      beforeTokenEstimate,
      afterTokenEstimate,
      savedTokenEstimate,
      savedRatio,
      boundaryIndex: activeStartIndex - 1,
      promptTooLongRetries,
      forced: Boolean(options.force),
      preview: Boolean(options.preview),
      contextWindowSize: budget.contextWindowSize,
      contextUsageRatio,
      lightweightTokenEstimate,
      targetContextRatio,
      pruneOnlyThresholdRatio,
      recentTokenEstimate: estimateMessagesTokens(finalKeptMessages),
      summaryInputTokenEstimate,
      reducedRecentRounds,
    };
  }
}

type CompactBudget = {
  contextWindowSize?: number;
  targetContextTokens: number;
};

function getCompactBudget(options: CompactOptions, beforeTokenEstimate: number): CompactBudget {
  const contextWindowSize = positiveNumber(options.contextWindowSize);
  const targetRatio = getTargetContextRatio(options);
  const targetFromWindow = contextWindowSize ? Math.max(1, Math.floor(contextWindowSize * targetRatio)) : undefined;
  const targetFromCurrent = Math.max(1, Math.floor(beforeTokenEstimate * targetRatio));
  return {
    contextWindowSize,
    targetContextTokens: targetFromWindow
      ? Math.min(targetFromWindow, Math.max(targetFromCurrent, getRecentTokenBudget(options)))
      : Math.max(targetFromCurrent, getRecentTokenBudget(options)),
  };
}

function getTargetContextRatio(options: CompactOptions): number {
  return clampRatio(options.targetContextRatio ?? DEFAULT_TARGET_CONTEXT_RATIO, DEFAULT_TARGET_CONTEXT_RATIO);
}

function getPruneOnlyThresholdRatio(options: CompactOptions): number {
  return clampRatio(
    options.pruneOnlyThresholdRatio ?? options.summarizeThresholdRatio ?? DEFAULT_PRUNE_ONLY_THRESHOLD_RATIO,
    DEFAULT_PRUNE_ONLY_THRESHOLD_RATIO,
  );
}

function chooseRecentStartIndex(messages: Message[], compactedMessages: Message[], options: CompactOptions): number {
  const rounds = groupMessagesByRound(messages);
  if (rounds.length < 2) return 0;
  if (options.keepRecentRounds !== undefined) {
    const keepRounds = Math.max(1, Math.floor(options.keepRecentRounds));
    if (rounds.length <= keepRounds && !options.force) return 0;
    return rounds[Math.max(1, rounds.length - keepRounds)]?.start ?? 0;
  }

  const minRecentRounds = Math.max(1, Math.floor(options.minRecentRounds ?? 1));
  const maxRecentRounds = Math.max(minRecentRounds, Math.floor(options.maxRecentRounds ?? 3));
  const recentTokenBudget = getRecentTokenBudget(options);
  let start = messages.length;
  let keptRounds = 0;

  for (let index = rounds.length - 1; index >= 0 && keptRounds < maxRecentRounds; index--) {
    const candidateStart = rounds[index]!.start;
    const candidateTokens = estimateMessagesTokens(compactedMessages.slice(candidateStart));
    if (keptRounds >= minRecentRounds && candidateTokens > recentTokenBudget) break;
    start = candidateStart;
    keptRounds++;
  }

  return start >= messages.length ? 0 : start;
}

function chooseForcedRecentStartIndex(
  messages: Message[],
  compactedMessages: Message[],
  options: CompactOptions,
): number {
  const rounds = groupMessagesByRound(messages);
  if (rounds.length < 2) return 0;
  const keepRounds = Math.max(1, Math.floor(options.keepRecentRounds ?? options.minRecentRounds ?? 1));
  if (options.keepRecentRounds !== undefined && rounds.length <= keepRounds) return 0;
  let start = rounds[Math.max(1, rounds.length - keepRounds)]?.start ?? 0;
  while (start > 0 && estimateMessagesTokens(compactedMessages.slice(start)) > getRecentTokenBudget(options)) {
    const roundIndex = rounds.findIndex((round) => round.start === start);
    if (roundIndex < 0 || roundIndex >= rounds.length - 1) break;
    start = rounds[roundIndex + 1]?.start ?? start;
  }
  return start;
}

function getRecentTokenBudget(options: CompactOptions): number {
  const explicit = positiveNumber(options.maxRecentTokens);
  if (explicit) return explicit;
  const contextWindowSize = positiveNumber(options.contextWindowSize);
  const defaultBudget = options.aggressive ? AGGRESSIVE_MAX_RECENT_TOKENS : DEFAULT_MAX_RECENT_TOKENS;
  if (!contextWindowSize) return defaultBudget;
  return Math.max(1, Math.min(defaultBudget, Math.floor(contextWindowSize * DEFAULT_RECENT_CONTEXT_RATIO)));
}

function getSummaryInputTokenBudget(options: CompactOptions): number {
  const explicit = positiveNumber(options.summaryInputTokenBudget);
  if (explicit) return explicit;
  const contextWindowSize = positiveNumber(options.contextWindowSize);
  if (!contextWindowSize) return DEFAULT_SUMMARY_INPUT_TOKENS;
  return Math.max(MIN_SUMMARY_INPUT_TOKENS, Math.floor(contextWindowSize * DEFAULT_SUMMARY_INPUT_CONTEXT_RATIO));
}

function fitMessagesToSummaryBudget(messages: Message[], tokenBudget: number, options: CompactOptions): Message[] {
  let next = messages;
  // 预算按「摘要请求实际会发出去的那份正文」量：`summaryInput: 'dialogue'` 时工具过程
  // 不进摘要，用全文估计会白白截掉真正要发的对话。
  const transcriptOptions = { dialogueOnly: options.summaryInput === 'dialogue' };
  while (next.length > 1 && estimateTokens(buildTranscript(next, transcriptOptions)) > tokenBudget) {
    const before = stringifyValue(next);
    const truncated = truncateHeadForPromptTooLongRetry(next);
    next = truncated;
    if (stringifyValue(truncated) === before) break;
  }
  return next;
}

function dropOldestRecentRound(messages: Message[]): Message[] {
  const rounds = groupMessagesByRound(messages);
  if (rounds.length <= 1) return [];
  return messages.slice(rounds[1]?.start ?? messages.length);
}

// prune-only 快速压缩的兜底：单条消息内没有可清理的大块内容（上下文大主要是
// 由大量小消息堆出来的，例如工具调用对 + 短输出），此时本地丢弃最早轮次、
// 保留最近轮次（复用最近 token 预算），不调用模型。必须落在轮次边界且不能
// 拆散 tool call/result 配对，节省量低于阈值时返回 null 交给上层报
// "暂无可快速清理内容"。
function buildLocalRoundDrop(params: {
  messages: Message[];
  compactedMessages: Message[];
  previewMessages: Message[];
  options: CompactOptions;
  beforeCount: number;
  beforeTokenEstimate: number;
  boundaryIndex: number;
  budget: CompactBudget;
  pruneOnlyThresholdRatio: number;
  targetContextRatio: number;
}): CompactResult | null {
  if (groupMessagesByRound(params.messages).length < 2) return null;

  let protectedStart = protectedRecentStart(params.messages, params.options);
  if (params.options.preserveLatestUserMessage) {
    const latestUserIndex = findLatestUserIndex(params.messages);
    if (latestUserIndex >= 0) protectedStart = Math.min(protectedStart, latestUserIndex);
  }
  let splitIndex = Math.min(
    chooseRecentStartIndex(params.messages, params.compactedMessages, params.options),
    protectedStart,
  );
  splitIndex = adjustStartForToolPairs(params.messages, splitIndex);
  if (splitIndex <= 0) return null;

  const keptMessages = params.compactedMessages.slice(splitIndex);
  const droppedCount = splitIndex;
  const boundaryMessage = createCompactBoundaryMessage(
    {
      mode: 'pruned',
      strategy: 'prune_only',
      beforeCount: params.beforeCount,
      beforeTokenEstimate: params.beforeTokenEstimate,
      prunedCount: droppedCount,
      keptCount: keptMessages.length,
      droppedRounds: Math.max(
        0,
        groupMessagesByRound(params.messages).length - groupMessagesByRound(keptMessages).length,
      ),
      trigger: 'manual',
      contextWindowSize: params.budget.contextWindowSize,
      pruneOnlyThresholdRatio: params.pruneOnlyThresholdRatio,
      targetContextRatio: params.targetContextRatio,
    },
  );
  const compactMessages = [boundaryMessage, ...keptMessages];
  const afterTokenEstimate = estimateMessagesTokens(compactMessages);
  const savedTokenEstimate = Math.max(0, params.beforeTokenEstimate - afterTokenEstimate);
  const savedRatio = params.beforeTokenEstimate > 0 ? savedTokenEstimate / params.beforeTokenEstimate : 0;
  if (
    savedTokenEstimate < MIN_LOCAL_ROUND_DROP_SAVED_TOKENS &&
    savedTokenEstimate < params.beforeTokenEstimate * MIN_LOCAL_ROUND_DROP_SAVED_RATIO
  ) {
    return null;
  }

  return {
    messages: params.options.preview ? cloneJson(params.previewMessages) : compactMessages,
    summary: 'Quick compact dropped the oldest rounds locally; recent rounds retained.',
    mode: 'pruned',
    strategy: 'prune_only',
    beforeCount: params.beforeCount,
    afterCount: compactMessages.length,
    summarizedCount: 0,
    keptCount: keptMessages.length,
    beforeTokenEstimate: params.beforeTokenEstimate,
    afterTokenEstimate,
    savedTokenEstimate,
    savedRatio,
    boundaryIndex: params.boundaryIndex,
    promptTooLongRetries: 0,
    forced: Boolean(params.options.force),
    preview: Boolean(params.options.preview),
    contextWindowSize: params.budget.contextWindowSize,
    contextUsageRatio: usageRatio(afterTokenEstimate, params.budget.contextWindowSize),
    lightweightTokenEstimate: afterTokenEstimate,
    targetContextRatio: params.targetContextRatio,
    pruneOnlyThresholdRatio: params.pruneOnlyThresholdRatio,
    recentTokenEstimate: estimateMessagesTokens(keptMessages),
    summaryInputTokenEstimate: 0,
    reducedRecentRounds: 0,
  };
}

function buildSummarizedMessages(
  summary: string,
  keptMessages: Message[],
  beforeCount: number,
  beforeTokenEstimate: number,
  summarizedCount: number,
  promptTooLongRetries: number,
  options: CompactOptions,
  budget: CompactBudget,
  lightweightTokenEstimate: number | undefined,
  strategy: CompactStrategy,
  pruneOnlyThresholdRatio: number,
  targetContextRatio: number,
): Message[] {
  const summaryMessage = createCompactSummaryMessage(summary, keptMessages.length > 0);
  const boundaryMessage = createCompactBoundaryMessage(
    {
      mode: 'summarized',
      strategy,
      beforeCount,
      beforeTokenEstimate,
      summarizedCount,
      keptCount: keptMessages.length,
      keptTokenEstimate: estimateMessagesTokens(keptMessages),
      promptTooLongRetries,
      trigger: 'manual',
      contextWindowSize: budget.contextWindowSize,
      pruneOnlyThresholdRatio,
      targetContextRatio,
      lightweightTokenEstimate,
      forced: Boolean(options.force),
    },
  );
  return [boundaryMessage, summaryMessage, ...keptMessages];
}

function adjustStartForToolPairs(messages: Message[], start: number): number {
  if (start <= 0 || start >= messages.length) return start;
  let nextStart = start;
  let changed = true;
  while (changed) {
    changed = false;
    const suffixResultIds = new Set<string>();
    for (let index = nextStart; index < messages.length; index++) {
      for (const id of getToolResultIds(messages[index])) suffixResultIds.add(id);
    }
    for (let index = 0; index < nextStart; index++) {
      if (!getToolCallIds(messages[index]).some((id) => suffixResultIds.has(id))) continue;
      nextStart = index;
      changed = true;
      break;
    }
  }
  return nextStart;
}

function getToolCallIds(message: Message): string[] {
  return message.role === 'assistant'
    ? message.content.filter((block) => block.type === 'toolCall').map((call) => call.id)
    : [];
}

function getToolResultIds(message: Message): string[] {
  return message.role === 'toolResult' ? [message.toolCallId] : [];
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function clampRatio(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(1, number);
}

function compactMessagesForCheckpoint(messages: Message[], options: CompactOptions): Message[] {
  const protectedStart = protectedRecentStart(messages, options);
  const latestUserIndex = options.preserveLatestUserMessage ? findLatestUserIndex(messages) : -1;
  return messages.map((message, index) =>
    index >= protectedStart || index === latestUserIndex
      ? message
      : pruneMessage(message, {
          maxStringChars: OLD_MESSAGE_STRING_CHARS,
          placeholder: options.toolResultPlaceholder,
          mode: 'old',
        }),
  );
}

// 快速压缩只处理受保护区之前的工具过程、思考与图片，保留对话正文的顺序。
function compactToolResultsOnly(messages: Message[], options: CompactOptions): CompactResult {
  const zone = quickCompactZone(messages, options);
  const scan = scanCompressedZone(messages, zone);
  const aggregate = scan.template
    ? aggregatePair(scan.counts, scan.totalCalls, scan.extraKinds, scan.template)
    : [];
  const compactedMessages = [...scan.kept, ...aggregate, ...messages.slice(zone.boundary)];

  if (
    scan.newToolCalls === 0 &&
    scan.toolResultsReplaced === 0 &&
    scan.reasoningItemsDropped === 0 &&
    scan.mediaItemsReplaced === 0
  ) {
    throw new CompactionNotNeededError('当前会话没有可清理的内容，暂不需要快速压缩');
  }

  const beforeTokenEstimate = estimateMessagesTokens(messages);
  const afterTokenEstimate = estimateMessagesTokens(compactedMessages);
  const savedTokenEstimate = Math.max(0, beforeTokenEstimate - afterTokenEstimate);
  const contextWindowSize = positiveNumber(options.contextWindowSize);
  return {
    messages: options.preview ? cloneJson(messages) : compactedMessages,
    summary:
      'Tool calls and results aggregated into one placeholder pair, thinking dropped, media replaced; no message was summarized.',
    mode: 'pruned',
    strategy: 'tool_results_only',
    beforeCount: messages.length,
    afterCount: compactedMessages.length,
    summarizedCount: 0,
    keptCount: compactedMessages.length,
    beforeTokenEstimate,
    afterTokenEstimate,
    savedTokenEstimate,
    savedRatio: beforeTokenEstimate > 0 ? savedTokenEstimate / beforeTokenEstimate : 0,
    boundaryIndex: -1,
    promptTooLongRetries: 0,
    forced: Boolean(options.force),
    preview: Boolean(options.preview),
    contextWindowSize,
    contextUsageRatio: usageRatio(afterTokenEstimate, contextWindowSize),
    lightweightTokenEstimate: afterTokenEstimate,
    recentTokenEstimate: afterTokenEstimate,
    summaryInputTokenEstimate: 0,
    reducedRecentRounds: 0,
    toolResultsReplaced: scan.toolResultsReplaced,
    reasoningItemsDropped: scan.reasoningItemsDropped,
    toolCallsAggregated: scan.newToolCalls,
    mediaItemsReplaced: scan.mediaItemsReplaced,
  };
}

type CompressedZoneScan = {
  kept: Message[];
  counts: Map<string, number>;
  extraKinds: number;
  totalCalls: number;
  newToolCalls: number;
  /** 元信息沿用最后一个被聚合的 assistant，不制造虚构的 provider/model。 */
  template?: AssistantMessage;
  toolResultsReplaced: number;
  reasoningItemsDropped: number;
  mediaItemsReplaced: number;
};

type QuickCompactZone = {
  boundary: number;
  /** 压缩区内仍需原样留下的最新用户消息；-1 表示没有。 */
  verbatimIndex: number;
};

function quickCompactZone(messages: Message[], options: CompactOptions): QuickCompactZone {
  const protectedStart = protectedRecentStart(messages, options);
  if (!options.preserveLatestUserMessage) return { boundary: protectedStart, verbatimIndex: -1 };
  const latestUserIndex = findLatestUserIndex(messages);
  if (latestUserIndex < 0) return { boundary: protectedStart, verbatimIndex: -1 };
  // 单轮长工具循环允许压缩旧批次，但请求（含图片）必须保留。
  if (latestUserIndex === 0) return { boundary: protectedStart, verbatimIndex: 0 };
  return { boundary: Math.min(protectedStart, adjustStartForToolPairs(messages, latestUserIndex)), verbatimIndex: -1 };
}

function scanCompressedZone(messages: Message[], zone: QuickCompactZone): CompressedZoneScan {
  const scan: CompressedZoneScan = {
    kept: [], counts: new Map(), extraKinds: 0, totalCalls: 0, newToolCalls: 0,
    toolResultsReplaced: 0, reasoningItemsDropped: 0, mediaItemsReplaced: 0,
  };
  for (let index = 0; index < zone.boundary; index++) {
    const message = messages[index]!;
    if (index === zone.verbatimIndex) {
      scan.kept.push(message);
      continue;
    }
    if (message.role === 'toolResult') {
      if (message.toolCallId === AGGREGATE_CALL_ID) {
        const previous = aggregateNoteOf(contentText(message.content));
        if (previous) {
          for (const [name, count] of previous.counts) scan.counts.set(name, (scan.counts.get(name) ?? 0) + count);
          scan.extraKinds = Math.max(scan.extraKinds, previous.extraKinds);
          scan.totalCalls += previous.total;
        }
      } else {
        scan.toolResultsReplaced++;
        scan.mediaItemsReplaced += message.content.filter((block) => block.type === 'image').length;
      }
      continue;
    }
    if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      let changed = false;
      for (const block of message.content) {
        if (block.type === 'thinking') {
          scan.reasoningItemsDropped++;
          changed = true;
        } else if (block.type === 'toolCall') {
          scan.template = message;
          if (block.id !== AGGREGATE_CALL_ID) {
            scan.counts.set(block.name, (scan.counts.get(block.name) ?? 0) + 1);
            scan.newToolCalls++;
            scan.totalCalls++;
          }
          changed = true;
        } else {
          content.push(block);
        }
      }
      if (content.length > 0) scan.kept.push(changed ? rewrittenAssistant(message, content) : message);
      continue;
    }
    if (message.role === 'user' && Array.isArray(message.content)) {
      const content = message.content.map((block): TextContent | typeof block => {
        if (block.type !== 'image') return block;
        scan.mediaItemsReplaced++;
        return imagePlaceholder();
      });
      scan.kept.push(content.some((block, index) => block !== message.content[index]) ? { ...message, content } : message);
    } else {
      scan.kept.push(message);
    }
  }
  return scan;
}

/** 从上一次聚合结果里还原计数；调用侧只有结构化空参数。 */
function aggregateNoteOf(text: string): { counts: Map<string, number>; total: number; extraKinds: number } | null {
  if (!text.startsWith(AGGREGATE_NOTE_PREFIX)) return null;
  const markerAt = text.indexOf(AGGREGATE_NOTE_KINDS_MARKER);
  if (markerAt < 0) return null;
  const totalMatch = /Placeholder for (\d+) collapsed tool/.exec(text);
  const endAt = text.indexOf(AGGREGATE_NOTE_KINDS_END, markerAt);
  const kindsText = text.slice(markerAt + AGGREGATE_NOTE_KINDS_MARKER.length, endAt >= 0 ? endAt : undefined);
  const counts = new Map<string, number>();
  let extraKinds = 0;
  for (const part of kindsText.split(', ')) {
    const extra = AGGREGATE_NOTE_EXTRA.exec(part);
    if (extra) { extraKinds += Number(extra[1]); continue; }
    const match = AGGREGATE_NOTE_KIND.exec(part);
    if (match) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + Number(match[2]));
  }
  return { counts, total: totalMatch ? Number(totalMatch[1]) : [...counts.values()].reduce((sum, count) => sum + count, 0), extraKinds };
}

function aggregatePair(counts: Map<string, number>, total: number, extraKinds: number, template: AssistantMessage): Message[] {
  const name = primaryToolName(counts);
  const assistant = rewrittenAssistant(template, [{ type: 'toolCall', id: AGGREGATE_CALL_ID, name, arguments: {} }]);
  return [
    { ...assistant, stopReason: 'toolUse' },
    {
      role: 'toolResult', toolCallId: AGGREGATE_CALL_ID, toolName: name,
      content: [{ type: 'text', text: aggregateNote(counts, total, extraKinds) }],
      isError: false, timestamp: template.timestamp,
    },
  ];
}

/** 聚合调用用哪个名字：调用次数最多的那个（同数按字母序），保证每次压缩结果稳定。 */
function primaryToolName(counts: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [name, count] of [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best || 'unknown_tool';
}

/**
 * 聚合说明。`(not a real result)` 不是客套：不说清楚的话，模型会以为自己真的读过
 * 那些文件、跑过那些命令，不再复查。
 */
function aggregateNote(counts: Map<string, number>, total: number, extraKinds: number): string {
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const shown = sorted.slice(0, AGGREGATE_NOTE_MAX_KINDS).map(([name, count]) => `${name} × ${count}`);
  const hidden = sorted.length - shown.length + extraKinds;
  if (hidden > 0) shown.push(`+${hidden} more kinds`);
  const calls = total === 1 ? 'call' : 'calls';
  return `${AGGREGATE_NOTE_PREFIX} Placeholder for ${total} collapsed tool ${calls} ${AGGREGATE_NOTE_KINDS_MARKER}${shown.join(', ')}${AGGREGATE_NOTE_KINDS_END}; re-run or re-read if needed.`;
}

function findLatestUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isConversationUserMessage(messages[index]!)) return index;
  }
  return -1;
}

function protectedRecentStart(messages: Message[], options: CompactOptions): number {
  let start = messages.length;
  if (Number.isFinite(options.preserveRecentMessages) && options.preserveRecentMessages! > 0) {
    start = Math.max(0, messages.length - Math.ceil(options.preserveRecentMessages!));
  }
  if (Number.isFinite(options.preserveRecentRounds) && options.preserveRecentRounds! > 0) {
    const rounds = groupMessagesByRound(messages);
    start = Math.min(start, rounds[Math.max(0, rounds.length - Math.ceil(options.preserveRecentRounds!))]?.start ?? 0);
  }
  return adjustStartForToolPairs(messages, start);
}

function countChangedMessages(before: Message[], after: Message[]): number {
  let changed = Math.abs(before.length - after.length);
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    if (stringifyValue(before[index]) !== stringifyValue(after[index])) changed++;
  }
  return changed;
}

type PruneOptions = { maxStringChars: number; placeholder?: string; mode: 'old' | 'kept' };

function imagePlaceholder(): TextContent {
  return { type: 'text', text: '[image omitted during compact]' };
}

/** 签名绑定原始块/响应。只要改写 assistant，就不能再重放其签名或 response id。 */
function rewrittenAssistant(message: AssistantMessage, content: AssistantMessage['content']): AssistantMessage {
  const next = { ...message, content: content.map((block) => {
    if (block.type === 'text') {
      const { textSignature: _signature, ...text } = block;
      return text;
    }
    if (block.type === 'thinking') {
      const { thinkingSignature: _signature, redacted: _redacted, ...thinking } = block;
      return thinking;
    }
    const { thoughtSignature: _signature, ...call } = block;
    return call;
  }) };
  delete next.responseId;
  return next;
}

function pruneMessage(message: Message, options: PruneOptions): Message {
  const pruneText = (text: string): string => options.mode === 'old'
    ? pruneOldString(text, options.maxStringChars) : pruneString(text, options.maxStringChars);
  if (message.role === 'assistant') {
    const content: AssistantMessage['content'] = [];
    for (const block of message.content) {
      if (block.type === 'thinking') continue;
      if (block.type === 'toolCall') {
        const replaceArguments = options.mode === 'old' || stringifyValue(block.arguments).length > options.maxStringChars;
        if (replaceArguments && stringifyValue(block.arguments) !== stringifyValue(TOOL_ARGUMENTS_PLACEHOLDER)) {
          const { argumentsError: _error, ...call } = block;
          content.push({ ...call, arguments: { ...TOOL_ARGUMENTS_PLACEHOLDER } });
        } else {
          content.push(block);
        }
      } else {
        const text = pruneText(block.text);
        content.push(text === block.text ? block : { ...block, text });
      }
    }
    return content.length === message.content.length && content.every((block, index) => block === message.content[index])
      ? message : rewrittenAssistant(message, content);
  }
  if (message.role === 'toolResult') {
    return { ...message, content: options.mode === 'old'
      ? [{ type: 'text', text: options.placeholder ?? TOOL_RESULT_PLACEHOLDER }]
      : message.content.map((block) => block.type === 'image' ? imagePlaceholder() : { ...block, text: pruneText(block.text) }) };
  }
  if (typeof message.content === 'string') {
    const content = pruneText(message.content);
    return content === message.content ? message : { ...message, content };
  }
  const content = message.content.map((block) => block.type === 'image' ? imagePlaceholder() : { ...block, text: pruneText(block.text) });
  return { ...message, content };
}

function pruneOldString(value: string, maxChars: number): string {
  if (isDataUrl(value)) return `[omitted data url: ${value.length} chars]`;
  if (shouldOmitBase64String(value)) return `[omitted base64 data: ${value.length} chars]`;
  return pruneString(value, maxChars);
}

function isDataUrl(value: string): boolean {
  return /^data:[^;,]+;base64,/i.test(value);
}

function shouldOmitBase64String(value: string): boolean {
  if (value.length < 512) return false;
  if (isDataUrl(value)) return true;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function usageRatio(tokens: number, contextWindowSize: number | undefined): number | undefined {
  if (!contextWindowSize || contextWindowSize <= 0) return undefined;
  return tokens / contextWindowSize;
}

function compactKeptMessages(
  messages: Message[],
  options: CompactOptions,
  tokenBudget = getRecentTokenBudget(options),
): Message[] {
  const budget = Math.max(1, tokenBudget);
  const latestUserIndex = options.preserveLatestUserMessage ? findLatestUserIndex(messages) : -1;
  const prune = (message: Message, index: number, maxStringChars: number): Message => index === latestUserIndex
    ? message : pruneMessage(message, { maxStringChars, mode: 'kept' });
  const sanitized = messages.map((message, index) => prune(message, index, Number.MAX_SAFE_INTEGER));
  if (estimateMessagesTokens(sanitized) <= budget) return sanitized;

  for (const maxStringChars of options.aggressive ? [6_000, 2_000, 800] : [12_000, 4_000, 1_200]) {
    const compacted = sanitized.map((message, index) => prune(message, index, maxStringChars));
    if (estimateMessagesTokens(compacted) <= Math.ceil(budget * 1.25) || maxStringChars <= 1_200) {
      return compacted;
    }
  }
  return sanitized;
}

function pruneString(value: string, maxChars: number): string {
  if (value.startsWith(COMPACT_SUMMARY_PREFIX) || value.startsWith(COMPACT_BOUNDARY_PREFIX)) return value;
  if (value.length <= maxChars) return value;
  return headSignalsTail(value, maxChars);
}

function groupMessagesByRound(messages: Message[]): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (isConversationUserMessage(messages[index])) starts.push(index);
  }
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);

  const rounds: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]!;
    const end = starts[index + 1] ?? messages.length;
    if (start < end) rounds.push({ start, end });
  }
  return rounds;
}

function isConversationUserMessage(message: Message): boolean {
  return message.role === 'user' && !isCompactBoundary(message) && !isCompactSummary(message);
}

type TranscriptToolCall = { id: string; name: string; detail: string; files: string[] };
type TranscriptToolResult = { name: string; text: string };

/** 一轮对话：用户说了什么、模型怎么回的、调了哪些工具、结果是什么。 */
type TranscriptTurn = {
  user: string[];
  model: string[];
  thinking: string[];
  calls: TranscriptToolCall[];
  results: TranscriptToolResult[];
};

/**
 * 把一段 provider 历史摊成摘要请求要用的正文。导出给测试与压缩前后对比使用；生产路径
 * 只用 `compact()`。
 *
 * `dialogueOnly` 只留用户与助手的对话（外加之前的 checkpoint 摘要），工具调用、工具结果
 * 与思考一概不进——手动「模型压缩」要的是对话本身，过程占了九成篇幅却几乎不进摘要结论。
 */
export function buildTranscript(messages: Message[], options: { dialogueOnly?: boolean } = {}): string {
  const dialogueOnly = options.dialogueOnly === true;
  const summaries: string[] = [];
  const turns: TranscriptTurn[] = [];
  let turn: TranscriptTurn | null = null;
  const openTurn = (): TranscriptTurn => {
    const next: TranscriptTurn = { user: [], model: [], thinking: [], calls: [], results: [] };
    turns.push(next);
    return next;
  };
  const currentTurn = (): TranscriptTurn => turn ?? (turn = openTurn());

  for (const message of messages) {
    if (isCompactBoundary(message)) continue;
    if (isCompactSummary(message)) {
      summaries.push(headSignalsTail(stripCompactSummaryHeader(getStringContent(message)), MAX_SUMMARY_TRANSCRIPT_CHARS));
      turn = null;
      continue;
    }
    if (message.role === 'system') continue;
    if (message.role === 'toolResult') {
      if (!dialogueOnly) {
        const text = transcriptText(message).trim();
        if (text) currentTurn().results.push({ name: message.toolName, text: message.isError ? `[error] ${text}` : text });
      }
      continue;
    }
    const text = transcriptText(message).trim();
    if (message.role === 'user') {
      turn = openTurn();
      if (text) turn.user.push(headSignalsTail(text, TRANSCRIPT_USER_CHARS));
      continue;
    }
    const target = currentTurn();
    if (!dialogueOnly) {
      for (const block of message.content) {
        if (block.type === 'thinking' && block.thinking.trim()) {
          target.thinking.push(headSignalsTail(block.thinking, TRANSCRIPT_THINKING_CHARS));
        } else if (block.type === 'toolCall') {
          target.calls.push({ id: block.id, name: block.name, ...summarizeToolCall(block.arguments) });
        }
      }
    }
    if (text) target.model.push(headSignalsTail(text, TRANSCRIPT_MODEL_CHARS));
  }

  return renderTranscript(summaries, turns);
}

function renderTranscript(summaries: string[], turns: TranscriptTurn[]): string {
  const blocks: string[] = [];
  if (summaries.length > 0) blocks.push(`## 之前的压缩摘要\n${summaries.join('\n\n')}`);
  turns.forEach((turn, index) => {
    const lines: string[] = [`## 轮次 ${index + 1}`];
    for (const message of turn.user) lines.push(`用户：${message}`);
    // 先思考再正文：这才是模型实际的动作顺序。
    if (turn.thinking.length > 0) lines.push(`思考：\n${turn.thinking.join('\n')}`);
    if (turn.model.length > 0) lines.push(`模型：\n${turn.model.join('\n\n')}`);
    if (turn.calls.length > 0) lines.push(`工具调用（${turn.calls.length} 次）：\n${renderToolCalls(turn.calls)}`);
    if (turn.results.length > 0) lines.push(`工具结果：\n${renderToolResults(turn.results)}`);
    blocks.push(lines.join('\n\n'));
  });
  return blocks.join('\n\n');
}

/** 同类工具折成一行：`- read_file ×3: path: a.ts / path: b.ts …`。 */
function renderToolCalls(calls: TranscriptToolCall[]): string {
  const groups = groupByToolName(calls.map((call) => [call.name, call.detail] as const));
  return [...groups.entries()]
    .map(([name, details]) => {
      const shown = details.slice(0, TRANSCRIPT_SAME_TOOL_CALLS);
      const rest = details.length - shown.length;
      // 只显示前几次调用，但每次调用的文件全部保留：摘要里「改了哪些文件」靠它。
      const files = uniqueResultPaths(
        calls.filter((call) => call.name === name).flatMap((call) => call.files),
        TRANSCRIPT_TOOL_CALL_FILES,
      );
      return [
        `- ${name} ×${details.length}: ${shown.join(' / ')}${rest > 0 ? ` …+${rest}` : ''}`,
        ...(files.length > 0 ? [`    涉及文件：${files.join(', ')}`] : []),
      ].join('\n');
    })
    .join('\n');
}

/** 同类工具的结果排在一起，单条结果按 head/signals/tail 限长。 */
function renderToolResults(results: TranscriptToolResult[]): string {
  const groups = groupByToolName(results.map((result) => [result.name, result.text] as const));
  return [...groups.entries()]
    .map(([name, texts]) => {
      const shown = texts.slice(0, TRANSCRIPT_SAME_TOOL_RESULTS);
      const body = shown
        .map((text) => indentLines(headSignalsTail(text, TRANSCRIPT_TOOL_RESULT_CHARS), '  - ', '    '))
        .join('\n');
      const rest = texts.length - shown.length;
      const files = uniqueResultPaths(texts);
      return [
        `- ${name} ×${texts.length}:`,
        ...(files.length > 0 ? [`    涉及文件：${files.join(', ')}`] : []),
        body,
        ...(rest > 0 ? [`    另有 ${rest} 条同类结果已省略`] : []),
      ].join('\n');
    })
    .join('\n');
}

/** 去重、剔掉依赖/产物目录、按出现顺序取前若干条路径。 */
function uniqueResultPaths(texts: string[], limit = TRANSCRIPT_RESULT_PATHS): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const match of text.match(TRANSCRIPT_RESULT_PATH_PATTERN) ?? []) {
      const value = match.replace(/^\.\//, '');
      if (TRANSCRIPT_PATH_NOISE.test(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      paths.push(value);
      if (paths.length >= limit) return paths;
    }
  }
  return paths;
}

function groupByToolName(entries: ReadonlyArray<readonly [string, string]>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [name, detail] of entries) {
    const list = groups.get(name);
    if (list) list.push(detail);
    else groups.set(name, [detail]);
  }
  return groups;
}

function indentLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, index) => `${index === 0 ? first : rest}${line}`)
    .join('\n');
}

/** 一条消息里的正文：只算真正的文本块，图片压成一行占位。 */
function transcriptText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((block) => block.type === 'text' ? block.text : block.type === 'image' ? '[图片]' : '').filter(Boolean).join('\n');
}

/**
 * 参数只留指向性的一行（`path: packages/x.ts`、`command: npm test`），
 * 同时把参数里出现的文件单独收集起来——同一工具跑十几次时，正文只显示前几次，
 * 但「一共碰了哪些文件」必须完整。
 */
function summarizeToolCall(value: ToolCall['arguments']): { detail: string; files: string[] } {
  // 参数可能是空 / 规范化后变成 undefined（`JSON.stringify(undefined)` 返回 undefined），
  // 那种调用只是「这个工具没传参」，正文留空即可。
  const raw = stringifyValue(value);
  const patchText = Object.values(value).filter((item) => typeof item === 'string').join('\n');
  const files = uniqueResultPaths([raw]);
  // apply_patch 的正文里第一行就是「改了哪些文件」，比截断后的前 200 字符有用得多。
  const patched = [...patchText.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) =>
    match[1]!.trim(),
  );
  if (patched.length > 0) {
    const shown = patched.slice(0, 6);
    return {
      detail: `files: ${shown.join(', ')}${patched.length > shown.length ? ` …+${patched.length - shown.length}` : ''}`,
      files: uniqueResultPaths([...patched, ...files]),
    };
  }

  const parsed = value;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    for (const key of TRANSCRIPT_ARGUMENT_HINTS) {
      const hint = record[key];
      if (typeof hint === 'string' && hint.trim()) {
        return { detail: `${key}: ${clipTranscriptLine(hint, TRANSCRIPT_TOOL_ARGUMENT_CHARS)}`, files };
      }
    }
    for (const [key, hint] of Object.entries(record)) {
      if (typeof hint === 'string' && hint.trim()) {
        return { detail: `${key}: ${clipTranscriptLine(hint, TRANSCRIPT_TOOL_ARGUMENT_CHARS)}`, files };
      }
    }
    return { detail: clipTranscriptLine(JSON.stringify(record), TRANSCRIPT_TOOL_ARGUMENT_CHARS), files };
  }
  return { detail: clipTranscriptLine(raw, TRANSCRIPT_TOOL_ARGUMENT_CHARS), files };
}

function clipTranscriptLine(text: string, maxChars: number): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length <= maxChars ? folded : `${folded.slice(0, maxChars)}…`;
}

/** checkpoint 正文开头的英文说明是给模型看的固定模板，摘要模型不需要再读一遍。 */
function stripCompactSummaryHeader(text: string): string {
  return text
    .slice(COMPACT_SUMMARY_PREFIX.length)
    .replace(/^\s*This session is being continued from a previous conversation\.[^\n]*\n?/i, '')
    .trim();
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createCompactBoundaryMessage(metadata: Record<string, unknown>) {
  return createUserTextMessage(
    `${COMPACT_BOUNDARY_PREFIX}\n\n${JSON.stringify({ ...metadata, createdAt: new Date().toISOString() })}`,
  );
}

function createCompactSummaryMessage(summary: string, recentMessagesRetained: boolean) {
  const recentNote = recentMessagesRetained
    ? '\n\nRecent messages are retained after this checkpoint, with bulky payloads and tool results pruned when needed.'
    : '';
  const coverage = recentMessagesRetained ? 'the earlier portion of the conversation' : 'the compacted conversation';
  return createUserTextMessage(
    `${COMPACT_SUMMARY_PREFIX}\n\nThis session is being continued from a previous conversation. The summary below covers ${coverage}.\n\n${summary}${recentNote}`,
  );
}

function createUserTextMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function findLastCompactBoundaryIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isCompactBoundary(messages[index])) return index;
  }
  return -1;
}

function isCompactBoundary(message: Message): boolean {
  return getStringContent(message).startsWith(COMPACT_BOUNDARY_PREFIX);
}

function isCompactSummary(message: Message): boolean {
  return getStringContent(message).startsWith(COMPACT_SUMMARY_PREFIX);
}

function getStringContent(message: Message | undefined): string {
  return message ? contentText(message.content) : '';
}

function estimateMessagesTokens(messages: Message[]): number {
  return estimateContextTokens(messages);
}

function estimateTokens(text: string): number {
  return estimateTextTokens(text);
}

function cleanSummary(summary: string): string {
  const withoutFences = summary
    .replace(/^```(?:markdown)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const withoutAnalysis = withoutFences.replace(/<analysis>[\s\S]*?<\/analysis>/i, '').trim();
  const match = /<summary>([\s\S]*?)<\/summary>/i.exec(withoutAnalysis);
  const body = match?.[1]?.trim() || withoutAnalysis.replace(/<\/?summary>/gi, '').trim();
  if (!body) return '';
  return ensureSections(body);
}

function ensureSections(summary: string): string {
  const required = [
    'Primary Request and Intent',
    'Key Technical Concepts',
    'Files and Code Sections',
    'User Constraints and Preferences',
    'Tool Results and Evidence',
    'Errors and Fixes',
    'Validation',
    'Pending Tasks',
    'Current Work',
    'Immediate Next Step',
  ];
  let next = summary;
  for (const section of required) {
    if (!new RegExp(`(^|\\n)#{1,3}\\s*${escapeRegExp(section)}\\s*:?`, 'i').test(next)) {
      next += `\n\n## ${section}\n- Not recorded.`;
    }
  }
  return next.trim();
}

function headSignalsTail(text: string, maxChars: number): string {
  const folded = foldRepeats(text);
  if (folded.length <= maxChars) return folded;
  const lines = folded.split('\n');
  const signalLines = lines.filter((line) =>
    /error|failed|failure|exception|traceback|stack|exit code|ts\(\d+\)|\.(ts|tsx|js|jsx):\d+/i.test(line),
  );
  const head = folded.slice(0, Math.floor(maxChars * 0.45));
  const tail = folded.slice(-Math.floor(maxChars * 0.35));
  // 信号行只留 head/tail 里看不到的：压缩成一行的结果整行都以 head 为开头，
  // 逐字符判断包含关系永远为假，取开头一段做探针才认得出「已经看过了」。
  const alreadyShown = (line: string) => {
    const probe = line.trim().slice(0, 60);
    return !probe || head.includes(probe) || tail.includes(probe);
  };
  const signals = signalLines
    .slice(0, 80)
    .filter((line) => !alreadyShown(line))
    .map((line) => clipTranscriptLine(line, TRANSCRIPT_SIGNAL_LINE_CHARS))
    .join('\n');
  return [
    `[truncated: original ${folded.length} chars, kept about ${maxChars} chars]`,
    '--- head ---',
    head,
    '--- signals ---',
    signals || '(none)',
    '--- tail ---',
    tail,
  ].join('\n');
}

function foldRepeats(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let previous = '';
  let repeatCount = 0;
  for (const line of lines) {
    if (line === previous) {
      repeatCount++;
      continue;
    }
    if (repeatCount > 0) {
      result.push(`[previous line repeated ${repeatCount} times]`);
    }
    result.push(line);
    previous = line;
    repeatCount = 0;
  }
  if (repeatCount > 0) result.push(`[previous line repeated ${repeatCount} times]`);
  return result.join('\n');
}

function truncateHeadForPromptTooLongRetry(messages: Message[]): Message[] {
  const input = stripPromptTooLongRetryMarker(messages);
  const protectedSummaries = input.filter(isCompactSummary);
  const ordinaryMessages = input.filter((message) => !isCompactSummary(message));
  const rounds = groupMessagesByRound(ordinaryMessages);
  if (rounds.length < 2) {
    return [
      createUserTextMessage('[earlier conversation truncated for compaction retry]'),
      ...protectedSummaries,
      ...ordinaryMessages,
    ];
  }
  const dropRounds = Math.min(rounds.length - 1, Math.max(1, Math.ceil(rounds.length * RETRY_DROP_RATIO)));
  const start = rounds[dropRounds]?.start ?? ordinaryMessages.length;
  return [
    createUserTextMessage('[earlier conversation truncated for compaction retry]'),
    ...protectedSummaries,
    ...ordinaryMessages.slice(start),
  ];
}

function stripPromptTooLongRetryMarker(messages: Message[]): Message[] {
  const [first] = messages;
  return getStringContent(first) === '[earlier conversation truncated for compaction retry]'
    ? messages.slice(1)
    : messages;
}

function isPromptTooLongError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /prompt.*too.*long|context.*length|maximum context|input.*too.*large|tokens.*exceed/i.test(message);
}

function looksLikePromptTooLongResponse(summary: string): boolean {
  return /prompt.*too.*long|context.*length|maximum context|input.*too.*large|tokens.*exceed/i.test(
    summary.slice(0, 500),
  );
}

function getCompactPrompt(customInstructions?: string): string {
  return [
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    '',
    '- You already have all the context you need in the transcript.',
    '- Tool calls will be rejected and will waste your only turn.',
    '- Your response must contain an <analysis> block followed by a <summary> block.',
    '- The <analysis> block is only for drafting and will be discarded.',
    '',
    'Create a detailed compact checkpoint for a coding-agent conversation.',
    'Use only facts visible in the transcript. Do not infer hidden intent.',
    'Preserve concrete paths, commands, validation output, errors, user corrections, code symbols, and exact next actions.',
    '',
    'The <summary> block must include these markdown sections:',
    '## Primary Request and Intent',
    '## Key Technical Concepts',
    '## Files and Code Sections',
    '## User Constraints and Preferences',
    '## Tool Results and Evidence',
    '## Errors and Fixes',
    '## Validation',
    '## Pending Tasks',
    '## Current Work',
    '## Immediate Next Step',
    customInstructions?.trim() ? `\nAdditional Instructions:\n${customInstructions.trim()}` : '',
    '',
    'REMINDER: Do NOT call tools. Return plain text only: <analysis>...</analysis><summary>...</summary>.',
  ]
    .filter(Boolean)
    .join('\n');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

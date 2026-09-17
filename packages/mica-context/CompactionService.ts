export const COMPACT_SUMMARY_PREFIX = '[Mica compact checkpoint]';
export const COMPACT_BOUNDARY_PREFIX = '[Mica compact boundary]';

const DEFAULT_MIN_MESSAGES = 4;
const MAX_MESSAGE_TRANSCRIPT_CHARS = 8_000;
const MAX_SUMMARY_TRANSCRIPT_CHARS = 16_000;
const RETRY_DROP_RATIO = 0.2;
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
const TOOL_ARGUMENTS_PLACEHOLDER = '{"_truncated":true,"note":"tool arguments cleared during compact"}';
// ── 工具调用参数的语义化裁剪（快速压缩） ────────────────────────────────
// 工具结果被换成占位符后，「这次调用到底做了什么」就只剩参数在承载。
// 参数里真正吃上下文的是「正文型」字段（写文件的正文、patch、内联脚本），
// 而「指向性」字段（路径 / pattern / name）极小却决定了这次调用的意义。
// 所以按字段语义保留指向性摘要、丢掉正文，而不是按长度一刀切。
/** 正文型字段名：值是内容本身，历史里没有复用价值。 */
const TOOL_ARGUMENT_CONTENT_FIELDS = new Set([
  'content',
  'body',
  'patch',
  'code',
  'text',
  'file_content',
  'file_text',
  'source_code',
  'new_string',
  'old_string',
  'new_str',
  'old_str',
  'new_text',
  'old_text',
]);
/** 命令型字段：本身就是「这次调用做了什么」，只有长到像内联脚本时才摘要。 */
const TOOL_ARGUMENT_COMMAND_FIELDS = new Set(['command', 'cmd', 'script']);
/**
 * 参数值不超过该长度时原样保留。正文与命令分两档：命令 p90 只有约 300 字符，
 * 按 200 会把「cd x && node script」这种完整命令也摘要掉，反而丢掉关键信息。
 */
const TOOL_ARGUMENT_KEEP_CHARS = 200;
const TOOL_ARGUMENT_COMMAND_KEEP_CHARS = 400;
/** 摘要前缀；同时是幂等标记，第二次快速压缩不会再动已裁剪过的值。 */
const TOOL_ARGUMENT_OMIT_PREFIX = '[omitted ';
/** apply_patch 正文里的文件声明行（用于把 patch 还原成「改了哪些文件」）。 */
const PATCH_FILE_LINE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/;
// 快速压缩（prune-only）找不到单条消息内可清理内容时，允许本地丢弃最早轮次。
// 只有节省量达到这两个下限之一才丢弃，避免把内容本来就不多的小会话也删掉。
const MIN_LOCAL_ROUND_DROP_SAVED_TOKENS = 8_000;
const MIN_LOCAL_ROUND_DROP_SAVED_RATIO = 0.05;

export type CompactInput = {
  messages: unknown[];
  summarize(transcript: string, prompt: string): Promise<string>;
  options?: CompactOptions;
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
  /** 只把工具结果替换为占位符：不生成 checkpoint、不丢轮次、不调用模型（可重复执行）。 */
  toolResultsOnly?: boolean;
  /**
   * 快速压缩时顺带把工具调用参数的正文型字段换成指向性摘要（默认开启）。
   * 设为 false 可退回「只清工具结果、参数一字不动」的旧行为。
   */
  trimToolArguments?: boolean;
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
};

export type CompactResult = {
  messages: unknown[];
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
  /** toolResultsOnly：被替换掉工具结果的消息数。 */
  toolResultsReplaced?: number;
  /** toolResultsOnly：被丢弃的失效 Responses reasoning 条目数。 */
  reasoningItemsDropped?: number;
  /** toolResultsOnly：被裁剪掉正文的工具调用数（其 arguments 换成了指向性摘要）。 */
  toolArgumentsTrimmed?: number;
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
    const originalMessages = input.messages;
    const beforeCount = originalMessages.length;
    const options = input.options ?? {};
    // 快速压缩（/compact）：只把工具结果替换为占位符。消息条数、顺序、文本与
    // 工具参数都保持不变，不生成 boundary/summary、不丢轮次、不调用模型，所以
    // 连续执行不会丢失对话信息（没有可替换内容时报 not needed）。
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
    if (!options.lightweightPrune && groupMessagesByRound(activeMessages).length < 2) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    const beforeTokenEstimate = estimateMessagesTokens(originalMessages);
    const userMessageTemplate = findUserMessageTemplate(activeMessages) ?? findUserMessageTemplate(originalMessages);
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
        userMessageTemplate,
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
        userMessageTemplate,
        pruneOnlyThresholdRatio,
        targetContextRatio,
      });
      if (roundDrop) return roundDrop;
      throw new CompactionNotNeededError('当前会话没有可本地清理的内容，暂不需要快速压缩');
    }

    if (groupMessagesByRound(activeMessages).length < 2) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    let splitIndex = chooseRecentStartIndex(activeMessages, compactedActiveMessages, options);
    splitIndex = adjustStartForToolPairs(activeMessages, splitIndex);
    if (splitIndex <= 0 && options.force) {
      splitIndex = chooseForcedRecentStartIndex(activeMessages, compactedActiveMessages, options);
      splitIndex = adjustStartForToolPairs(activeMessages, splitIndex);
    }

    let messagesToSummarize = compactedActiveMessages.slice(0, splitIndex);
    let keptMessages = compactedActiveMessages.slice(splitIndex);
    if (messagesToSummarize.length === 0 && options.force) {
      messagesToSummarize = compactedActiveMessages;
      keptMessages = [];
    }
    if (messagesToSummarize.length === 0) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    let summarizedMessageCount = messagesToSummarize.length;
    messagesToSummarize = fitMessagesToSummaryBudget(messagesToSummarize, getSummaryInputTokenBudget(options));
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
      );
      const nextPayload = stringifyValue(stripPromptTooLongRetryMarker(nextMessages));
      if (nextPayload === previousPayload) throw new CompactionPromptTooLongError();
      messagesToSummarize = nextMessages;
    };

    const summarizeCurrentMessages = async (): Promise<void> => {
      for (;;) {
        const transcript = buildTranscript(messagesToSummarize);
        summaryInputTokenEstimate = estimateTokens(transcript);
        try {
          summary = cleanSummary(await input.summarize(transcript, prompt));
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

    let finalKeptMessages = compactKeptMessages(keptMessages, options, getRecentTokenBudget(options));
    const initialKeptRounds = groupMessagesByRound(finalKeptMessages).length;
    let reducedRecentRounds = 0;
    let strategy: CompactStrategy = finalKeptMessages.length > 0 ? 'summary_with_recent' : 'summary_only_fallback';

    while (finalKeptMessages.length > 0) {
      const candidateMessages = buildSummarizedMessages(
        summary,
        finalKeptMessages,
        userMessageTemplate,
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
      summarizedMessageCount += movedToSummary.length;
      messagesToSummarize = fitMessagesToSummaryBudget(
        [createCompactSummaryMessage(summary, true, userMessageTemplate), ...movedToSummary],
        getSummaryInputTokenBudget(options),
      );
      finalKeptMessages = compactKeptMessages(
        nextKeptMessages,
        options,
        Math.floor(getRecentTokenBudget(options) * 0.75),
      );
      const nextKeptRounds = groupMessagesByRound(finalKeptMessages).length;
      reducedRecentRounds = Math.max(reducedRecentRounds, Math.max(0, initialKeptRounds - nextKeptRounds));
      strategy = finalKeptMessages.length > 0 ? 'summary_with_recent' : 'summary_only_fallback';
      await summarizeCurrentMessages();
    }

    if (finalKeptMessages.length === 0) {
      strategy = 'summary_only_fallback';
      reducedRecentRounds = Math.max(reducedRecentRounds, initialKeptRounds);
    }

    const summaryMessage = createCompactSummaryMessage(summary, finalKeptMessages.length > 0, userMessageTemplate);
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
      userMessageTemplate,
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

function chooseRecentStartIndex(messages: unknown[], compactedMessages: unknown[], options: CompactOptions): number {
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
  messages: unknown[],
  compactedMessages: unknown[],
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

function fitMessagesToSummaryBudget(messages: unknown[], tokenBudget: number): unknown[] {
  let next = messages;
  while (next.length > 1 && estimateTokens(buildTranscript(next)) > tokenBudget) {
    const before = stringifyValue(next);
    const truncated = truncateHeadForPromptTooLongRetry(next);
    next = truncated;
    if (stringifyValue(truncated) === before) break;
  }
  return next;
}

function dropOldestRecentRound(messages: unknown[]): unknown[] {
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
  messages: unknown[];
  compactedMessages: unknown[];
  previewMessages: unknown[];
  options: CompactOptions;
  beforeCount: number;
  beforeTokenEstimate: number;
  boundaryIndex: number;
  budget: CompactBudget;
  userMessageTemplate: unknown;
  pruneOnlyThresholdRatio: number;
  targetContextRatio: number;
}): CompactResult | null {
  if (groupMessagesByRound(params.messages).length < 2) return null;

  let splitIndex = chooseRecentStartIndex(params.messages, params.compactedMessages, params.options);
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
    params.userMessageTemplate,
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
  keptMessages: unknown[],
  template: unknown,
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
): unknown[] {
  const summaryMessage = createCompactSummaryMessage(summary, keptMessages.length > 0, template);
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
    template,
  );
  return [boundaryMessage, summaryMessage, ...keptMessages];
}

function adjustStartForToolPairs(messages: unknown[], start: number): number {
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

function getToolCallIds(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const ids: string[] = [];

  if (Array.isArray(record.tool_calls)) {
    for (const toolCall of record.tool_calls) {
      if (toolCall && typeof toolCall === 'object' && typeof (toolCall as Record<string, unknown>).id === 'string') {
        ids.push((toolCall as Record<string, string>).id);
      }
    }
  }
  if (record.type === 'function_call' && typeof record.call_id === 'string') ids.push(record.call_id);
  for (const block of contentBlocks(record)) {
    if (block.type === 'tool_use' && typeof block.id === 'string') ids.push(block.id);
  }
  return ids;
}

function getToolResultIds(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const ids: string[] = [];

  if (record.role === 'tool' && typeof record.tool_call_id === 'string') ids.push(record.tool_call_id);
  if (record.type === 'function_call_output' && typeof record.call_id === 'string') ids.push(record.call_id);
  for (const block of contentBlocks(record)) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') ids.push(block.tool_use_id);
  }
  return ids;
}

function contentBlocks(record: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(record.content)
    ? record.content.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object'))
    : [];
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

function compactMessagesForCheckpoint(messages: unknown[], options: CompactOptions): unknown[] {
  const placeholder = options.toolResultPlaceholder ?? TOOL_RESULT_PLACEHOLDER;
  return messages.map((message) =>
    pruneValue(message, { maxStringChars: OLD_MESSAGE_STRING_CHARS, placeholder, mode: 'old' }),
  );
}

// 快速压缩（/compact）唯一的动作：把工具结果替换为占位符。媒体、base64、
// 用户与助手文本一律原样保留，也不插入 boundary/summary 消息，因此它不重写
// 对话内容，只是把不再需要的大块工具输出腾出来。工具调用参数一并按字段语义
// 裁剪（正文型字段换成指向性摘要，见 trimToolArguments）——工具结果都被清掉后，
// 保留写入正文既没有复用价值又是压缩后剩下的最大一块。
function compactToolResultsOnly(messages: unknown[], options: CompactOptions): CompactResult {
  const placeholder = options.toolResultPlaceholder ?? TOOL_RESULT_PLACEHOLDER;
  const trimArguments = options.trimToolArguments !== false;
  let replacedMessages = 0;
  let droppedReasoningItems = 0;
  let trimmedArguments = 0;
  const compactedMessages: unknown[] = [];
  for (const message of messages) {
    // 这条路径会剥掉 encrypted_content，reasoning 条目随之永久失效：ResponsesClient
    // 发送请求与恢复快照时都会丢弃没有 encrypted_content 的 reasoning item
    // （stripUnusableResponseInputItems），所以留着它既不会被发送也不会被落盘，
    // 只会让 afterTokenEstimate（以及界面上的 ctx）虚高。
    if (isStaleReasoningItem(message)) {
      droppedReasoningItems++;
      continue;
    }
    const counter = { replaced: 0 };
    let next = pruneToolResultPayload(message, placeholder, counter);
    if (trimArguments) {
      const argumentCounter = { trimmed: 0 };
      next = trimToolArguments(next, argumentCounter);
      trimmedArguments += argumentCounter.trimmed;
    }
    if (counter.replaced > 0) replacedMessages++;
    compactedMessages.push(next);
  }
  if (replacedMessages === 0 && droppedReasoningItems === 0 && trimmedArguments === 0) {
    throw new CompactionNotNeededError('当前会话没有可清理的工具结果或工具参数，暂不需要快速压缩');
  }

  const beforeTokenEstimate = estimateMessagesTokens(messages);
  const afterTokenEstimate = estimateMessagesTokens(compactedMessages);
  const savedTokenEstimate = Math.max(0, beforeTokenEstimate - afterTokenEstimate);
  const contextWindowSize = positiveNumber(options.contextWindowSize);
  return {
    messages: options.preview ? cloneJson(messages) : compactedMessages,
    summary:
      'Tool results replaced and stale Responses reasoning items dropped; no message was summarized or rewritten.',
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
    toolResultsReplaced: replacedMessages,
    reasoningItemsDropped: droppedReasoningItems,
    toolArgumentsTrimmed: trimmedArguments,
  };
}

// 找出消息里所有工具调用的 arguments 并做语义化裁剪。Responses 的
// function_call 是 `{ name, arguments }`，Chat Completions 的 tool_calls 条目是
// `{ function: { name, arguments } }`——两条路径的 arguments 都与 name 同级，
// 所以这里按 `arguments` 键递归即可，不需要额外定位工具名。
function trimToolArguments(value: unknown, counter: { trimmed: number }): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const trimmed = trimToolArguments(item, counter);
      if (trimmed !== item) changed = true;
      return trimmed;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'arguments' && typeof child === 'string') {
      const trimmed = trimArgumentJson(child);
      if (trimmed !== child) {
        changed = true;
        counter.trimmed++;
      }
      next[key] = trimmed;
      continue;
    }
    const trimmed = trimToolArguments(child, counter);
    if (trimmed !== child) changed = true;
    next[key] = trimmed;
  }
  return changed ? next : value;
}

// arguments 必须是合法 JSON 字符串（provider 硬约束），所以裁剪后重新 stringify
// 保证协议安全。解析失败说明格式异常，原样保留比整体替换安全——用户要的是
// 「关键信息还在」，而不是把不确定的内容一并抹掉。
function trimArgumentJson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return raw;
  const counter = { changed: 0 };
  const next = trimArgumentFields(parsed as Record<string, unknown>, counter);
  if (counter.changed === 0) return raw;
  return JSON.stringify(next);
}

// 只动正文型字段：其它字段（路径 / pattern / name / offset…）无论长短都是这次
// 调用的指向性信息，必须原样保留。未改动时返回原对象引用。
function isTrimmableArgumentField(key: string): boolean {
  return TOOL_ARGUMENT_CONTENT_FIELDS.has(key) || TOOL_ARGUMENT_COMMAND_FIELDS.has(key);
}

function trimArgumentFields(record: Record<string, unknown>, counter: { changed: number }): Record<string, unknown> {
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && isTrimmableArgumentField(key) && !value.startsWith(TOOL_ARGUMENT_OMIT_PREFIX)) {
      const limit = TOOL_ARGUMENT_COMMAND_FIELDS.has(key) ? TOOL_ARGUMENT_COMMAND_KEEP_CHARS : TOOL_ARGUMENT_KEEP_CHARS;
      if (value.length <= limit) {
        next[key] = value;
        continue;
      }
      next[key] = summarizeArgumentContent(key, value);
      counter.changed++;
      changed = true;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = trimArgumentFields(value as Record<string, unknown>, counter);
      if (nested !== value) changed = true;
      next[key] = nested;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : record;
}

// 摘要只回答「这次调用做了什么」：patch 说改了哪些文件，命令说跑了哪条命令，
// 其余正文只留尺寸。指向性信息（路径 / 命令首行）才是历史里值得留下的部分。
function summarizeArgumentContent(field: string, value: string): string {
  if (field === 'patch') {
    const files = patchFiles(value);
    if (files.length > 0) {
      const shown = files.slice(0, 5).join(', ');
      const more = files.length > 5 ? `, +${files.length - 5} more` : '';
      return `${TOOL_ARGUMENT_OMIT_PREFIX}${files.length} files: ${shown}${more}]`;
    }
    return `${TOOL_ARGUMENT_OMIT_PREFIX}${value.length} chars]`;
  }
  if (TOOL_ARGUMENT_COMMAND_FIELDS.has(field)) {
    const lines = value.split('\n');
    const head = (lines[0] ?? '').slice(0, 80);
    const suffix = lines.length > 1 ? ` / ${lines.length} lines` : '';
    return `${TOOL_ARGUMENT_OMIT_PREFIX}${value.length} chars${suffix}: ${head}…]`;
  }
  return `${TOOL_ARGUMENT_OMIT_PREFIX}${value.length} chars]`;
}

function patchFiles(patchText: string): string[] {
  const files: string[] = [];
  for (const line of patchText.split('\n')) {
    const match = PATCH_FILE_LINE.exec(line.trim());
    const file = match?.[1]?.trim();
    if (file) files.push(file);
  }
  return files;
}

// 压缩会剥掉 encrypted_content（见 pruneToolResultPayload/pruneValue），Responses 的
// reasoning 条目随即失效。判定与 ResponsesClient 的 stripUnusableResponseInputItems
// 同源：没有 encrypted_content 的 reasoning item 永远上不了线，因此可以整条丢弃。
function isStaleReasoningItem(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  return (item as { type?: unknown }).type === 'reasoning';
}

// 未改动时返回原引用，避免无谓的深拷贝；替换数量记在 counter 上。
function pruneToolResultPayload(value: unknown, placeholder: string, counter: { replaced: number }): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const pruned = pruneToolResultPayload(item, placeholder, counter);
      if (pruned !== item) changed = true;
      return pruned;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    // 与其它压缩路径一致：Responses 的加密推理链绑定压缩前的精确上下文，
    // 工具结果被改写后重放会失效，去掉它让 ResponsesClient 丢弃该 item。
    if (key === 'encrypted_content') {
      changed = true;
      continue;
    }
    if (key === 'toolUseResult' || (isToolResultRecord(record) && (key === 'content' || key === 'output'))) {
      if (child !== placeholder) {
        changed = true;
        counter.replaced++;
      }
      next[key] = placeholder;
      continue;
    }
    const pruned = pruneToolResultPayload(child, placeholder, counter);
    if (pruned !== child) changed = true;
    next[key] = pruned;
  }
  return changed ? next : value;
}

function countChangedMessages(before: unknown[], after: unknown[]): number {
  let changed = Math.abs(before.length - after.length);
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    if (stringifyValue(before[index]) !== stringifyValue(after[index])) changed++;
  }
  return changed;
}

type PruneMode = 'old' | 'kept';

type PruneOptions = {
  maxStringChars: number;
  placeholder?: string;
  mode: PruneMode;
};

function pruneValue(value: unknown, options: PruneOptions): unknown {
  if (typeof value === 'string') {
    return options.mode === 'old'
      ? pruneOldString(value, options.maxStringChars)
      : pruneString(value, options.maxStringChars);
  }
  if (Array.isArray(value)) return value.map((item) => pruneValue(item, options));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const mediaReplacement = mediaPlaceholder(record);
  if (mediaReplacement) return mediaReplacement;

  if (isProtocolSensitiveRecord(record)) {
    return pruneProtocolSensitiveRecord(record, options);
  }

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    // Never carry Responses reasoning ciphertext across a compaction. These
    // payloads are opaque, authenticated ciphertext bound to the exact prior
    // context; prune-only/summarized compact rewrites tool results & media, so
    // replaying a stale chain makes the model stall (reasoning-only turns
    // committed as empty responses). Dropping encrypted_content lets
    // stripUnusableResponseInputItems (ResponsesClient) discard the item on
    // replay, so the model re-reasons cleanly against the compacted context.
    if (key === 'encrypted_content') {
      continue;
    }
    if (key === 'toolUseResult') {
      if (options.mode === 'old') {
        next[key] = options.placeholder ?? TOOL_RESULT_PLACEHOLDER;
      }
      continue;
    }
    if (options.mode === 'old' && isToolResultRecord(record) && (key === 'content' || key === 'output')) {
      next[key] = options.placeholder ?? TOOL_RESULT_PLACEHOLDER;
      continue;
    }
    if (key === 'data' && typeof child === 'string') {
      if (options.mode === 'old' && shouldOmitBase64String(child)) {
        next[key] = `[omitted base64 data: ${child.length} chars]`;
        continue;
      }
      if (options.mode === 'kept' && child.length > options.maxStringChars) {
        next[key] = `[omitted base64 data: ${child.length} chars]`;
        continue;
      }
    }
    // URL fields are schema-bearing values. Known media parts are replaced as a
    // whole by mediaPlaceholder(); unknown URLs must remain valid and exact.
    if ((key === 'url' || key === 'image_url' || key === 'file_url') && typeof child === 'string') {
      next[key] = child;
      continue;
    }
    if (isProtocolSensitiveKey(key)) {
      next[key] = preserveProtocolSensitiveValue(child, options, key);
      continue;
    }
    next[key] = pruneValue(child, options);
  }
  return next;
}

function isProtocolSensitiveRecord(record: Record<string, unknown>): boolean {
  return (
    record.type === 'function_call' ||
    record.type === 'tool_use' ||
    record.type === 'function' ||
    (Array.isArray(record.tool_calls) && (record.role === 'assistant' || record.role === undefined)) ||
    // Chat Completions tool_calls[] entries look like { id, type, function: { name, arguments } }.
    (record.type === 'function' && typeof record.function === 'object') ||
    (typeof record.function === 'object' && record.function !== null && 'arguments' in (record.function as object))
  );
}

function pruneProtocolSensitiveRecord(record: Record<string, unknown>, options: PruneOptions): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'encrypted_content') {
      continue;
    }
    if (key === 'tool_calls' && Array.isArray(child)) {
      next[key] = child.map((item) => pruneValue(item, options));
      continue;
    }
    if (key === 'function') {
      next[key] = preserveProtocolSensitiveValue(child, options, key);
      continue;
    }
    if (isProtocolSensitiveKey(key)) {
      next[key] = preserveProtocolSensitiveValue(child, options, key);
      continue;
    }
    // Keep assistant text/refusal/content structure intact when tool_calls exist,
    // but still allow media placeholders and soft string truncation on free text.
    if (key === 'content' || key === 'refusal') {
      next[key] = pruneValue(child, options);
      continue;
    }
    next[key] = pruneValue(child, options);
  }
  return next;
}

function isProtocolSensitiveKey(key: string): boolean {
  return (
    key === 'arguments' ||
    key === 'input' ||
    key === 'id' ||
    key === 'call_id' ||
    key === 'tool_call_id' ||
    key === 'tool_use_id' ||
    key === 'name' ||
    key === 'type'
  );
}

function preserveProtocolSensitiveValue(value: unknown, options: PruneOptions, key?: string): unknown {
  if (typeof value === 'string') {
    if (key === 'arguments') return preserveToolArguments(value, options);
    // IDs/names/types must stay exact; free-text truncation would break tool pairing.
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => preserveProtocolSensitiveValue(item, options));
  }
  if (!value || typeof value !== 'object') return value;

  // Anthropic tool_use.input is structured JSON. Keep object shape valid; only drop huge leaf strings carefully.
  if (key === 'input') {
    return preserveToolInput(value, options);
  }

  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(record)) {
    if (
      isProtocolSensitiveKey(childKey) ||
      childKey === 'function' ||
      childKey === 'tool_calls' ||
      key === 'function'
    ) {
      next[childKey] = preserveProtocolSensitiveValue(child, options, childKey);
      continue;
    }
    next[childKey] = pruneValue(child, options);
  }
  return next;
}

function preserveToolArguments(value: string, options: PruneOptions): string {
  // Chat Completions / Responses tool-call arguments must remain valid JSON strings.
  // Free-form head/tail truncation makes the next provider request 400.
  // 快速压缩（mode: old）时工具参数也全部替换为合法 JSON 占位符，只保留占位；
  // 其他模式（保留的最近轮次）只截断超长参数，保持工具调用的可读性。
  if (options.mode === 'old') return TOOL_ARGUMENTS_PLACEHOLDER;
  if (isValidJsonText(value)) {
    return value.length <= options.maxStringChars ? value : TOOL_ARGUMENTS_PLACEHOLDER;
  }
  return TOOL_ARGUMENTS_PLACEHOLDER;
}

function preserveToolInput(value: unknown, options: PruneOptions): unknown {
  if (typeof value === 'string') {
    if (isValidJsonText(value)) {
      return value.length <= options.maxStringChars ? value : TOOL_ARGUMENTS_PLACEHOLDER;
    }
    return value.length <= options.maxStringChars ? value : TOOL_ARGUMENTS_PLACEHOLDER;
  }
  if (Array.isArray(value)) return value.map((item) => preserveToolInput(item, options));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(record)) {
    if (typeof child === 'string' && child.length > options.maxStringChars) {
      next[childKey] = `[omitted tool input field: ${child.length} chars]`;
      continue;
    }
    next[childKey] = preserveToolInput(child, options);
  }
  return next;
}

function isValidJsonText(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function mediaPlaceholder(record: Record<string, unknown>): Record<string, unknown> | null {
  if (record.type === 'image') return { type: 'text', text: '[image omitted during compact]' };
  if (record.type === 'document') return { type: 'text', text: '[document omitted during compact]' };
  if (record.type === 'image_url') return { type: 'text', text: '[image omitted during compact]' };
  if (record.type === 'input_image') return { type: 'input_text', text: '[image omitted during compact]' };
  if (record.type === 'file') return { type: 'text', text: '[document omitted during compact]' };
  if (record.type === 'resource') return { type: 'text', text: '[document omitted during compact]' };
  if (record.type === 'input_file') return { type: 'input_text', text: '[document omitted during compact]' };
  return null;
}

function isToolResultRecord(record: Record<string, unknown>): boolean {
  return record.role === 'tool' || record.type === 'tool_result' || record.type === 'function_call_output';
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
  messages: unknown[],
  options: CompactOptions,
  tokenBudget = getRecentTokenBudget(options),
): unknown[] {
  const budget = Math.max(1, tokenBudget);
  const sanitized = messages.map((message) =>
    pruneValue(message, { maxStringChars: Number.MAX_SAFE_INTEGER, mode: 'kept' }),
  );
  if (estimateMessagesTokens(sanitized) <= budget) return sanitized;

  for (const maxStringChars of options.aggressive ? [6_000, 2_000, 800] : [12_000, 4_000, 1_200]) {
    const compacted = sanitized.map((message) => pruneValue(message, { maxStringChars, mode: 'kept' }));
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

function groupMessagesByRound(messages: unknown[]): Array<{ start: number; end: number }> {
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

function isConversationUserMessage(message: unknown): boolean {
  if (getRole(message) !== 'user') return false;
  if (getToolResultIds(message).length > 0) return false;
  return !getStringContent(message).startsWith('Image output from ');
}

function buildTranscript(messages: unknown[]): string {
  return messages
    .map((message, index) => {
      const normalized = normalizeMessage(message);
      const maxChars = isCompactSummary(message) ? MAX_SUMMARY_TRANSCRIPT_CHARS : MAX_MESSAGE_TRANSCRIPT_CHARS;
      return `## Message ${index + 1} - ${normalized.label}\n${headSignalsTail(normalized.text, maxChars)}`;
    })
    .join('\n\n');
}

function normalizeMessage(message: unknown): { label: string; text: string } {
  if (!message || typeof message !== 'object') {
    return { label: 'unknown', text: String(message) };
  }
  const record = message as Record<string, unknown>;
  const role = getRole(message) ?? 'unknown';
  return {
    label: role,
    text: stringifyContent(record),
  };
}

function stringifyContent(record: Record<string, unknown>): string {
  const parts: string[] = [];
  if ('content' in record) {
    parts.push(`content:\n${stringifyValue(record.content)}`);
  }
  if ('tool_calls' in record) {
    parts.push(`tool_calls:\n${stringifyValue(record.tool_calls)}`);
  }
  if ('name' in record) {
    parts.push(`name: ${String(record.name)}`);
  }
  if ('tool_call_id' in record) {
    parts.push(`tool_call_id: ${String(record.tool_call_id)}`);
  }
  if ('call_id' in record) {
    parts.push(`call_id: ${String(record.call_id)}`);
  }
  if ('arguments' in record) {
    parts.push(`arguments:\n${stringifyValue(record.arguments)}`);
  }
  if ('input' in record) {
    parts.push(`input:\n${stringifyValue(record.input)}`);
  }
  if ('output' in record) {
    parts.push(`output:\n${stringifyValue(record.output)}`);
  }
  if ('type' in record && !('role' in record)) {
    parts.unshift(`type: ${String(record.type)}`);
  }
  return parts.join('\n\n') || stringifyValue(record);
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createCompactBoundaryMessage(metadata: Record<string, unknown>, template: unknown) {
  return createUserTextMessage(
    `${COMPACT_BOUNDARY_PREFIX}\n\n${JSON.stringify({ ...metadata, createdAt: new Date().toISOString() })}`,
    template,
  );
}

function createCompactSummaryMessage(summary: string, recentMessagesRetained: boolean, template: unknown) {
  const recentNote = recentMessagesRetained
    ? '\n\nRecent messages are retained after this checkpoint, with bulky payloads and tool results pruned when needed.'
    : '';
  const coverage = recentMessagesRetained ? 'the earlier portion of the conversation' : 'the compacted conversation';
  return createUserTextMessage(
    `${COMPACT_SUMMARY_PREFIX}\n\nThis session is being continued from a previous conversation. The summary below covers ${coverage}.\n\n${summary}${recentNote}`,
    template,
  );
}

function createUserTextMessage(text: string, template: unknown): unknown {
  if (isResponsesMessageTemplate(template)) {
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
  }
  if (isArrayContentMessageTemplate(template)) {
    return { role: 'user', content: [{ type: 'text', text }] };
  }
  return { role: 'user', content: text };
}

function findUserMessageTemplate(messages: unknown[]): unknown {
  return messages.find((message) => getRole(message) === 'user');
}

function isResponsesMessageTemplate(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && (message as Record<string, unknown>).type === 'message');
}

function isArrayContentMessageTemplate(message: unknown): boolean {
  return Boolean(message && typeof message === 'object' && Array.isArray((message as Record<string, unknown>).content));
}

function findLastCompactBoundaryIndex(messages: unknown[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isCompactBoundary(messages[index])) return index;
  }
  return -1;
}

function isCompactBoundary(message: unknown): boolean {
  return getStringContent(message).startsWith(COMPACT_BOUNDARY_PREFIX);
}

function isCompactSummary(message: unknown): boolean {
  return getStringContent(message).startsWith(COMPACT_SUMMARY_PREFIX);
}

function getStringContent(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : extractText(content);
}

function getRole(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  if (typeof record.role === 'string') return record.role;
  if (record.type === 'message' && typeof record.role === 'string') return record.role;
  if (record.type === 'function_call' || record.type === 'function_call_output') return 'tool';
  return null;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) return extractText(record.content);
  return '';
}

function estimateMessagesTokens(messages: unknown[]): number {
  return estimateTokens(stringifyValue(messages));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  const signals = signalLines.slice(0, 80).join('\n');
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

function truncateHeadForPromptTooLongRetry(messages: unknown[]): unknown[] {
  const input = stripPromptTooLongRetryMarker(messages);
  const protectedSummaries = input.filter(isCompactSummary);
  const ordinaryMessages = input.filter((message) => !isCompactSummary(message));
  const rounds = groupMessagesByRound(ordinaryMessages);
  if (rounds.length < 2) {
    return [
      { role: 'user', content: '[earlier conversation truncated for compaction retry]' },
      ...protectedSummaries,
      ...ordinaryMessages,
    ];
  }
  const dropRounds = Math.min(rounds.length - 1, Math.max(1, Math.ceil(rounds.length * RETRY_DROP_RATIO)));
  const start = rounds[dropRounds]?.start ?? ordinaryMessages.length;
  return [
    { role: 'user', content: '[earlier conversation truncated for compaction retry]' },
    ...protectedSummaries,
    ...ordinaryMessages.slice(start),
  ];
}

function stripPromptTooLongRetryMarker(messages: unknown[]): unknown[] {
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

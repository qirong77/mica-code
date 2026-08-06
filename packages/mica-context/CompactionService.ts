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
export type CompactStrategy = 'prune_only' | 'summary_with_recent' | 'summary_only_fallback';

export type CompactOptions = {
  customInstructions?: string;
  keepRecentRounds?: number;
  aggressive?: boolean;
  force?: boolean;
  preview?: boolean;
  pruneOnly?: boolean;
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
        keptCompacted: estimateMessagesTokens(finalKeptMessages) < estimateMessagesTokens(activeMessages.slice(splitIndex)),
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

function chooseForcedRecentStartIndex(messages: unknown[], compactedMessages: unknown[], options: CompactOptions): number {
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
      droppedRounds: Math.max(0, groupMessagesByRound(params.messages).length - groupMessagesByRound(keptMessages).length),
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
  return messages.map((message) => pruneValue(message, { maxStringChars: OLD_MESSAGE_STRING_CHARS, placeholder, mode: 'old' }));
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
    return options.mode === 'old' ? pruneOldString(value, options.maxStringChars) : pruneString(value, options.maxStringChars);
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
    // Responses API reasoning payloads are opaque, authenticated ciphertext.
    // Changing them makes the next request fail with invalid_encrypted_content.
    if (key === 'encrypted_content') {
      next[key] = child;
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
      next[key] = child;
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
    if (isProtocolSensitiveKey(childKey) || childKey === 'function' || childKey === 'tool_calls' || key === 'function') {
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

function compactKeptMessages(messages: unknown[], options: CompactOptions, tokenBudget = getRecentTokenBudget(options)): unknown[] {
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
  return getStringContent(first) === '[earlier conversation truncated for compaction retry]' ? messages.slice(1) : messages;
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

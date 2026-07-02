export const COMPACT_SUMMARY_PREFIX = '[Mica compact checkpoint]';
export const COMPACT_BOUNDARY_PREFIX = '[Mica compact boundary]';

const DEFAULT_MIN_MESSAGES = 4;
const DEFAULT_MIN_TEXT_MESSAGES_TO_KEEP = 4;
const DEFAULT_MIN_TOKENS_TO_KEEP = 8_000;
const DEFAULT_MAX_TOKENS_TO_KEEP = 32_000;
const AGGRESSIVE_MIN_TEXT_MESSAGES_TO_KEEP = 2;
const AGGRESSIVE_MIN_TOKENS_TO_KEEP = 2_000;
const AGGRESSIVE_MAX_TOKENS_TO_KEEP = 12_000;
const MAX_MESSAGE_TRANSCRIPT_CHARS = 8_000;
const MAX_SUMMARY_TRANSCRIPT_CHARS = 16_000;
const RETRY_DROP_RATIO = 0.2;
const OLD_MESSAGE_STRING_CHARS = 4_000;
const TOOL_RESULT_PLACEHOLDER = '[oldResult has been delete]';

export type CompactInput = {
  messages: unknown[];
  summarize(transcript: string, prompt: string): Promise<string>;
  options?: CompactOptions;
};

export type CompactMode = 'summarized' | 'pruned';

export type CompactOptions = {
  customInstructions?: string;
  keepRecentRounds?: number;
  aggressive?: boolean;
  force?: boolean;
  preview?: boolean;
  maxPromptTooLongRetries?: number;
  lightweightPrune?: boolean;
  summarizeThresholdRatio?: number;
  contextWindowSize?: number;
  toolResultPlaceholder?: string;
};

export type CompactResult = {
  messages: unknown[];
  summary: string;
  mode: CompactMode;
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

    let splitIndex = chooseKeepStartIndex(activeMessages, options);
    if (splitIndex <= 0 && options.force) {
      splitIndex = chooseForcedKeepStartIndex(activeMessages, options);
    }
    if (splitIndex <= 0 && options.lightweightPrune) {
      splitIndex = 0;
    }
    if (splitIndex <= 0 && !options.lightweightPrune) {
      throw new CompactionNotNeededError('当前会话最近上下文已经足够完整，暂不需要 compact');
    }

    const keptMessages = activeMessages.slice(splitIndex);
    const oldMessages = activeMessages.slice(0, splitIndex);
    if (!options.lightweightPrune && oldMessages.length < (options.force ? 1 : 2)) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    const beforeTokenEstimate = estimateMessagesTokens(originalMessages);
    const userMessageTemplate = findUserMessageTemplate(activeMessages) ?? findUserMessageTemplate(originalMessages);
    const compactedOldMessages = options.lightweightPrune
      ? compactMessagesForCheckpoint(oldMessages, options)
      : oldMessages;
    const compactedKeptMessages = options.lightweightPrune
      ? compactMessagesForCheckpoint(keptMessages, options)
      : compactKeptMessages(keptMessages, options);
    const lightweightGate = getLightweightGate(options);
    let lightweightTokenEstimate: number | undefined;

    if (options.lightweightPrune) {
      const lightweightBoundaryMessage = createCompactBoundaryMessage(
        {
          mode: 'pruned',
          beforeCount,
          beforeTokenEstimate,
          prunedCount: activeMessages.length,
          keptCount: keptMessages.length,
          keptTokenEstimate: estimateMessagesTokens(compactedKeptMessages),
          keptCompacted: estimateMessagesTokens(compactedKeptMessages) < estimateMessagesTokens(keptMessages),
          trigger: 'manual',
          contextWindowSize: lightweightGate?.contextWindowSize,
          summarizeThresholdRatio: lightweightGate?.thresholdRatio,
        },
        userMessageTemplate,
      );
      const lightweightMessages = [lightweightBoundaryMessage, ...compactedOldMessages, ...compactedKeptMessages];
      lightweightTokenEstimate = estimateMessagesTokens(lightweightMessages);
      const lightweightUsageRatio = usageRatio(lightweightTokenEstimate, lightweightGate?.contextWindowSize);
      if (
        lightweightGate &&
        lightweightUsageRatio !== undefined &&
        lightweightUsageRatio <= lightweightGate.thresholdRatio
      ) {
        const savedTokenEstimate = Math.max(0, beforeTokenEstimate - lightweightTokenEstimate);
        const savedRatio = beforeTokenEstimate > 0 ? savedTokenEstimate / beforeTokenEstimate : 0;
        return {
          messages: options.preview ? cloneJson(originalMessages) : lightweightMessages,
          summary: 'Lightweight compact pruned media, documents, base64 payloads, and tool results.',
          mode: 'pruned',
          beforeCount,
          afterCount: lightweightMessages.length,
          summarizedCount: 0,
          keptCount: keptMessages.length,
          beforeTokenEstimate,
          afterTokenEstimate: lightweightTokenEstimate,
          savedTokenEstimate,
          savedRatio,
          boundaryIndex: activeStartIndex - 1,
          promptTooLongRetries: 0,
          forced: Boolean(options.force),
          preview: Boolean(options.preview),
          contextWindowSize: lightweightGate.contextWindowSize,
          contextUsageRatio: lightweightUsageRatio,
          lightweightTokenEstimate,
        };
      }
    }

    let messagesToSummarize = options.lightweightPrune
      ? [...compactedOldMessages, ...compactedKeptMessages]
      : compactedOldMessages;
    const finalKeptMessages = options.lightweightPrune ? [] : compactedKeptMessages;
    if (messagesToSummarize.length === 0) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }
    const maxRetries = options.maxPromptTooLongRetries ?? (options.aggressive ? 4 : 3);
    const prompt = getCompactPrompt(options.customInstructions);
    let promptTooLongRetries = 0;
    let summary = '';

    for (;;) {
      const transcript = buildTranscript(messagesToSummarize);
      try {
        summary = cleanSummary(await input.summarize(transcript, prompt));
      } catch (error) {
        if (!isPromptTooLongError(error) || promptTooLongRetries >= maxRetries) throw error;
        promptTooLongRetries++;
        messagesToSummarize = truncateHeadForPromptTooLongRetry(messagesToSummarize);
        continue;
      }

      if (looksLikePromptTooLongResponse(summary)) {
        if (promptTooLongRetries >= maxRetries) {
          throw new CompactionPromptTooLongError();
        }
        promptTooLongRetries++;
        messagesToSummarize = truncateHeadForPromptTooLongRetry(messagesToSummarize);
        continue;
      }
      break;
    }

    if (!summary.trim()) throw new Error('Compact summary is empty');

    const summaryMessage = createCompactSummaryMessage(summary, finalKeptMessages.length > 0, userMessageTemplate);
    const boundaryMessage = createCompactBoundaryMessage(
      {
        mode: 'summarized',
        beforeCount,
        beforeTokenEstimate,
        summarizedCount: messagesToSummarize.length,
        keptCount: finalKeptMessages.length,
        keptTokenEstimate: estimateMessagesTokens(finalKeptMessages),
        keptCompacted: estimateMessagesTokens(finalKeptMessages) < estimateMessagesTokens(keptMessages),
        promptTooLongRetries,
        trigger: 'manual',
        contextWindowSize: lightweightGate?.contextWindowSize,
        summarizeThresholdRatio: lightweightGate?.thresholdRatio,
        lightweightTokenEstimate,
      },
      userMessageTemplate,
    );
    const compactMessages = [boundaryMessage, summaryMessage, ...finalKeptMessages];
    const afterTokenEstimate = estimateMessagesTokens(compactMessages);
    const savedTokenEstimate = Math.max(0, beforeTokenEstimate - afterTokenEstimate);
    const savedRatio = beforeTokenEstimate > 0 ? savedTokenEstimate / beforeTokenEstimate : 0;
    const contextUsageRatio = usageRatio(
      afterTokenEstimate,
      lightweightGate?.contextWindowSize ?? options.contextWindowSize,
    );

    if (!options.preview && afterTokenEstimate >= beforeTokenEstimate && !options.aggressive && !options.force) {
      throw new CompactionNotNeededError('compact 后预计不会节省上下文，已保留原会话');
    }

    return {
      messages: options.preview ? cloneJson(originalMessages) : compactMessages,
      summary,
      mode: 'summarized',
      beforeCount,
      afterCount: compactMessages.length,
      summarizedCount: messagesToSummarize.length,
      keptCount: finalKeptMessages.length,
      beforeTokenEstimate,
      afterTokenEstimate,
      savedTokenEstimate,
      savedRatio,
      boundaryIndex: activeStartIndex - 1,
      promptTooLongRetries,
      forced: Boolean(options.force),
      preview: Boolean(options.preview),
      contextWindowSize: lightweightGate?.contextWindowSize,
      contextUsageRatio,
      lightweightTokenEstimate,
    };
  }
}

function chooseKeepStartIndex(messages: unknown[], options: CompactOptions): number {
  const rounds = groupMessagesByRound(messages);
  if (rounds.length < 2) return 0;
  if (options.keepRecentRounds !== undefined) {
    const keepRounds = Math.max(1, Math.floor(options.keepRecentRounds));
    return rounds[Math.max(0, rounds.length - keepRounds)]?.start ?? 0;
  }

  const minTextMessages = options.aggressive ? AGGRESSIVE_MIN_TEXT_MESSAGES_TO_KEEP : DEFAULT_MIN_TEXT_MESSAGES_TO_KEEP;
  const minTokens = options.aggressive ? AGGRESSIVE_MIN_TOKENS_TO_KEEP : DEFAULT_MIN_TOKENS_TO_KEEP;
  const maxTokens = options.aggressive ? AGGRESSIVE_MAX_TOKENS_TO_KEEP : DEFAULT_MAX_TOKENS_TO_KEEP;
  let start = messages.length;
  let tokens = 0;
  let textMessages = 0;

  for (let index = rounds.length - 1; index >= 0; index--) {
    const round = rounds[index]!;
    const roundMessages = messages.slice(round.start, round.end);
    const roundTokens = estimateMessagesTokens(roundMessages);
    if (start < messages.length && tokens + roundTokens > maxTokens) break;
    start = round.start;
    tokens += roundTokens;
    textMessages += roundMessages.filter(hasTextContent).length;
    if (tokens >= minTokens && textMessages >= minTextMessages) break;
  }

  return Math.max(0, Math.min(start, messages.length - 1));
}

function chooseForcedKeepStartIndex(messages: unknown[], options: CompactOptions): number {
  const rounds = groupMessagesByRound(messages);
  if (rounds.length < 2) return 0;
  const keepRounds = Math.max(1, Math.floor(options.keepRecentRounds ?? 1));
  if (options.keepRecentRounds !== undefined && rounds.length <= keepRounds) return 0;
  return rounds[Math.max(1, rounds.length - keepRounds)]?.start ?? 0;
}

function compactMessagesForCheckpoint(messages: unknown[], options: CompactOptions): unknown[] {
  const placeholder = options.toolResultPlaceholder ?? TOOL_RESULT_PLACEHOLDER;
  return messages.map((message) => pruneOldValue(message, OLD_MESSAGE_STRING_CHARS, placeholder));
}

function pruneOldValue(value: unknown, maxStringChars: number, placeholder: string): unknown {
  if (typeof value === 'string') return pruneOldString(value, maxStringChars);
  if (Array.isArray(value)) return value.map((item) => pruneOldValue(item, maxStringChars, placeholder));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const mediaReplacement = mediaPlaceholder(record);
  if (mediaReplacement) return mediaReplacement;

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'toolUseResult') {
      next[key] = placeholder;
      continue;
    }
    if (isToolResultRecord(record) && (key === 'content' || key === 'output')) {
      next[key] = placeholder;
      continue;
    }
    if (key === 'data' && typeof child === 'string' && shouldOmitBase64String(child)) {
      next[key] = `[omitted base64 data: ${child.length} chars]`;
      continue;
    }
    if ((key === 'url' || key === 'image_url') && typeof child === 'string' && isDataUrl(child)) {
      next[key] = `[omitted data url: ${child.length} chars]`;
      continue;
    }
    next[key] = pruneOldValue(child, maxStringChars, placeholder);
  }
  return next;
}

function mediaPlaceholder(record: Record<string, unknown>): Record<string, string> | null {
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

function getLightweightGate(options: CompactOptions): { contextWindowSize: number; thresholdRatio: number } | null {
  const contextWindowSize = Number(options.contextWindowSize);
  const thresholdRatio = Number(options.summarizeThresholdRatio);
  if (!Number.isFinite(contextWindowSize) || contextWindowSize <= 0) return null;
  if (!Number.isFinite(thresholdRatio) || thresholdRatio <= 0) return null;
  return { contextWindowSize, thresholdRatio: Math.min(1, thresholdRatio) };
}

function usageRatio(tokens: number, contextWindowSize: number | undefined): number | undefined {
  if (!contextWindowSize || contextWindowSize <= 0) return undefined;
  return tokens / contextWindowSize;
}

function compactKeptMessages(messages: unknown[], options: CompactOptions): unknown[] {
  const budget = options.aggressive ? AGGRESSIVE_MAX_TOKENS_TO_KEEP : DEFAULT_MAX_TOKENS_TO_KEEP;
  if (estimateMessagesTokens(messages) <= budget) return cloneJson(messages);

  for (const maxStringChars of options.aggressive ? [6_000, 2_000, 800] : [12_000, 4_000, 1_200]) {
    const compacted = messages.map((message) => pruneKeptValue(message, maxStringChars));
    if (estimateMessagesTokens(compacted) <= Math.ceil(budget * 1.25) || maxStringChars <= 1_200) {
      return compacted;
    }
  }
  return cloneJson(messages);
}

function pruneKeptValue(value: unknown, maxStringChars: number): unknown {
  if (typeof value === 'string') return pruneString(value, maxStringChars);
  if (Array.isArray(value)) return value.map((item) => pruneContentBlock(item, maxStringChars));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  if (record.type === 'image' || record.type === 'document')
    return { type: 'text', text: `[${record.type} omitted during compact]` };
  if (record.type === 'input_image') return { type: 'input_text', text: '[image omitted during compact]' };

  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === 'toolUseResult') continue;
    if (key === 'data' && typeof child === 'string' && child.length > maxStringChars) {
      next[key] = `[omitted base64 data: ${child.length} chars]`;
      continue;
    }
    if (key === 'image_url' && typeof child === 'string' && child.length > maxStringChars) {
      next[key] = `[omitted image url: ${child.length} chars]`;
      continue;
    }
    next[key] = pruneKeptValue(child, maxStringChars);
  }
  return next;
}

function pruneContentBlock(value: unknown, maxStringChars: number): unknown {
  if (!value || typeof value !== 'object') return pruneKeptValue(value, maxStringChars);
  const record = value as Record<string, unknown>;
  if (record.type === 'image' || record.type === 'document')
    return { type: 'text', text: `[${record.type} omitted during compact]` };
  if (record.type === 'input_image') return { type: 'input_text', text: '[image omitted during compact]' };
  return pruneKeptValue(value, maxStringChars);
}

function pruneString(value: string, maxChars: number): string {
  if (value.startsWith(COMPACT_SUMMARY_PREFIX) || value.startsWith(COMPACT_BOUNDARY_PREFIX)) return value;
  if (value.length <= maxChars) return value;
  return headSignalsTail(value, maxChars);
}

function groupMessagesByRound(messages: unknown[]): Array<{ start: number; end: number }> {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (getRole(messages[index]) === 'user') starts.push(index);
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

function hasTextContent(message: unknown): boolean {
  return extractText(message).trim().length > 0;
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
  const rounds = groupMessagesByRound(messages);
  if (rounds.length < 2) throw new CompactionPromptTooLongError();
  const dropRounds = Math.min(rounds.length - 1, Math.max(1, Math.ceil(rounds.length * RETRY_DROP_RATIO)));
  const start = rounds[dropRounds]?.start ?? messages.length;
  return [{ role: 'user', content: '[earlier conversation truncated for compaction retry]' }, ...messages.slice(start)];
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

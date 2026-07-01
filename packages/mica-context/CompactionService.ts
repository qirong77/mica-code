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

export type CompactInput = {
  messages: unknown[];
  summarize(transcript: string, prompt: string): Promise<string>;
  options?: CompactOptions;
};

export type CompactOptions = {
  customInstructions?: string;
  keepRecentRounds?: number;
  aggressive?: boolean;
  preview?: boolean;
  maxPromptTooLongRetries?: number;
};

export type CompactResult = {
  messages: unknown[];
  summary: string;
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
  preview: boolean;
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
    if (beforeCount < DEFAULT_MIN_MESSAGES) {
      throw new CompactionNotNeededError();
    }

    const options = input.options ?? {};
    const activeStartIndex = findLastCompactBoundaryIndex(originalMessages) + 1;
    const activeMessages = originalMessages.slice(activeStartIndex);
    if (activeMessages.length < DEFAULT_MIN_MESSAGES) {
      throw new CompactionNotNeededError();
    }

    const splitIndex = chooseKeepStartIndex(activeMessages, options);
    if (splitIndex <= 0) {
      throw new CompactionNotNeededError('当前会话最近上下文已经足够完整，暂不需要 compact');
    }

    const keptMessages = activeMessages.slice(splitIndex);
    let messagesToSummarize = activeMessages.slice(0, splitIndex);
    if (messagesToSummarize.length < 2) {
      throw new CompactionNotNeededError('当前会话可压缩内容较少，暂不需要 compact');
    }

    const beforeTokenEstimate = estimateMessagesTokens(originalMessages);
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

    const userMessageTemplate = findUserMessageTemplate(activeMessages) ?? findUserMessageTemplate(originalMessages);
    const compactedKeptMessages = compactKeptMessages(keptMessages, options);
    const summaryMessage = createCompactSummaryMessage(summary, keptMessages.length > 0, userMessageTemplate);
    const boundaryMessage = createCompactBoundaryMessage(
      {
        beforeCount,
        beforeTokenEstimate,
        summarizedCount: messagesToSummarize.length,
        keptCount: keptMessages.length,
        keptTokenEstimate: estimateMessagesTokens(compactedKeptMessages),
        keptCompacted: estimateMessagesTokens(compactedKeptMessages) < estimateMessagesTokens(keptMessages),
        promptTooLongRetries,
        trigger: 'manual',
      },
      userMessageTemplate,
    );
    const compactMessages = [boundaryMessage, summaryMessage, ...compactedKeptMessages];
    const afterTokenEstimate = estimateMessagesTokens(compactMessages);
    const savedTokenEstimate = Math.max(0, beforeTokenEstimate - afterTokenEstimate);
    const savedRatio = beforeTokenEstimate > 0 ? savedTokenEstimate / beforeTokenEstimate : 0;

    if (!options.preview && afterTokenEstimate >= beforeTokenEstimate && !options.aggressive) {
      throw new CompactionNotNeededError('compact 后预计不会节省上下文，已保留原会话');
    }

    return {
      messages: options.preview ? cloneJson(originalMessages) : compactMessages,
      summary,
      beforeCount,
      afterCount: compactMessages.length,
      summarizedCount: messagesToSummarize.length,
      keptCount: keptMessages.length,
      beforeTokenEstimate,
      afterTokenEstimate,
      savedTokenEstimate,
      savedRatio,
      boundaryIndex: activeStartIndex - 1,
      promptTooLongRetries,
      preview: Boolean(options.preview),
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
  if (record.type === 'image' || record.type === 'document') return { type: 'text', text: `[${record.type} omitted during compact]` };
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
  if (record.type === 'image' || record.type === 'document') return { type: 'text', text: `[${record.type} omitted during compact]` };
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

function createCompactSummaryMessage(summary: string, recentMessagesPreserved: boolean, template: unknown) {
  const recentNote = recentMessagesPreserved ? '\n\nRecent messages are preserved verbatim after this checkpoint.' : '';
  return createUserTextMessage(
    `${COMPACT_SUMMARY_PREFIX}\n\nThis session is being continued from a previous conversation. The summary below covers the earlier portion of the conversation.\n\n${summary}${recentNote}`,
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
  const withoutFences = summary.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '').trim();
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
  return /prompt.*too.*long|context.*length|maximum context|input.*too.*large|tokens.*exceed/i.test(summary.slice(0, 500));
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

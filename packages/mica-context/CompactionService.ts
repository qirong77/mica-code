export const COMPACT_SUMMARY_PREFIX = '[Mica compact checkpoint]';

export type CompactInput = {
  messages: unknown[];
  summarize(transcript: string): Promise<string>;
};

export type CompactResult = {
  messages: unknown[];
  summary: string;
  beforeCount: number;
  afterCount: number;
  beforeTokenEstimate: number;
  afterTokenEstimate: number;
};

export class CompactionService {
  async compact(input: CompactInput): Promise<CompactResult> {
    const messages = input.messages.filter((message) => !isCompactCheckpoint(message));
    if (messages.length < 4) {
      throw new Error('当前会话内容较少，暂不需要 compact');
    }

    const transcript = buildTranscript(messages);
    const beforeTokenEstimate = estimateTokens(transcript);
    const summary = cleanSummary(await input.summarize(transcript));
    if (!summary.trim()) {
      throw new Error('Compact summary is empty');
    }

    const checkpoint = `${COMPACT_SUMMARY_PREFIX}\n\n${summary}`;
    const compactMessages = [
      {
        role: 'user',
        content: checkpoint,
      },
    ];

    return {
      messages: compactMessages,
      summary,
      beforeCount: input.messages.length,
      afterCount: compactMessages.length,
      beforeTokenEstimate,
      afterTokenEstimate: estimateTokens(checkpoint),
    };
  }
}

function buildTranscript(messages: unknown[]): string {
  return messages
    .map((message, index) => {
      const normalized = normalizeMessage(message);
      return `## Message ${index + 1} - ${normalized.label}\n${headSignalsTail(normalized.text, 8000)}`;
    })
    .join('\n\n');
}

function normalizeMessage(message: unknown): { label: string; text: string } {
  if (!message || typeof message !== 'object') {
    return { label: 'unknown', text: String(message) };
  }
  const record = message as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : 'unknown';
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

function isCompactCheckpoint(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' && content.startsWith(COMPACT_SUMMARY_PREFIX);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function cleanSummary(summary: string): string {
  const withoutFences = summary.replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/i, '');
  return ensureSections(withoutFences.trim());
}

function ensureSections(summary: string): string {
  const required = [
    'User Intent',
    'Current State',
    'Constraints and Preferences',
    'Files Inspected',
    'Files Modified',
    'Tool Results and Evidence',
    'Key Decisions',
    'Errors and Fixes',
    'Validation',
    'Pending Work',
    'Immediate Next Step',
  ];
  let next = summary;
  for (const section of required) {
    if (!new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'im').test(next)) {
      next += `\n\n## ${section}\n- Not recorded.`;
    }
  }
  return next.trim();
}

function headSignalsTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return foldRepeats(text);
  const lines = text.split('\n');
  const signalLines = lines.filter((line) =>
    /error|failed|failure|exception|traceback|stack|exit code|ts\(\d+\)|\.(ts|tsx|js|jsx):\d+/i.test(line),
  );
  const head = text.slice(0, Math.floor(maxChars * 0.45));
  const tail = text.slice(-Math.floor(maxChars * 0.35));
  const signals = signalLines.slice(0, 80).join('\n');
  return [
    `[truncated: original ${text.length} chars, kept about ${maxChars} chars]`,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

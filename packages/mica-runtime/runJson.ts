export type RunJsonStatus = 'completed' | 'aborted' | 'error';

export type RunJsonTokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

type RunJsonToolState =
  | {
      status: 'pending';
      input: Record<string, unknown>;
    }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      output: string;
    };

type RunJsonEventBase = {
  timestamp: number;
  sessionID?: string;
};

export type RunJsonEvent =
  | (RunJsonEventBase & {
      type: 'step_start';
      part: { type: 'step-start' };
    })
  | (RunJsonEventBase & {
      type: 'text';
      part: { type: 'text'; text: string };
    })
  | (RunJsonEventBase & {
      type: 'reasoning';
      part: { type: 'reasoning'; text: string };
    })
  | (RunJsonEventBase & {
      type: 'tool_use';
      part: {
        type: 'tool';
        tool: string;
        callID: string;
        state: RunJsonToolState;
      };
    })
  | (RunJsonEventBase & {
      type: 'error';
      part: { type: 'error' };
      error: {
        name: string;
        data: { message: string };
      };
    })
  | (RunJsonEventBase & {
      type: 'step_finish';
      part: {
        type: 'step-finish';
        reason: RunJsonStatus;
        tokens: {
          total: number;
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        };
      };
    });

export type RunJsonWriter = {
  write(event: RunJsonEvent): void;
};

export function encodeRunJsonLine(event: RunJsonEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function createStdoutRunJsonWriter(
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): RunJsonWriter {
  return {
    write(event) {
      write(encodeRunJsonLine(event));
    },
  };
}

export function createRunJsonStepStart(sessionID: string, timestamp = Date.now()): RunJsonEvent {
  return {
    type: 'step_start',
    timestamp,
    sessionID,
    part: { type: 'step-start' },
  };
}

export function createRunJsonStepFinish(
  sessionID: string,
  status: RunJsonStatus,
  usage: RunJsonTokenUsage,
  timestamp = Date.now(),
): RunJsonEvent {
  return {
    type: 'step_finish',
    timestamp,
    sessionID,
    part: {
      type: 'step-finish',
      reason: status,
      tokens: {
        total: usage.total,
        input: usage.input,
        output: usage.output,
        reasoning: 0,
        cache: {
          read: usage.cacheRead,
          write: usage.cacheWrite,
        },
      },
    },
  };
}

export function createRunJsonError(message: string, options: { sessionID?: string; name?: string } = {}): RunJsonEvent {
  return {
    type: 'error',
    timestamp: Date.now(),
    ...(options.sessionID ? { sessionID: options.sessionID } : {}),
    part: { type: 'error' },
    error: {
      name: options.name || 'MicaRuntimeError',
      data: { message: truncateRunJsonText(message, 256 * 1024) },
    },
  };
}

export function emptyRunJsonTokenUsage(): RunJsonTokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
}

export function parseToolCallInput(args: string): Record<string, unknown> {
  const trimmed = args.trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { value };
  } catch {
    return { raw: args };
  }
}

export function truncateRunJsonToolOutput(result: string, maxChars = 256 * 1024): string {
  if (result.length <= maxChars) return result;
  return truncateRunJsonText(result, maxChars);
}

export function chunkRunJsonText(text: string, maxChars = 64 * 1024): string[] {
  if (maxChars <= 0) throw new RangeError('maxChars must be greater than zero');
  if (text.length <= maxChars) return text ? [text] : [];
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
    if (end === start) end = Math.min(text.length, start + 2);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function truncateRunJsonText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const [head = ''] = chunkRunJsonText(text, maxChars);
  return `${head}\n...[truncated by Mica: ${text.length - head.length} chars omitted]`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function exitCodeForRunJsonStatus(status: RunJsonStatus): number {
  switch (status) {
    case 'completed':
      return 0;
    case 'aborted':
      return 130;
    case 'error':
      return 1;
  }
}

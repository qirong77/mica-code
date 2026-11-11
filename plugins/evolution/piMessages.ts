import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import { parseToolCallArguments } from '@earendil-works/pi-ai/utils/json-parse';
import { PI_MESSAGE_FORMAT } from '@packages/mica-common/messageFormat.js';

type RecordValue = Record<string, unknown>;
type AssistantContent = AssistantMessage['content'][number];
type UserContent = TextContent | ImageContent;

const APIS = {
  openai_chat_completions: 'openai-completions',
  openai_responses: 'openai-responses',
  anthropic_messages: 'anthropic-messages',
  google_generative_ai: 'google-generative-ai',
} as const;

type Protocol = keyof typeof APIS;

/** Pure, atomic conversion: a failed conversion never marks a partial transcript as pi. */
export function migratePiMessages(document: RecordValue): number {
  const snapshot = document.snapshot;
  if (!isRecord(snapshot) || snapshot.messageFormat === PI_MESSAGE_FORMAT) return 0;
  if (snapshot.messageFormat !== undefined) throw new Error('Unsupported session message format.');
  if (!Array.isArray(snapshot.messages)) return 0;
  const provider = nonempty(snapshot.providerId);
  const model = nonempty(snapshot.model);
  if (!provider || !model) return 0;
  if (snapshot.protocol !== undefined && !isProtocol(snapshot.protocol)) {
    throw new Error(`Unsupported legacy session protocol: ${String(snapshot.protocol)}`);
  }
  const records = Array.isArray(snapshot.usageHistory) ? snapshot.usageHistory.filter(isRecord) : [];
  const protocol = isProtocol(snapshot.protocol)
    ? snapshot.protocol
    : (records.map((record) => record.provider).find(isProtocol) ?? 'openai_chat_completions');
  if (protocol !== 'openai_chat_completions' && protocol !== 'openai_responses') {
    throw new Error(`Unsupported legacy session protocol: ${protocol}`);
  }
  const fallbackTime = timestamp(document.createdAt, timestamp(document.updatedAt, 0));
  const messages: Message[] = [];
  const calls = new Map<string, { id: string; name: string }>();
  let pending: AssistantMessage | undefined;
  let pendingUsage: unknown;
  let sourceIndex = 0;
  let responseStart = 0;
  const responses: { message: AssistantMessage; nativeUsage: unknown; start: number }[] = [];
  const flush = () => {
    if (!pending) return;
    if (pending.content.some((part) => part.type === 'toolCall')) pending.stopReason = 'toolUse';
    responses.push({ message: pending, nativeUsage: pendingUsage, start: responseStart });
    messages.push(pending);
    pending = undefined;
    pendingUsage = undefined;
  };
  const assistant = (source: RecordValue): AssistantMessage => {
    if (!pending) {
      responseStart = sourceIndex;
      pending = {
        role: 'assistant',
        content: [],
        api: APIS[protocol],
        provider,
        model,
        usage: piUsage(undefined),
        stopReason: 'stop',
        timestamp: timestamp(source.timestamp, fallbackTime),
      };
    }
    if (source.usage !== undefined) pendingUsage = source.usage;
    const responseId = nonempty(source.responseId) ?? nonempty(source.response_id);
    if (responseId) pending.responseId = responseId;
    if (typeof source.finish_reason === 'string') {
      pending.rawStopReason = source.finish_reason;
      if (source.finish_reason === 'length') pending.stopReason = 'length';
      if (source.finish_reason === 'content_filter') pending.stopReason = 'error';
    }
    if (source.status === 'incomplete') pending.stopReason = 'length';
    return pending;
  };
  const appendCall = (source: RecordValue, responseItem: boolean) => {
    const fn = isRecord(source.function) ? source.function : source;
    const callId = nonempty(source.call_id) ?? nonempty(source.id) ?? `legacy_call_${calls.size + 1}`;
    const itemId = responseItem ? nonempty(source.id) : undefined;
    const id = itemId && itemId !== callId ? `${callId}|${itemId}` : callId;
    const name = nonempty(fn.name) ?? 'unknown_tool';
    const tool: ToolCall = {
      type: 'toolCall',
      id,
      name,
      ...(isRecord(fn.arguments)
        ? { arguments: fn.arguments as ToolCall['arguments'] }
        : isRecord(fn.input)
          ? { arguments: fn.input as ToolCall['arguments'] }
          : parseToolCallArguments(typeof fn.arguments === 'string' ? fn.arguments : undefined)),
    };
    const signature = nonempty(source.thoughtSignature) ?? nonempty(source.thought_signature);
    if (signature) tool.thoughtSignature = signature;
    if (typeof source.namespace === 'string') tool.namespace = source.namespace;
    calls.set(callId, { id, name });
    calls.set(id, { id, name });
    assistant(source).content.push(tool);
  };

  for (let index = 0; index < snapshot.messages.length; index++) {
    sourceIndex = index;
    const source = snapshot.messages[index];
    if (!isRecord(source)) throw new Error(`Invalid legacy message at index ${index}.`);
    const type = source.type;
    if (type === 'reasoning') {
      const message = assistant(source);
      const text = reasoningText(source.summary) || reasoningText(source.content);
      message.content.push({ type: 'thinking', thinking: text, thinkingSignature: JSON.stringify(source) });
      continue;
    }
    if (type === 'function_call') {
      appendCall(source, true);
      continue;
    }
    if (type === 'function_call_output' || source.role === 'tool' || source.role === 'function') {
      flush();
      const callId = nonempty(source.call_id) ?? nonempty(source.tool_call_id) ?? nonempty(source.id) ?? '';
      const call = calls.get(callId);
      messages.push({
        role: 'toolResult',
        toolCallId: call?.id ?? callId,
        toolName: call?.name ?? nonempty(source.name) ?? 'unknown_tool',
        content: userContent(source.output ?? source.content ?? ''),
        isError: source.isError === true || source.is_error === true,
        timestamp: timestamp(source.timestamp, fallbackTime),
      });
      continue;
    }
    if (source.role === 'user') {
      flush();
      messages.push({
        role: 'user',
        content: userContent(source.content),
        timestamp: timestamp(source.timestamp, fallbackTime),
      });
      continue;
    }
    if (source.role === 'system' || source.role === 'developer') {
      flush();
      messages.push({
        role: 'system',
        content: textContent(source.content),
        timestamp: timestamp(source.timestamp, fallbackTime),
      });
      continue;
    }
    if (source.role === 'assistant') {
      // Chat records already delimit responses; Responses stores each output item separately.
      if (protocol === 'openai_chat_completions') flush();
      const message = assistant(source);
      const thinking = chatThinking(source);
      message.content.push(...thinking);
      const content = assistantContent(source.content);
      const itemId = type === 'message' ? nonempty(source.id) : undefined;
      if (itemId) {
        const signature = JSON.stringify({
          v: 1,
          id: itemId,
          ...(source.phase === 'commentary' || source.phase === 'final_answer' ? { phase: source.phase } : {}),
        });
        for (const part of content) if (part.type === 'text') part.textSignature ??= signature;
      }
      message.content.push(...content);
      if (typeof source.refusal === 'string' && source.refusal)
        message.content.push({ type: 'text', text: source.refusal });
      if (Array.isArray(source.tool_calls)) {
        for (const call of source.tool_calls) {
          if (!isRecord(call)) throw new Error(`Invalid legacy tool call at index ${index}.`);
          appendCall(call, false);
        }
      }
      if (isRecord(source.function_call)) {
        appendCall({ ...source.function_call, id: nonempty(source.id) ?? `legacy_function_${calls.size + 1}` }, false);
      }
      continue;
    }
    throw new Error(`Unsupported legacy message at index ${index}: ${String(type ?? source.role)}.`);
  }
  flush();
  // Older compacted sessions retain their entire accounting ledger. Pair from
  // the newest request backwards by the saved native input boundary; never
  // attach the first old request's usage to a surviving recent response.
  let recordLimit = records.length;
  const orderedWithoutBoundaries =
    records.length === responses.length && records.every((record) => record.messageCount === undefined);
  for (let index = responses.length - 1; index >= 0; index--) {
    const response = responses[index]!;
    const count = response.start + (protocol === 'openai_chat_completions' ? 1 : 0);
    let recordIndex = orderedWithoutBoundaries ? index : -1;
    if (!orderedWithoutBoundaries) {
      for (let candidate = recordLimit - 1; candidate >= 0; candidate--) {
        if (records[candidate]!.messageCount === count) {
          recordIndex = candidate;
          break;
        }
      }
    }
    const record = records[recordIndex];
    if (recordIndex >= 0) recordLimit = recordIndex;
    response.message.usage = piUsage(response.nativeUsage ?? record);
    response.message.timestamp = timestamp(record?.occurredAt, response.message.timestamp);
  }
  snapshot.messages = messages;
  snapshot.protocol = protocol;
  snapshot.messageFormat = PI_MESSAGE_FORMAT;
  return 1;
}

function userContent(value: unknown): UserContent[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [{ type: 'text', text: JSON.stringify(value) }];
  return value.flatMap((part): UserContent[] => {
    if (!isRecord(part)) return [{ type: 'text', text: JSON.stringify(part) }];
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      return [{ type: 'text', text: typeof part.text === 'string' ? part.text : '' }];
    }
    if (part.type === 'refusal' && typeof part.refusal === 'string') return [{ type: 'text', text: part.refusal }];
    if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
      return [{ type: 'image', data: part.data, mimeType: part.mimeType }];
    }
    if (part.type === 'image' && isRecord(part.source)) {
      if (
        part.source.type === 'base64' &&
        typeof part.source.data === 'string' &&
        typeof part.source.media_type === 'string'
      ) {
        return [{ type: 'image', data: part.source.data, mimeType: part.source.media_type }];
      }
      if (typeof part.source.url === 'string') return imageContent(part.source.url);
    }
    if (part.type === 'image_url' || part.type === 'input_image') {
      const image = isRecord(part.image_url) ? part.image_url.url : part.image_url;
      if (typeof image === 'string') return imageContent(image);
      if (typeof part.file_id === 'string') return [{ type: 'text', text: `[Image](${part.file_id})` }];
    }
    // Keep non-image legacy attachments as explicit text rather than dropping user content.
    return [{ type: 'text', text: JSON.stringify(part) }];
  });
}

function imageContent(url: string): UserContent[] {
  const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  return data ? [{ type: 'image', mimeType: data[1]!, data: data[2]! }] : [{ type: 'text', text: `[Image](${url})` }];
}

function assistantContent(value: unknown): AssistantContent[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part): AssistantContent[] => {
    if (!isRecord(part)) return [];
    if (part.type === 'thinking' || part.type === 'reasoning') {
      return [
        {
          type: 'thinking',
          thinking: string(part.thinking) || string(part.text),
          ...((nonempty(part.thinkingSignature) ?? nonempty(part.signature))
            ? { thinkingSignature: nonempty(part.thinkingSignature) ?? nonempty(part.signature) }
            : {}),
        },
      ];
    }
    if (part.type === 'redacted_thinking') {
      return [{ type: 'thinking', thinking: '', redacted: true, thinkingSignature: string(part.data) }];
    }
    if (part.type === 'text' || part.type === 'output_text') {
      return [
        {
          type: 'text',
          text: string(part.text),
          ...(typeof part.textSignature === 'string' ? { textSignature: part.textSignature } : {}),
        },
      ];
    }
    if (part.type === 'refusal') return [{ type: 'text', text: string(part.refusal) }];
    // Preserve any unexpected assistant attachment visibly; pi assistant blocks cannot carry images.
    return [{ type: 'text', text: JSON.stringify(part) }];
  });
}

function chatThinking(source: RecordValue): ThinkingContent[] {
  const text =
    typeof source.reasoning_content === 'string'
      ? source.reasoning_content
      : typeof source.reasoning === 'string'
        ? source.reasoning
        : '';
  const details = Array.isArray(source.reasoning_details) ? source.reasoning_details : undefined;
  const signature =
    typeof source.thinkingSignature === 'string'
      ? source.thinkingSignature
      : typeof source.reasoning_signature === 'string'
        ? source.reasoning_signature
        : details?.length
          ? JSON.stringify(details)
          : undefined;
  const thinking =
    text ||
    (details
      ? details
          .filter(isRecord)
          .map((part) => string(part.text) || string(part.summary))
          .join('\n\n')
      : '');
  return thinking || signature
    ? [{ type: 'thinking', thinking, ...(signature ? { thinkingSignature: signature } : {}) }]
    : [];
}

function textContent(value: unknown): string {
  return userContent(value)
    .map((part) => (part.type === 'text' ? part.text : '[Image]'))
    .join('');
}

function reasoningText(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .map((part) => string(part.text))
        .filter(Boolean)
        .join('\n\n')
    : '';
}

function piUsage(value: unknown): Usage {
  const record = isRecord(value) ? value : {};
  const inputDetails = isRecord(record.input_tokens_details)
    ? record.input_tokens_details
    : isRecord(record.prompt_tokens_details)
      ? record.prompt_tokens_details
      : {};
  const outputDetails = isRecord(record.output_tokens_details)
    ? record.output_tokens_details
    : isRecord(record.completion_tokens_details)
      ? record.completion_tokens_details
      : {};
  const cacheRead = number(
    record.cacheRead ?? record.cachedInputTokens ?? inputDetails.cached_tokens ?? record.cache_read_input_tokens,
  );
  const cacheWrite = number(record.cacheWrite ?? inputDetails.cache_write_tokens ?? record.cache_creation_input_tokens);
  const totalInput = number(record.inputTokens ?? record.input_tokens ?? record.prompt_tokens ?? record.input);
  const input = Math.max(0, totalInput - cacheRead - cacheWrite);
  const output = number(record.outputTokens ?? record.output_tokens ?? record.completion_tokens ?? record.output);
  const reasoning = record.reasoning ?? outputDetails.reasoning_tokens;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(typeof reasoning === 'number' ? { reasoning: number(reasoning) } : {}),
    totalTokens: number(record.totalTokens ?? record.total_tokens) || input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isProtocol(value: unknown): value is Protocol {
  return typeof value === 'string' && Object.hasOwn(APIS, value);
}
function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function timestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : fallback;
}

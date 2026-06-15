import type {
  AssistantContentBlock,
  ContentBlockParam,
  ImageBlockParam,
  LlmClient,
  LlmClientConfig,
  Message,
  MessageCreateParams,
  MessageParam,
  MessageStream,
  StreamEventMap,
  TextBlock,
  Tool,
  ToolResultBlockParam,
  ToolUseBlock,
  Usage,
} from '../types.js';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParamsBase,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { api } from '../store/config.js';

class LlmApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmApiError';
  }
}

class SimpleMessageStream implements MessageStream {
  controller = new AbortController();
  private listeners: { [K in keyof StreamEventMap]: Array<StreamEventMap[K]> } = {
    text: [],
    thinking: [],
    contentBlock: [],
  };

  constructor(private finalMessagePromise: Promise<Message>) {}

  on<K extends keyof StreamEventMap>(event: K, handler: StreamEventMap[K]): void {
    this.listeners[event].push(handler);
  }

  emit<K extends keyof StreamEventMap>(event: K, payload: Parameters<StreamEventMap[K]>[0]): void {
    for (const handler of this.listeners[event]) {
      handler(payload as never);
    }
  }

  finalMessage(): Promise<Message> {
    return this.finalMessagePromise;
  }
}

function toDataUrl(image: ImageBlockParam['source']): string {
  return `data:${image.media_type};base64,${image.data}`;
}

function convertUserContent(content: MessageParam['content']): ChatCompletionMessageParam[] {
  if (typeof content === 'string') {
    return [{ role: 'user', content }];
  }

  const toolResults = content.filter(
    (block): block is ToolResultBlockParam => block.type === 'tool_result',
  );
  if (toolResults.length > 0 && toolResults.length === content.length) {
    return toolResults.map((block) => ({
      role: 'tool',
      tool_call_id: block.tool_use_id,
      content: block.content,
    }));
  }

  const contentParts = content
    .filter(
      (block): block is Exclude<ContentBlockParam, ToolResultBlockParam> =>
        block.type !== 'tool_result',
    )
    .map((block): ChatCompletionContentPartText | ChatCompletionContentPartImage => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      }
      return {
        type: 'image_url' as const,
        image_url: { url: toDataUrl(block.source) },
      };
    });

  if (contentParts.length === 1 && contentParts[0]?.type === 'text') {
    return [{ role: 'user', content: contentParts[0].text }];
  }

  return [{ role: 'user', content: contentParts }];
}

function convertAssistantContent(content: AssistantContentBlock[]): ChatCompletionMessageParam {
  const text = content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const toolCalls = content
    .filter((block): block is ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input),
      },
    }));

  return {
    role: 'assistant',
    content: text || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function convertMessages(messages: MessageParam[], system?: string): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const message of messages) {
    if (message.role === 'user') {
      result.push(...convertUserContent(message.content));
      continue;
    }

    result.push(convertAssistantContent(message.content as AssistantContentBlock[]));
  }

  return result;
}

function convertTools(tools?: Tool[]): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function mapStopReason(
  reason:
    | ChatCompletion.Choice['finish_reason']
    | ChatCompletionChunk.Choice['finish_reason']
    | undefined,
): Message['stop_reason'] {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'stop':
    default:
      return 'end_turn';
  }
}

function parseToolArguments(input: string | undefined): Record<string, any> {
  if (!input) return {};
  try {
    return JSON.parse(input) as Record<string, any>;
  } catch {
    return {};
  }
}

function isFunctionToolCall(
  call: ChatCompletionMessageToolCall,
): call is ChatCompletionMessageFunctionToolCall {
  return call.type === 'function';
}

function buildMessageFromResponse(response: ChatCompletion): Message {
  const choice = response.choices[0];
  const content: AssistantContentBlock[] = [];
  if (choice?.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  for (const call of choice?.message.tool_calls ?? []) {
    if (!isFunctionToolCall(call)) continue;
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments),
    });
  }

  const usage: Usage | undefined = response.usage
    ? {
        prompt_tokens: response.usage.prompt_tokens,
        completion_tokens: response.usage.completion_tokens,
        total_tokens: response.usage.total_tokens,
      }
    : undefined;

  return {
    role: 'assistant',
    content,
    usage,
    stop_reason: mapStopReason(choice?.finish_reason),
  };
}

async function parseError(response: Response): Promise<never> {
  let message = `HTTP ${response.status}`;
  try {
    const json = (await response.json()) as { error?: { message?: string } };
    if (json.error?.message) {
      message = json.error.message;
    }
  } catch {
    // ignore parse error
  }
  throw new LlmApiError(message, response.status);
}

function buildPayload(
  params: MessageCreateParams,
  stream: boolean,
): ChatCompletionCreateParamsBase {
  return {
    model: params.model,
    messages: convertMessages(params.messages, params.system),
    tools: convertTools(params.tools),
    max_completion_tokens: params.max_tokens,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
  };
}

async function readSseLines(
  response: Response,
  onData: (data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (signal.aborted) {
      await reader.cancel();
      throw new Error('ABORT');
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());

      if (dataLines.length > 0) {
        onData(dataLines.join('\n'));
      }
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
}

export function createClient(config: LlmClientConfig): LlmClient {
  const baseURL = config.baseURL?.replace(/\/$/, '') || 'https://api.openai.com/v1';

  async function request(
    params: MessageCreateParams,
    stream: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    return fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        ...config.defaultHeaders,
      },
      body: JSON.stringify(buildPayload(params, stream)),
      signal,
    });
  }

  return {
    messages: {
      async create(params: MessageCreateParams): Promise<Message> {
        const response = await request(params, false);
        if (!response.ok) {
          await parseError(response);
        }
        const json = (await response.json()) as ChatCompletion;
        return buildMessageFromResponse(json);
      },

      stream(params: MessageCreateParams): MessageStream {
        let finishReason: ChatCompletionChunk.Choice['finish_reason'] | undefined;
        let usage: Usage | undefined;
        let text = '';
        const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
        let resolveFinal!: (message: Message) => void;
        let rejectFinal!: (error: unknown) => void;
        const finalMessagePromise = new Promise<Message>((resolve, reject) => {
          resolveFinal = resolve;
          rejectFinal = reject;
        });
        const stream = new SimpleMessageStream(finalMessagePromise);

        void (async () => {
          try {
            const response = await request(params, true, stream.controller.signal);
            if (!response.ok) {
              await parseError(response);
            }

            await readSseLines(
              response,
              (data) => {
                if (data === '[DONE]') return;
                const chunk = JSON.parse(data) as ChatCompletionChunk;
                if (chunk.usage) {
                  usage = {
                    prompt_tokens: chunk.usage.prompt_tokens,
                    completion_tokens: chunk.usage.completion_tokens,
                    total_tokens: chunk.usage.total_tokens,
                  };
                }

                const choice = chunk.choices?.[0];
                if (!choice) return;
                if (choice.finish_reason) {
                  finishReason = choice.finish_reason;
                }

                if (choice.delta?.content) {
                  text += choice.delta.content;
                  stream.emit('text', choice.delta.content);
                }

                for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
                  const current = toolCalls.get(toolCallDelta.index) ?? {
                    id: '',
                    name: '',
                    arguments: '',
                  };
                  if (toolCallDelta.id) current.id = toolCallDelta.id;
                  if (toolCallDelta.function?.name) current.name = toolCallDelta.function.name;
                  if (toolCallDelta.function?.arguments)
                    current.arguments += toolCallDelta.function.arguments;
                  toolCalls.set(toolCallDelta.index, current);
                }
              },
              stream.controller.signal,
            );

            const content: AssistantContentBlock[] = [];
            if (text) {
              content.push({ type: 'text', text });
            }
            for (const toolCall of [...toolCalls.entries()]
              .sort((a, b) => a[0] - b[0])
              .map((entry) => entry[1])) {
              const block: ToolUseBlock = {
                type: 'tool_use',
                id: toolCall.id,
                name: toolCall.name,
                input: parseToolArguments(toolCall.arguments),
              };
              content.push(block);
              stream.emit('contentBlock', block);
            }

            resolveFinal({
              role: 'assistant',
              content,
              usage,
              stop_reason: mapStopReason(finishReason),
            } satisfies Message);
          } catch (error) {
            rejectFinal(error);
          }
        })();

        return stream;
      },
    },

    isRetryableError(error: unknown): boolean {
      if (error instanceof Error && error.message === 'ABORT') return false;
      if (error instanceof LlmApiError) {
        if (error.status === 408 || error.status === 409 || error.status === 429) return true;
        if (typeof error.status === 'number' && error.status >= 500) return true;
        return false;
      }
      if (error instanceof TypeError) return true;
      return false;
    },
  };
}

let _client: LlmClient | null = null;

export function getClient(): LlmClient {
  if (_client) return _client;

  const apiKey = api.apiKey.get();
  if (!apiKey) {
    throw new Error(
      '缺少 API Key 配置，请在 ~/.mica/config.json 的 providers 中设置当前 provider 的 api_key，或配置对应环境变量',
    );
  }

  _client = createClient({
    apiKey,
    baseURL: api.baseUrl.get() || undefined,
  });
  return _client;
}

export function resetClient(): void {
  _client = null;
}

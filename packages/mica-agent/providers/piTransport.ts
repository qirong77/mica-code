import type { Api, AssistantMessageEvent, Context, Model, StreamOptions } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { stream as chatStream } from '@earendil-works/pi-ai/api/openai-completions';
import { stream as responsesStream } from '@earendil-works/pi-ai/api/openai-responses';
import { stream as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as googleStream } from '@earendil-works/pi-ai/api/google-generative-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { getModelRule, type ProviderProtocol } from '@packages/mica-config/index.js';
import { fetchWithReadableErrors } from './providerErrorBody.js';
import { providerOmitsFinishReason } from './finishReasonSupport.js';
import type { ModelClientOptions } from './types.js';

const apis: Record<ProviderProtocol, Api> = {
  openai_chat_completions: 'openai-completions',
  openai_responses: 'openai-responses',
  anthropic_messages: 'anthropic-messages',
  google_generative_ai: 'google-generative-ai',
};
const nativeCatalogs = {
  'anthropic-messages': anthropicProvider().getModels(),
  'google-generative-ai': googleProvider().getModels(),
};

export function piModel(options: ModelClientOptions): Model<Api> {
  const rule = getModelRule(options.model, options.provider);
  const api = apis[options.provider.protocol];
  if (!api) throw new Error(`Unsupported model protocol: ${options.provider.protocol}`);
  const native = api === 'anthropic-messages'
    ? nativeCatalogs['anthropic-messages'].find((model) => model.id === options.model)
    : api === 'google-generative-ai'
      ? nativeCatalogs['google-generative-ai'].find((model) => model.id === options.model) : undefined;
  return {
    ...native,
    id: options.model, name: options.model, api, provider: options.provider.id,
    baseUrl: options.baseURL ?? options.provider.api_base,
    reasoning: options.provider.supportsEffort !== false,
    input: (options.supportsVision ?? rule.supportsVision) === false ? ['text'] : ['text', 'image'],
    contextWindow: rule.contextSize,
    maxTokens: native?.maxTokens ?? Math.min(rule.contextSize, 128_000),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(api === 'openai-completions' ? {
      compat: { supportsFinishReason: !providerOmitsFinishReason(options.provider, options.model) },
    } : {}),
  };
}

export type PiRequest = {
  model: Model<Api>;
  context: Context;
  options: ModelClientOptions;
  signal: AbortSignal;
  reasoning: Record<string, unknown>;
  onPayload(payload: Record<string, unknown>): void;
  /** A captured HTTP/transport error retains status and cause that pi's event does not carry. */
  onTransportError(error: unknown): void;
  onGenerationMetadata(info: { reasoningTokens?: number; hasOtherOutput: boolean }): void;
};

/** Pi owns all wire encoding and SSE decoding; this seam only applies Mica's request policy. */
export function streamPiRequest(request: PiRequest): AsyncIterable<AssistantMessageEvent> {
  const fetchImpl = fetchWithReadableErrors();
  const options: StreamOptions = {
    apiKey: request.options.apiKey || 'mica-local',
    signal: request.signal,
    maxRetries: 0,
    onProviderStreamEvent(event) {
      if (!event || typeof event !== 'object') return;
      const value = event as Record<string, any>;
      const usage = value.usage ?? value.response?.usage;
      const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens;
      // Pi normalizes an absent reasoning breakdown to 0 for some APIs. Speed statistics
      // require an explicitly reported count; never infer it from that default.
      const choices = Array.isArray(value.choices) ? value.choices : [];
      request.onGenerationMetadata({
        reasoningTokens: typeof reasoningTokens === 'number' ? reasoningTokens : undefined,
        hasOtherOutput: choices.length > 1 || choices.some((choice: any) =>
          (typeof choice.index === 'number' && choice.index !== 0) || choice.delta?.refusal != null || choice.delta?.audio != null),
      });
    },
    fetch: (async (input, init) => {
      try {
        const response = await fetchImpl(input, init);
        if (!response.ok) {
          const body = await response.clone().text().catch(() => '');
          request.onTransportError(Object.assign(new Error(`${response.status} ${body.slice(0, 1600)}`), {
            status: response.status,
          }));
        }
        return response;
      } catch (error) {
        request.onTransportError(error);
        throw error;
      }
    }) as typeof globalThis.fetch,
    onPayload(payload) {
      const value = payload as Record<string, unknown>;
      // Pi's default reasoning settings must not override the user's model-specific controls.
      if (request.model.api === 'openai-completions' || request.model.api === 'openai-responses') {
        delete value.reasoning;
        delete value.reasoning_effort;
        delete value.thinking;
        delete value.enable_thinking;
        if (request.model.api === 'openai-responses' && request.reasoning.reasoning) {
          const reasoning = request.reasoning.reasoning as Record<string, unknown>;
          value.include = ['reasoning.encrypted_content'];
          value.reasoning = { summary: 'auto', ...reasoning };
        }
      }
      const patched = mergeRequest(value, request.reasoning);
      request.onPayload(patched);
      return patched;
    },
  };
  // Google's adapter explicitly rejects injected fetch implementations.
  if (request.model.api === 'google-generative-ai') delete options.fetch;
  const context = normalizeContext(request.context);
  switch (request.model.api) {
    case 'openai-completions': return chatStream(request.model as Model<'openai-completions'>, context, options);
    case 'openai-responses': return responsesStream(request.model as Model<'openai-responses'>, context, options);
    case 'anthropic-messages': return anthropicStream(request.model as Model<'anthropic-messages'>, context, options);
    case 'google-generative-ai': return googleStream(request.model as Model<'google-generative-ai'>, context, options);
    default: throw new Error(`Unsupported pi API: ${request.model.api}`);
  }
}

function mergeRequest(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    result[key] = isRecord(value) && isRecord(current) ? mergeRequest(current, value) : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

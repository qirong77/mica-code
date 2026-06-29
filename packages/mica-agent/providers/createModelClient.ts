import { resolveProviderProtocol } from '@packages/mica-config/index.js';
import type { IAgent } from '../core/Agent.js';
import { AnthropicAgent } from './AnthropicAgent.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';

export function createModelClient(options: ModelClientOptions): IAgent<ModelClientOptions> {
  switch (resolveProviderProtocol(options.provider)) {
    case 'anthropic_messages':
      return new AnthropicAgent(options);
    case 'openai_responses':
      return new ResponsesClient(options);
    case 'openai_chat_completions':
      return new ChatCompletionsClient(options);
  }
}

export function createSubAgent(options: ModelClientOptions): IAgent<ModelClientOptions> {
  return createModelClient({ ...options, effort: 'none', tools: false });
}

import type { IAgent } from '../core/Agent.js';
import { ChatCompletionsClient } from './ChatCompletionsClient.js';
import { ResponsesClient } from './ResponsesClient.js';
import type { ModelClientOptions } from './types.js';

export function createModelClient(options: ModelClientOptions): IAgent<ModelClientOptions> {
  switch (options.provider.protocol) {
    case 'openai_responses':
      return new ResponsesClient(options);
    case 'openai_chat_completions':
      return new ChatCompletionsClient(options);
  }
}

export function createSubAgent(options: ModelClientOptions): IAgent<ModelClientOptions> {
  return createModelClient({ ...options, effort: 'none', tools: options.tools ?? false });
}

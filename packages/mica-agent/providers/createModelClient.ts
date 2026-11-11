import type { IAgent } from '../core/Agent.js';
import { PiModelClient } from './PiModelClient.js';
import type { ModelClientOptions } from './types.js';

export type ModelClientFactory = (options: ModelClientOptions) => IAgent<ModelClientOptions>;

const modelClientFactories = new Map<string, ModelClientFactory>([
  ...['openai_chat_completions', 'openai_responses', 'anthropic_messages', 'google_generative_ai'].map(
    (protocol): [string, ModelClientFactory] => [protocol, (options) => new PiModelClient(options)],
  ),
]);

/** Registers an additional provider protocol implementation. */
export function registerModelClient(protocol: string, factory: ModelClientFactory): () => void {
  if (!protocol.trim()) throw new Error('Model client protocol must not be empty.');
  if (modelClientFactories.has(protocol)) throw new Error(`Model client protocol is already registered: ${protocol}`);
  modelClientFactories.set(protocol, factory);
  return () => {
    if (modelClientFactories.get(protocol) === factory) modelClientFactories.delete(protocol);
  };
}

export function createModelClient(options: ModelClientOptions): IAgent<ModelClientOptions> {
  const factory = modelClientFactories.get(options.provider.protocol);
  if (!factory) throw new Error(`Unsupported model client protocol: ${options.provider.protocol}`);
  return factory(options);
}

export function createSubAgent(options: ModelClientOptions): IAgent<ModelClientOptions> {
  return createModelClient({ ...options, effort: options.effort ?? 'none', tools: options.tools ?? false });
}

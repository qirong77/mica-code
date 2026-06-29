import type { EffortOption, ProviderDefinition } from '@packages/mica-config/index.js';

export type ModelClientOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  effort?: EffortOption;
  provider?: ProviderDefinition;
  tools?: boolean;
  systemPrompt?: string;
  maxTokens?: number;
};

import type { EffortOption, ProviderDefinition } from '@packages/mica-config/index.js';
import type { ToolFilter } from '@packages/mica-tools/index.js';

export type ModelClientOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  effort?: EffortOption;
  /** Whether the model accepts image input. Missing defaults to true (vision-capable). */
  supportsVision?: boolean;
  provider: ProviderDefinition;
  tools?: boolean;
  toolFilter?: ToolFilter;
  toolContext?: unknown;
  systemPrompt?: string | (() => string);
};

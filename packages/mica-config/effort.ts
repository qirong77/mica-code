import {
  type EffortOption,
  type ProviderDefinition,
  type ResolvedEffortParams,
} from './types.js';

export type ResponsesReasoningParams = { reasoning?: { effort: string } };

export function resolveChatCompletionsEffortParams(
  provider: ProviderDefinition,
  effort: EffortOption,
): ResolvedEffortParams {
  if (provider.supportsEffort === false || effort === 'none') return {};
  return { reasoning_effort: effort };
}

export function resolveResponsesReasoningParams(
  provider: ProviderDefinition,
  effort: EffortOption,
): ResponsesReasoningParams {
  if (provider.supportsEffort === false || effort === 'none') return {};
  return { reasoning: { effort } };
}

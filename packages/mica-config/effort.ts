import {
  EFFORT_OPTIONS,
  firstProviderModel,
  type EffortOption,
  type ProviderDefinition,
  type ResolvedEffortParams,
} from './types.js';
import { getEffortMapFromConfig, hasOwnEffort } from './model-rules/index.js';

type ProviderEffortParamFormat = 'openai' | 'deepseek' | 'zai' | 'openrouter';
export type ResponsesReasoningParams = { reasoning?: { effort: string } };

export function getProviderEffortOptions(
  provider: ProviderDefinition,
  model = firstProviderModel(provider) ?? '',
): EffortOption[] {
  if (provider.supportsEffort === false) return ['none'];
  if (provider.protocol === 'anthropic_messages') return ['none', 'low', 'medium', 'high'];
  const effortMap = getEffortMapFromConfig(model);
  if (!effortMap) return ['none'];
  return EFFORT_OPTIONS.filter((effort) => hasOwnEffort(effortMap, effort));
}

export function clampProviderEffort(
  provider: ProviderDefinition,
  effort: EffortOption,
  model = firstProviderModel(provider) ?? '',
): EffortOption {
  const options = getProviderEffortOptions(provider, model);
  if (options.includes(effort)) return effort;
  const requestedIndex = EFFORT_OPTIONS.indexOf(effort);
  if (requestedIndex >= 0) {
    for (let index = requestedIndex + 1; index < EFFORT_OPTIONS.length; index++) {
      const candidate = EFFORT_OPTIONS[index];
      if (options.includes(candidate)) return candidate;
    }
    for (let index = requestedIndex - 1; index >= 0; index--) {
      const candidate = EFFORT_OPTIONS[index];
      if (options.includes(candidate)) return candidate;
    }
  }
  return options[0] ?? 'none';
}

export function mapProviderEffortValue(
  provider: ProviderDefinition,
  effort: EffortOption,
  model = firstProviderModel(provider) ?? '',
): string | null | undefined {
  if (provider.supportsEffort === false) return undefined;

  const effortMap = getEffortMapFromConfig(model);
  if (!effortMap || !hasOwnEffort(effortMap, effort)) return undefined;

  const mapped = effortMap[effort];
  return mapped === undefined ? effort : mapped;
}

export function resolveChatCompletionsEffortParams(
  provider: ProviderDefinition,
  effort: EffortOption,
  model = firstProviderModel(provider) ?? '',
): ResolvedEffortParams {
  if (provider.supportsEffort === false) return {};

  const effortMap = getEffortMapFromConfig(model);
  if (!effortMap || !hasOwnEffort(effortMap, effort)) return {};

  const mapped = effortMap[effort];
  if (effort === 'none' || mapped === null) return resolveDisabledEffortParams(provider, mapped);

  switch (detectProviderEffortParamFormat(provider)) {
    case 'deepseek':
    case 'zai':
      return { thinking: { type: 'enabled' }, reasoning_effort: mapped ?? effort };
    case 'openrouter':
      return { reasoning: { effort: mapped ?? effort } };
    case 'openai':
      return { reasoning_effort: mapped ?? effort };
  }
}

export function resolveResponsesReasoningParams(
  provider: ProviderDefinition,
  effort: EffortOption,
  model = firstProviderModel(provider) ?? '',
): ResponsesReasoningParams {
  const mapped = mapProviderEffortValue(provider, effort, model);
  return mapped ? { reasoning: { effort: mapped } } : {};
}

function detectProviderEffortParamFormat(
  provider: Pick<ProviderDefinition, 'id' | 'api_base'>,
): ProviderEffortParamFormat {
  const id = typeof provider.id === 'string' ? provider.id.toLowerCase() : '';
  const apiBase = typeof provider.api_base === 'string' ? provider.api_base.toLowerCase() : '';
  if (id.includes('deepseek') || apiBase.includes('deepseek.com')) return 'deepseek';
  if (id === 'zai' || id.includes('glm') || apiBase.includes('api.z.ai') || apiBase.includes('bigmodel.cn'))
    return 'zai';
  if (id.includes('openrouter') || apiBase.includes('openrouter.ai')) return 'openrouter';
  return 'openai';
}

function resolveDisabledEffortParams(
  provider: Pick<ProviderDefinition, 'id' | 'api_base'>,
  offValue: string | null | undefined,
): ResolvedEffortParams {
  switch (detectProviderEffortParamFormat(provider)) {
    case 'deepseek':
    case 'zai':
      return offValue
        ? { thinking: { type: 'disabled' }, reasoning_effort: offValue }
        : { thinking: { type: 'disabled' } };
    case 'openrouter':
      return { reasoning: { effort: offValue ?? 'none' } };
    case 'openai':
      return offValue ? { reasoning_effort: offValue } : {};
  }
}

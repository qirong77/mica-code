import type { LastUsedConfig } from './micaStorage.js';
import {
  firstProviderModel,
  isEffortOption,
  isNonEmptyString,
  isPositiveNumber,
  isRecord,
  providerSupportsModel,
  type EffortOption,
  type IMicaConfig,
  type PersistedMicaConfig,
  type ProviderDefinition,
} from './types.js';
import { clampProviderEffort } from './effort.js';
import { getModelContextWindowSizeFromConfig } from './modelRules.js';

export function mergeRuntimeConfig(config: PersistedMicaConfig, lastUsed: LastUsedConfig): IMicaConfig {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const providerId = resolveLastUsedProvider(providers, lastUsed.provider);
  const provider = providers.find((item) => item.id === providerId);
  const model = resolveLastUsedModel(provider, lastUsed.model, lastUsed.providerPreferences?.[providerId]?.model);
  const effort = resolveLastUsedEffort(provider, lastUsed.effort, model, lastUsed.providerPreferences?.[providerId]?.effort);
  return {
    ...config,
    providers,
    provider: providerId,
    model,
    effort,
    contextWindowSize: getModelContextWindowSizeFromConfig(model),
  };
}

export function readLegacyLastUsedConfig(config: PersistedMicaConfig): LastUsedConfig {
  return {
    provider: isNonEmptyString(config.provider) ? config.provider : undefined,
    model: isNonEmptyString(config.model) ? config.model : undefined,
    effort: isEffortOption(config.effort) ? config.effort : undefined,
    contextWindowSize: isPositiveNumber(config.contextWindowSize) ? config.contextWindowSize : undefined,
  };
}

export function readLegacyProviderLastUsedConfig(config: PersistedMicaConfig, providerId: unknown): LastUsedConfig {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const provider =
    (isNonEmptyString(providerId) ? providers.find((item) => item.id === providerId) : undefined) ?? providers[0];
  if (!provider) return {};
  return {
    provider: provider.id,
    model: isNonEmptyString(provider.model) ? provider.model : firstProviderModel(provider),
    effort: isEffortOption(provider.effort) ? provider.effort : undefined,
    contextWindowSize: isPositiveNumber(provider.contextWindowSize) ? provider.contextWindowSize : undefined,
  };
}

export function hasLastUsedConfig(lastUsed: LastUsedConfig): boolean {
  return Boolean(lastUsed.provider || lastUsed.model || lastUsed.effort || lastUsed.contextWindowSize);
}

export function hasLegacyRuntimeFields(config: PersistedMicaConfig): boolean {
  return (
    Object.prototype.hasOwnProperty.call(config, 'provider') ||
    Object.prototype.hasOwnProperty.call(config, 'model') ||
    Object.prototype.hasOwnProperty.call(config, 'effort') ||
    Object.prototype.hasOwnProperty.call(config, 'contextWindowSize')
  );
}

export function hasLegacyProviderRuntimeFields(config: PersistedMicaConfig): boolean {
  if (!Array.isArray(config.providers)) return false;
  return config.providers.some(
    (provider) =>
      isRecord(provider) &&
      (Object.prototype.hasOwnProperty.call(provider, 'model') ||
        Object.prototype.hasOwnProperty.call(provider, 'effort') ||
        Object.prototype.hasOwnProperty.call(provider, 'contextWindowSize') ||
        (Object.prototype.hasOwnProperty.call(provider, 'models') && isNonEmptyString(provider.get_model_url))),
  );
}

export function stripRuntimeFields(config: PersistedMicaConfig | IMicaConfig): PersistedMicaConfig {
  const {
    provider: _provider,
    model: _model,
    effort: _effort,
    contextWindowSize: _contextWindowSize,
    ...persisted
  } = config;
  return {
    ...persisted,
    providers: Array.isArray(persisted.providers) ? persisted.providers.map(stripProviderRuntimeFields) : [],
  } as PersistedMicaConfig;
}

function stripProviderRuntimeFields(provider: ProviderDefinition): ProviderDefinition {
  const { model: _model, effort: _effort, contextWindowSize: _contextWindowSize, models, ...persisted } = provider;
  if (provider.get_model_url) return persisted;
  return {
    ...persisted,
    ...(models ? { models } : {}),
  };
}

function resolveLastUsedProvider(providers: ProviderDefinition[], providerId: unknown): string {
  if (isNonEmptyString(providerId) && providers.some((provider) => provider.id === providerId)) return providerId;
  return providers[0]?.id ?? '';
}

function resolveLastUsedModel(
  provider: ProviderDefinition | undefined,
  model: unknown,
  preferenceModel?: unknown,
): string {
  if (!provider) return isNonEmptyString(model) ? model : '';
  if (isNonEmptyString(preferenceModel) && providerSupportsModel(provider, preferenceModel)) return preferenceModel;
  if (isNonEmptyString(model) && providerSupportsModel(provider, model)) return model;
  return firstProviderModel(provider) ?? '';
}

function resolveLastUsedEffort(
  provider: ProviderDefinition | undefined,
  effort: unknown,
  model: string,
  preferenceEffort?: unknown,
): EffortOption {
  const selectedPreference = isEffortOption(preferenceEffort) ? preferenceEffort : undefined;
  const fallback = isEffortOption(provider?.effort) ? provider.effort : 'medium';
  const selected = selectedPreference ?? (isEffortOption(effort) ? effort : fallback);
  return provider ? clampProviderEffort(provider, selected, model) : selected;
}

import { atom } from 'nanostores';
import {
  readLastUsedConfig,
  updateLastUsedConfig,
  updateProviderPreference,
  type LastUsedConfig,
} from './micaStorage.js';
import {
  CONFIG_PATH,
  firstProviderModel,
  isEffortOption,
  isNonEmptyString,
  providerSupportsModel,
  type EffortOption,
  type IMicaConfig,
  type PersistedMicaConfig,
  type ProviderDefinition,
} from './types.js';
import { readPersistedConfig, writePersistedConfig } from './persistence.js';
import { loadMissingProviderModelsFromStore, loadProviderModelsFromStore } from './providerModels.js';
import { getModelRule } from './getModelRule.js';

export {
  CONFIG_PATH,
  DEFAULT_MODEL_CONTEXT_SIZE,
  EFFORT_OPTIONS,
  PROVIDER_PROTOCOLS,
  providerSupportsModel,
} from './types.js';
export type {
  EffortMap,
  EffortOption,
  IMicaConfig,
  ModelEffortRule,
  ModelRequestPatch,
  ModelRule,
  PersistedMicaConfig,
  ProviderDefinition,
  ProviderProtocol,
  ResolvedEffortParams,
} from './types.js';
export {
  ensureModelRule,
  getModelEffortOptions,
  getModelRule,
  normalizeModelEffort,
  registerModelRuleResolver,
  registerModelRules,
  resolveModelRequestPatch,
} from './getModelRule.js';
export { resolveChatCompletionsEffortParams, resolveResponsesReasoningParams } from './effort.js';

const configAtom = atom<IMicaConfig>(readConfig());

export function readConfig(): IMicaConfig {
  const persisted = readPersistedConfig(CONFIG_PATH);
  const storedLastUsed = readLastUsedConfig();
  return mergeRuntimeConfig(persisted, storedLastUsed);
}

export function getConfig() {
  return configAtom.get();
}

export function updateConfig(updater: (config: IMicaConfig) => IMicaConfig): IMicaConfig {
  const next = updater(getConfig());
  configAtom.set(next);
  const currentPersisted = readPersistedConfig(CONFIG_PATH);
  const nextPersisted = stripRuntimeFields(next, currentPersisted);
  if (!persistedConfigsEqual(currentPersisted, nextPersisted)) {
    writePersistedConfig(CONFIG_PATH, nextPersisted);
  }
  updateLastUsedConfig({
    provider: next.provider,
    model: next.model,
    effort: next.effort,
  });
  updateProviderPreference(next.provider, { model: next.model, effort: next.effort });
  return next;
}

export async function loadProviderModels(providerId: string): Promise<string[]> {
  return loadProviderModelsFromStore({ getConfig, updateRuntimeConfig }, providerId);
}

export async function loadMissingProviderModels() {
  await loadMissingProviderModelsFromStore({ getConfig, updateRuntimeConfig });
}

function updateRuntimeConfig(updater: (config: IMicaConfig) => IMicaConfig): IMicaConfig {
  const next = updater(getConfig());
  configAtom.set(next);
  updateLastUsedConfig({
    provider: next.provider,
    model: next.model,
    effort: next.effort,
  });
  updateProviderPreference(next.provider, { model: next.model, effort: next.effort });
  return next;
}

function stripRuntimeFields(config: IMicaConfig, currentPersisted: PersistedMicaConfig): PersistedMicaConfig {
  const {
    provider: _provider,
    model: _model,
    effort: _effort,
    contextWindowSize: _contextWindowSize,
    ...persisted
  } = config;
  return {
    ...persisted,
    providers: stripRuntimeProviderFields(persisted.providers, currentPersisted.providers),
  };
}

function stripRuntimeProviderFields(
  providers: ProviderDefinition[],
  persistedProviders: ProviderDefinition[],
): ProviderDefinition[] {
  const persistedById = new Map(persistedProviders.map((provider) => [provider.id, provider]));
  return providers.map((provider) => stripRuntimeProviderModels(provider, persistedById.get(provider.id)));
}

function stripRuntimeProviderModels(
  provider: ProviderDefinition,
  persistedProvider: ProviderDefinition | undefined,
): ProviderDefinition {
  if (!provider.get_model_url) return provider;
  const { models: _runtimeModels, ...withoutRuntimeModels } = provider;
  if (persistedProvider?.models === undefined) return withoutRuntimeModels;
  return {
    ...withoutRuntimeModels,
    models: persistedProvider.models,
  };
}

function persistedConfigsEqual(a: PersistedMicaConfig, b: PersistedMicaConfig): boolean {
  return stableJson(a) === stableJson(b);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function mergeRuntimeConfig(config: PersistedMicaConfig, lastUsed: LastUsedConfig): IMicaConfig {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const providerId = resolveLastUsedProvider(providers, lastUsed.provider);
  const provider = providers.find((item) => item.id === providerId);
  const model = resolveLastUsedModel(provider, lastUsed.model, lastUsed.providerPreferences?.[providerId]?.model);
  const effort = resolveLastUsedEffort(provider, lastUsed.effort, lastUsed.providerPreferences?.[providerId]?.effort);
  return {
    ...config,
    providers,
    provider: providerId,
    model,
    effort,
    contextWindowSize: getModelRule(model).contextSize,
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
  preferenceEffort?: unknown,
): EffortOption {
  const selectedPreference = isEffortOption(preferenceEffort) ? preferenceEffort : undefined;
  const selected = selectedPreference ?? (isEffortOption(effort) ? effort : 'medium');
  return provider?.supportsEffort === false ? 'none' : selected;
}

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
import { ConfigValidationError, validateConfig } from './validation.js';
import { loadMissingProviderModelsFromStore, loadProviderModelsFromStore } from './providerModels.js';
import { clampProviderEffort } from './effort.js';
import { getModelContextWindowSizeFromConfig } from './modelRules.js';

export {
  CONFIG_PATH,
  DEFAULT_MODEL_CONTEXT_SIZE,
  EFFORT_OPTIONS,
  PROVIDER_PROTOCOLS,
  providerSupportsModel,
} from './types.js';
export type {
  ConfigValidationIssue,
  ConfigValidationResult,
  ConfigValidationSeverity,
  EffortMap,
  EffortOption,
  IMicaConfig,
  ModelRule,
  PersistedMicaConfig,
  ProviderDefinition,
  ProviderProtocol,
  ResolvedEffortParams,
} from './types.js';
export { DEFAULT_EFFORT_MAP, getEffortMapFromConfig, getModelContextWindowSizeFromConfig } from './modelRules.js';
export {
  clampProviderEffort,
  getProviderEffortOptions,
  mapProviderEffortValue,
  resolveChatCompletionsEffortParams,
  resolveResponsesReasoningParams,
} from './effort.js';
export { ConfigValidationError, formatConfigValidationIssues, validateConfig } from './validation.js';

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
  writePersistedConfig(CONFIG_PATH, stripRuntimeFields(next));
  updateLastUsedConfig({
    provider: next.provider,
    model: next.model,
    effort: next.effort,
  });
  updateProviderPreference(next.provider, { model: next.model, effort: next.effort });
  return next;
}

export function assertValidConfig(config: IMicaConfig = getConfig()): void {
  const result = validateConfig(config);
  if (!result.ok) {
    throw new ConfigValidationError(result.issues);
  }
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

function stripRuntimeFields(config: IMicaConfig): PersistedMicaConfig {
  const {
    provider: _provider,
    model: _model,
    effort: _effort,
    contextWindowSize: _contextWindowSize,
    ...persisted
  } = config;
  return persisted;
}

function mergeRuntimeConfig(config: PersistedMicaConfig, lastUsed: LastUsedConfig): IMicaConfig {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const providerId = resolveLastUsedProvider(providers, lastUsed.provider);
  const provider = providers.find((item) => item.id === providerId);
  const model = resolveLastUsedModel(provider, lastUsed.model, lastUsed.providerPreferences?.[providerId]?.model);
  const effort = resolveLastUsedEffort(
    provider,
    lastUsed.effort,
    model,
    lastUsed.providerPreferences?.[providerId]?.effort,
  );
  return {
    ...config,
    providers,
    provider: providerId,
    model,
    effort,
    contextWindowSize: getModelContextWindowSizeFromConfig(model),
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
  const selected = selectedPreference ?? (isEffortOption(effort) ? effort : 'medium');
  return provider ? clampProviderEffort(provider, selected, model) : selected;
}

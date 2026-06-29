import { atom } from 'nanostores';
import { readLastUsedConfig, updateLastUsedConfig } from './micaStorage.js';
import { CONFIG_PATH, type IMicaConfig } from './types.js';
import { readPersistedConfig, writePersistedConfig } from './persistence.js';
import {
  hasLastUsedConfig,
  hasLegacyProviderRuntimeFields,
  hasLegacyRuntimeFields,
  mergeRuntimeConfig,
  readLegacyLastUsedConfig,
  readLegacyProviderLastUsedConfig,
  stripRuntimeFields,
} from './migration.js';
import { ConfigValidationError, formatConfigValidationIssues, validateConfig } from './validation.js';
import { loadMissingProviderModelsFromStore, loadProviderModelsFromStore } from './providerModels.js';

export {
  CONFIG_PATH,
  DEFAULT_MODEL_CONTEXT_SIZE,
  DEFAULT_PROVIDER_PROTOCOL,
  EFFORT_OPTIONS,
  PROVIDER_PROTOCOLS,
  resolveProviderProtocol,
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
  const legacyLastUsed = readLegacyLastUsedConfig(persisted);
  const storedLastUsed = readLastUsedConfig();
  const legacyProviderLastUsed = readLegacyProviderLastUsedConfig(
    persisted,
    legacyLastUsed.provider ?? storedLastUsed.provider,
  );
  const lastUsed = { ...legacyProviderLastUsed, ...legacyLastUsed, ...storedLastUsed };
  const hasLegacyRuntimeState = hasLegacyRuntimeFields(persisted);
  const hasLegacyProviderRuntimeState = hasLegacyProviderRuntimeFields(persisted);
  const normalizedPersisted =
    hasLegacyRuntimeState || hasLegacyProviderRuntimeState ? stripRuntimeFields(persisted) : persisted;
  if (hasLegacyRuntimeState || hasLegacyProviderRuntimeState) {
    writePersistedConfig(CONFIG_PATH, normalizedPersisted);
  }
  if ((hasLegacyRuntimeState || hasLegacyProviderRuntimeState) && hasLastUsedConfig(lastUsed)) {
    updateLastUsedConfig(lastUsed);
  }
  return mergeRuntimeConfig(normalizedPersisted, lastUsed);
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
    contextWindowSize: next.contextWindowSize,
  });
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
    contextWindowSize: next.contextWindowSize,
  });
  return next;
}

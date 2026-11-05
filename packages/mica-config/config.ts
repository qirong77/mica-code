import { atom } from 'nanostores';
import {
  CONFIG_PATH,
  firstProviderModel,
  type EffortOption,
  type IMicaConfig,
  type PersistedMicaConfig,
} from './types.js';
import { readPersistedConfig, writePersistedConfig } from './persistence.js';
import { ensureModelRule, getModelRule, normalizeModelEffort } from './getModelRule.js';
import { isEnvOnlyProvider, synthesizeEnvProviders } from './envProvider.js';
import { normalizeCapabilitySelection, type CapabilitySelection } from '@packages/mica-common/capabilities.js';

export {
  CONFIG_PATH,
  DEFAULT_MODEL_CONTEXT_SIZE,
  KNOWN_EFFORT_LEVELS,
  PROVIDER_PROTOCOLS,
  providerForModel,
  providerSupportsModel,
} from './types.js';
export type {
  EffortOption,
  KnownEffortLevel,
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
  orderEffortLevels,
  registerModelRuleResolver,
  registerModelRules,
} from './getModelRule.js';
export { resolveEffortParams } from './effort.js';
export { isEffortLevelRejected, markEffortLevelRejected, resetRejectedEffortLevels } from './effortRejections.js';
export type { EffortParamsRequest } from './effort.js';

const configAtom = atom<IMicaConfig>(readConfig());

export function readConfig(): IMicaConfig {
  const persisted = readPersistedConfig(CONFIG_PATH);
  return mergeRuntimeConfig(persisted);
}

export function getConfig() {
  return configAtom.get();
}

export function updateConfig(updater: (config: IMicaConfig) => IMicaConfig): IMicaConfig {
  const next = updater(getConfig());
  configAtom.set(next);
  const currentPersisted = readPersistedConfig(CONFIG_PATH);
  const nextPersisted = stripRuntimeFields(next);
  if (!persistedConfigsEqual(currentPersisted, nextPersisted)) {
    writePersistedConfig(CONFIG_PATH, nextPersisted);
  }
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
  return {
    ...persisted,
    providers: persisted.providers.filter((provider) => !isEnvOnlyProvider(provider.id)),
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

/** Reload new-session defaults from disk. */
export function resetSessionModelDefaults(): IMicaConfig {
  const persisted = readPersistedConfig(CONFIG_PATH);
  const next = mergeRuntimeConfig(persisted);
  configAtom.set(next);
  return next;
}

/** Resolve model metadata before creating a new session. */
export async function prepareSessionModelDefaults(): Promise<IMicaConfig> {
  const config = resetSessionModelDefaults();
  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider) {
    throw new Error('Cannot prepare session model defaults: no default provider is configured.');
  }
  if (!config.model.trim()) {
    throw new Error(
      `Cannot prepare session model defaults: provider ${provider.id} has no model configured. ` +
        `Add one to its "models" list in config.json — the dynamic model discovery (get_model_url) was removed.`,
    );
  }
  await ensureModelRule(config.model, undefined, provider);
  // Recover the original configured effort after loading metadata: the first reset may
  // have normalized it against incomplete rules.
  const prepared = resetSessionModelDefaults();
  if (!prepared.provider || !prepared.model.trim()) {
    throw new Error('Cannot prepare session model defaults: the default provider or model is unavailable.');
  }
  return prepared;
}

function mergeRuntimeConfig(config: PersistedMicaConfig): IMicaConfig {
  const configured = Array.isArray(config.providers) ? config.providers : [];
  const providers = synthesizeEnvProviders(configured);
  const defaults = config.defaultModel;
  const provider = defaults ? providers.find((item) => item.id === defaults.provider) : providers[0];
  const configuredProvider = configured.find((item) => item.id === provider?.id);
  const model =
    defaults?.model ??
    (configuredProvider ? firstProviderModel(configuredProvider) : undefined) ??
    (provider ? firstProviderModel(provider) : undefined) ??
    '';
  const rule = getModelRule(model, provider);
  const effort: EffortOption =
    provider?.supportsEffort === false
      ? 'none'
      : defaults?.effort === undefined
        ? rule.defaultEffort
        : normalizeModelEffort(model, defaults.effort, provider);
  return {
    ...config,
    providers,
    provider: provider?.id ?? '',
    model,
    effort,
    contextWindowSize: rule.contextSize,
  };
}

/** 新会话默认能力：config.json 的 `capabilityDefaults`，缺失即全部启用。 */
export function readCapabilityDefaults(): CapabilitySelection {
  return normalizeCapabilitySelection(readPersistedConfig(CONFIG_PATH).capabilityDefaults);
}

/**
 * 保存新会话默认能力。只影响之后创建的会话，已有会话读取自己的 snapshot，
 * 不会被这次写入改写。
 */
export function updateCapabilityDefaults(selection: CapabilitySelection): CapabilitySelection {
  const next = normalizeCapabilitySelection(selection);
  updateConfig((config) => ({
    ...config,
    capabilityDefaults: {
      disabledSkills: next.disabledSkills,
      disabledTools: next.disabledTools,
      disabledMcpServers: next.disabledMcpServers,
    },
  }));
  return next;
}

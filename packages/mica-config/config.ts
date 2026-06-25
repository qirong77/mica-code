import { atom } from 'nanostores';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import defaultConfig from './default.json';
import modelRules from './model-rules.json';
import { readLastUsedConfig, updateLastUsedConfig, type LastUsedConfig } from './micaStorage.js';

export const CONFIG_PATH = resolveMicaHomePath('config.json');
export const EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const DEFAULT_MODEL_CONTEXT_SIZE = 256;

export type EffortOption = (typeof EFFORT_OPTIONS)[number];
export type EffortMap = Partial<Record<EffortOption, string | null>>;
export const DEFAULT_EFFORT_MAP: EffortMap = {
  none: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
};

export interface ProviderDefinition {
  id: string;
  name?: string;
  api_base: string;
  api_key?: string;
  model?: string;
  effort?: EffortOption;
  models?: string[];
  contextWindowSize?: number;
  supportsEffort?: boolean;
  get_model_url?: string;
}

export interface PersistedMicaConfig {
  providers: ProviderDefinition[];
  serperApiKey?: string;
  [key: string]: unknown;
}

export interface IMicaConfig extends PersistedMicaConfig {
  provider: string;
  model: string;
  effort: EffortOption;
  contextWindowSize: number;
  providers: ProviderDefinition[];
}

export type ModelRule = {
  name?: string;
  modelKeysIncludes: string[];
  contextSize?: number | string;
  enableEffort?: boolean;
  effortMap?: EffortMap;
};

const MODEL_RULES = modelRules as ModelRule[];

export type ConfigValidationSeverity = 'error' | 'warning';

export type ConfigValidationIssue = {
  severity: ConfigValidationSeverity;
  code: string;
  path: string;
  message: string;
  suggestion?: string;
};

export type ConfigValidationResult = {
  ok: boolean;
  issues: ConfigValidationIssue[];
};

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[], configPath = CONFIG_PATH) {
    super(formatConfigValidationIssues(issues, configPath));
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

const configAtom = atom<IMicaConfig>(readConfig());

export function readConfig(): IMicaConfig {
  const persisted = readPersistedConfig();
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
    writePersistedConfig(normalizedPersisted);
  }
  if ((hasLegacyRuntimeState || hasLegacyProviderRuntimeState) && hasLastUsedConfig(lastUsed)) {
    updateLastUsedConfig(lastUsed);
  }
  return mergeRuntimeConfig(normalizedPersisted, lastUsed);
}

function readPersistedConfig(): PersistedMicaConfig {
  ensureConfigFile();
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as PersistedMicaConfig;
  } catch {
    backupInvalidConfig();
    writeDefaultConfig();
    return defaultConfig as PersistedMicaConfig;
  }
}

export function getConfig() {
  return configAtom.get();
}

export function updateConfig(updater: (config: IMicaConfig) => IMicaConfig): IMicaConfig {
  const next = updater(getConfig());
  configAtom.set(next);
  writePersistedConfig(stripRuntimeFields(next));
  updateLastUsedConfig({
    provider: next.provider,
    model: next.model,
    effort: next.effort,
    contextWindowSize: next.contextWindowSize,
  });
  return next;
}

function mergeRuntimeConfig(config: PersistedMicaConfig, lastUsed: LastUsedConfig): IMicaConfig {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const providerId = resolveLastUsedProvider(providers, lastUsed.provider);
  const provider = providers.find((item) => item.id === providerId);
  const model = resolveLastUsedModel(provider, lastUsed.model);
  const effort = resolveLastUsedEffort(provider, lastUsed.effort, model);
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

function resolveLastUsedModel(provider: ProviderDefinition | undefined, model: unknown): string {
  if (!provider) return isNonEmptyString(model) ? model : '';
  if (isNonEmptyString(model) && providerSupportsModel(provider, model)) return model;
  return firstProviderModel(provider) ?? '';
}

function resolveLastUsedEffort(provider: ProviderDefinition | undefined, effort: unknown, model: string): EffortOption {
  const fallback = isEffortOption(provider?.effort) ? provider.effort : 'medium';
  const selected = isEffortOption(effort) ? effort : fallback;
  return provider ? clampProviderEffort(provider, selected, model) : selected;
}

function providerSupportsModel(provider: ProviderDefinition, model: string): boolean {
  if (provider.model === model) return true;
  if (!Array.isArray(provider.models) || provider.models.length === 0) return true;
  return provider.models.includes(model);
}

function readLegacyLastUsedConfig(config: PersistedMicaConfig): LastUsedConfig {
  return {
    provider: isNonEmptyString(config.provider) ? config.provider : undefined,
    model: isNonEmptyString(config.model) ? config.model : undefined,
    effort: isEffortOption(config.effort) ? config.effort : undefined,
    contextWindowSize: isPositiveNumber(config.contextWindowSize) ? config.contextWindowSize : undefined,
  };
}

function readLegacyProviderLastUsedConfig(config: PersistedMicaConfig, providerId: unknown): LastUsedConfig {
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

function hasLastUsedConfig(lastUsed: LastUsedConfig): boolean {
  return Boolean(lastUsed.provider || lastUsed.model || lastUsed.effort || lastUsed.contextWindowSize);
}

function hasLegacyRuntimeFields(config: PersistedMicaConfig): boolean {
  return (
    Object.prototype.hasOwnProperty.call(config, 'provider') ||
    Object.prototype.hasOwnProperty.call(config, 'model') ||
    Object.prototype.hasOwnProperty.call(config, 'effort') ||
    Object.prototype.hasOwnProperty.call(config, 'contextWindowSize')
  );
}

function hasLegacyProviderRuntimeFields(config: PersistedMicaConfig): boolean {
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

function stripRuntimeFields(config: PersistedMicaConfig | IMicaConfig): PersistedMicaConfig {
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

export function validateConfig(config: IMicaConfig): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];
  const providers = Array.isArray(config.providers) ? (config.providers as unknown[]) : [];
  const providerIds = providers.flatMap((provider) =>
    isRecord(provider) && isNonEmptyString(provider.id) ? [provider.id] : [],
  );
  const configuredProvider = isNonEmptyString(config.provider) ? config.provider : '';

  if (!isNonEmptyString(config.provider)) {
    issues.push({
      severity: 'error',
      code: 'provider_empty',
      path: 'provider',
      message: '顶层 "provider" 不能为空。',
      suggestion: '请把 "provider" 设置为 providers[].id 中的一个值。',
    });
  }

  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    issues.push({
      severity: 'error',
      code: 'providers_empty',
      path: 'providers',
      message: '"providers" 必须是非空数组。',
      suggestion: '请至少配置一个 provider。',
    });
  }

  const seenProviderIds = new Map<string, number>();
  providers.forEach((provider, index) => {
    if (!isRecord(provider)) {
      issues.push({
        severity: 'error',
        code: 'provider_invalid',
        path: `providers[${index}]`,
        message: 'provider 配置项必须是 object。',
      });
      return;
    }

    if (!isNonEmptyString(provider.id)) {
      issues.push({
        severity: 'error',
        code: 'provider_id_empty',
        path: `providers[${index}].id`,
        message: 'provider id 不能为空。',
      });
      return;
    }

    const firstIndex = seenProviderIds.get(provider.id);
    if (firstIndex !== undefined) {
      issues.push({
        severity: 'error',
        code: 'provider_id_duplicate',
        path: `providers[${index}].id`,
        message: `provider id "${provider.id}" 重复。`,
        suggestion: `请修改 providers[${index}].id 或 providers[${firstIndex}].id，确保每个 provider id 唯一。`,
      });
    } else {
      seenProviderIds.set(provider.id, index);
    }

    const isCurrentProvider = provider.id === configuredProvider;
    const invalidProviderSeverity: ConfigValidationSeverity = isCurrentProvider ? 'error' : 'warning';
    if (!isNonEmptyString(provider.api_base)) {
      issues.push({
        severity: invalidProviderSeverity,
        code: 'provider_api_base_empty',
        path: `providers[${index}].api_base`,
        message: `provider "${provider.id}" 的 api_base 不能为空。`,
      });
    }
    const hasProviderEffort = Object.prototype.hasOwnProperty.call(provider, 'effort');
    const providerEffort = isEffortOption(provider.effort) ? provider.effort : undefined;
    if (hasProviderEffort && !providerEffort) {
      issues.push({
        severity: invalidProviderSeverity,
        code: 'provider_effort_invalid',
        path: `providers[${index}].effort`,
        message: `provider "${provider.id}" 的 effort 必须是 ${EFFORT_OPTIONS.join(' | ')}。`,
      });
    }
    const providerModel = firstProviderModel(provider as unknown as ProviderDefinition);
    const providerEffortOptions =
      providerEffort && isNonEmptyString(provider.api_base) && providerModel
        ? getProviderEffortOptions(provider as unknown as ProviderDefinition, providerModel)
        : undefined;
    if (providerEffort && provider.supportsEffort === false && providerEffort !== 'none') {
      issues.push({
        severity: 'warning',
        code: 'provider_effort_ignored',
        path: `providers[${index}].effort`,
        message: `provider "${provider.id}" 不使用 reasoning effort，建议设置为 none。`,
      });
    } else if (providerEffort && providerEffortOptions && !providerEffortOptions.includes(providerEffort)) {
      issues.push({
        severity: 'warning',
        code: 'provider_effort_unsupported',
        path: `providers[${index}].effort`,
        message: `provider "${provider.id}" 的默认 model "${providerModel}" 不支持 effort "${providerEffort}"。`,
        suggestion: `可用 effort: ${providerEffortOptions.join(' | ')}。`,
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(provider, 'contextWindowSize') &&
      !isPositiveNumber(provider.contextWindowSize)
    ) {
      issues.push({
        severity: invalidProviderSeverity,
        code: 'provider_context_window_invalid',
        path: `providers[${index}].contextWindowSize`,
        message: `provider "${provider.id}" 的 contextWindowSize 必须是正数。`,
      });
    }
    if (provider.models !== undefined && !isNonEmptyStringArray(provider.models)) {
      issues.push({
        severity: invalidProviderSeverity,
        code: 'provider_models_invalid',
        path: `providers[${index}].models`,
        message: `provider "${provider.id}" 的 models 必须是非空字符串数组。`,
      });
    }
  });

  if (!isEffortOption(config.effort)) {
    issues.push({
      severity: 'error',
      code: 'effort_invalid',
      path: 'effort',
      message: `顶层 "effort" 必须是 ${EFFORT_OPTIONS.join(' | ')}。`,
    });
  }

  if (!isPositiveNumber(config.contextWindowSize)) {
    issues.push({
      severity: 'error',
      code: 'context_window_invalid',
      path: 'contextWindowSize',
      message: '顶层 "contextWindowSize" 必须是正数。',
    });
  }

  const currentProvider = providers.find(
    (provider): provider is ProviderDefinition => isRecord(provider) && provider.id === config.provider,
  );
  if (!currentProvider) {
    const matchingProviderIds = findProvidersForModel(config, providers);
    issues.push({
      severity: 'error',
      code: 'provider_not_found',
      path: 'provider',
      message: `当前 provider "${config.provider || '(empty)'}" 不存在，必须匹配 providers[].id。`,
      suggestion: providerNotFoundSuggestion(providerIds, config.model, matchingProviderIds),
    });
  } else {
    const currentProviderIndex = providers.indexOf(currentProvider);
    if (!isNonEmptyString(config.model)) {
      issues.push({
        severity: isNonEmptyString(currentProvider.get_model_url) ? 'warning' : 'error',
        code: 'model_empty',
        path: 'model',
        message: '顶层 "model" 不能为空。',
        suggestion: isNonEmptyString(currentProvider.get_model_url)
          ? `provider "${currentProvider.id}" 配置了 get_model_url，模型列表会在运行时获取。`
          : firstProviderModel(currentProvider)
            ? `可以把 "model" 设置为当前 provider 的默认模型 "${firstProviderModel(currentProvider)}"。`
            : undefined,
      });
    } else if (
      isNonEmptyStringArray(currentProvider.models) &&
      !currentProvider.models.includes(config.model) &&
      currentProvider.model !== config.model
    ) {
      const matchingProviderIds = findProvidersForModel(config, providers);
      issues.push({
        severity: 'error',
        code: 'model_not_supported',
        path: 'model',
        message: `当前 model "${config.model}" 不在 provider "${currentProvider.id}" 的 models 列表中。`,
        suggestion: modelNotSupportedSuggestion(config.model, currentProvider, matchingProviderIds),
      });
    }

    if (!isNonEmptyString(currentProvider.api_key)) {
      issues.push({
        severity: 'warning',
        code: 'provider_api_key_missing',
        path: `providers[${currentProviderIndex}].api_key`,
        message: `当前 provider "${currentProvider.id}" 没有配置 api_key。`,
        suggestion: '可以先启动 UI，但首次发送消息前需要配置 api_key。',
      });
    }

    const currentProviderEffortOptions =
      isEffortOption(config.effort) && isNonEmptyString(currentProvider.api_base) && isNonEmptyString(config.model)
        ? getProviderEffortOptions(currentProvider, config.model)
        : undefined;
    if (currentProvider.supportsEffort === false && config.effort !== 'none') {
      issues.push({
        severity: 'warning',
        code: 'effort_ignored',
        path: 'effort',
        message: `当前 provider "${currentProvider.id}" 不使用 reasoning effort，运行时会显示为 none。`,
      });
    } else if (currentProviderEffortOptions && !currentProviderEffortOptions.includes(config.effort)) {
      issues.push({
        severity: 'error',
        code: 'effort_not_supported_by_provider',
        path: 'effort',
        message: `当前 provider "${currentProvider.id}" 的 model "${config.model}" 不支持 effort "${config.effort}"。`,
        suggestion: `可用 effort: ${currentProviderEffortOptions.join(' | ')}。`,
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    issues,
  };
}

export function assertValidConfig(config: IMicaConfig = getConfig()): void {
  const result = validateConfig(config);
  if (!result.ok) {
    throw new ConfigValidationError(result.issues);
  }
}

export function formatConfigValidationIssues(issues: ConfigValidationIssue[], configPath = CONFIG_PATH): string {
  if (issues.length === 0) return `配置文件正常：${configPath}`;
  const lines = [`配置文件有问题：${configPath}`];
  for (const issue of issues) {
    lines.push('', `[${issue.severity}] ${issue.path}`, issue.message);
    if (issue.suggestion) lines.push(`建议：${issue.suggestion}`);
  }
  return lines.join('\n');
}

export async function loadProviderModels(providerId: string): Promise<string[]> {
  const provider = requireProvider(getConfig(), providerId);
  if (!provider.get_model_url) {
    return provider.models ?? [];
  }

  const response = await fetch(provider.get_model_url, {
    headers: provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : undefined,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch models for provider ${provider.id}: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  const payload = (await response.json()) as unknown;
  const models = parseModelIds(payload);
  if (!models.length) {
    throw new Error(`Invalid model list for provider ${provider.id}`);
  }

  updateRuntimeConfig((config) => {
    const providers = config.providers.map((item) => {
      if (item.id !== providerId) return item;
      const currentModel = firstProviderModel(item) ?? '';
      const model = models.includes(currentModel) ? currentModel : models[0]!;
      const provider = {
        ...item,
        models,
        model,
        contextWindowSize: getModelContextWindowSizeFromConfig(model),
      };
      return {
        ...provider,
        effort: clampProviderEffort(provider, item.effort ?? config.effort, model),
      };
    });
    const current = config.provider === providerId ? providers.find((item) => item.id === providerId) : null;
    const model = current && !models.includes(config.model) ? models[0]! : config.model;
    return {
      ...config,
      providers,
      model,
      contextWindowSize: current ? getModelContextWindowSizeFromConfig(model) : config.contextWindowSize,
      effort: current ? clampProviderEffort(current, config.effort, model) : config.effort,
    };
  });
  return models;
}

export async function loadMissingProviderModels() {
  const providers = getConfig().providers.filter((provider) => provider.get_model_url && !provider.models?.length);
  await Promise.all(
    providers.map(async (provider) => {
      try {
        await loadProviderModels(provider.id);
      } catch (error) {
        console.error(`Failed to fetch models for provider ${provider.id}:`, error);
      }
    }),
  );
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

export function getProviderEffortOptions(
  provider: ProviderDefinition,
  model = firstProviderModel(provider) ?? '',
): EffortOption[] {
  if (provider.supportsEffort === false) return ['none'];
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

export type ResolvedEffortParams = Record<string, unknown>;

export function resolveProviderEffortParams(
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

export function getEffortMapFromConfig(modelId: string): EffortMap | null {
  const rule = findModelRule(modelId);
  if (rule?.enableEffort === false) return null;
  return rule?.effortMap ?? DEFAULT_EFFORT_MAP;
}

export function getModelContextWindowSizeFromConfig(modelId: string): number {
  return parseModelContextSize(findModelRule(modelId)?.contextSize ?? DEFAULT_MODEL_CONTEXT_SIZE);
}

type ProviderEffortParamFormat = 'openai' | 'deepseek' | 'zai' | 'openrouter';

function findModelRule(modelId: string): ModelRule | undefined {
  const normalizedModelId = modelId.toLowerCase();
  return MODEL_RULES.find((rule) =>
    rule.modelKeysIncludes.map((key) => key.toLowerCase()).some((key) => normalizedModelId.includes(key)),
  );
}

function parseModelContextSize(value: number | string): number {
  if (typeof value === 'number') return Math.max(1, Math.round(value * 1000));
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return DEFAULT_MODEL_CONTEXT_SIZE * 1000;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return DEFAULT_MODEL_CONTEXT_SIZE * 1000;
  const unit = match[2];
  if (unit === 'm') return Math.round(amount * 1_000_000);
  return Math.round(amount * 1000);
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

function hasOwnEffort(effortMap: EffortMap, effort: EffortOption): boolean {
  return Object.prototype.hasOwnProperty.call(effortMap, effort);
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

function ensureConfigFile() {
  if (existsSync(CONFIG_PATH)) return;
  ensureConfigDir();
  writeDefaultConfig();
}

function ensureConfigDir() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function writeDefaultConfig() {
  writePersistedConfig(defaultConfig as PersistedMicaConfig);
}

function writePersistedConfig(config: PersistedMicaConfig) {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(stripRuntimeFields(config), null, 2)}\n`, 'utf-8');
}

function backupInvalidConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return;
    renameSync(CONFIG_PATH, `${CONFIG_PATH}.invalid-${Date.now()}`);
  } catch {
    // If the backup fails, still try to restore a usable default config.
  }
}

function requireProvider(config: IMicaConfig, providerId: string): ProviderDefinition {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${providerId || '(empty)'}`);
  }
  return provider;
}

function providerNotFoundSuggestion(providerIds: string[], model: string, matchingProviderIds: string[]): string {
  const parts: string[] = [];
  if (providerIds.length > 0) {
    parts.push(`可用 provider: ${providerIds.join(', ')}。`);
  }
  if (isNonEmptyString(model) && matchingProviderIds.length > 0) {
    parts.push(`当前 model "${model}" 可匹配 provider: ${matchingProviderIds.join(', ')}。`);
    if (matchingProviderIds.length === 1) {
      parts.push(`可以把 "provider" 改为 "${matchingProviderIds[0]}"。`);
    }
  }
  return parts.join(' ');
}

function modelNotSupportedSuggestion(
  model: string,
  currentProvider: ProviderDefinition,
  matchingProviderIds: string[],
): string | undefined {
  if (matchingProviderIds.length === 1) {
    return `当前 model "${model}" 可匹配 provider "${matchingProviderIds[0]}"，可以切换 provider。`;
  }
  if (matchingProviderIds.length > 1) {
    return `当前 model "${model}" 可匹配这些 provider: ${matchingProviderIds.join(', ')}。`;
  }
  const firstModel = firstProviderModel(currentProvider);
  if (isNonEmptyString(firstModel)) {
    return `可以把 "model" 改为当前 provider 支持的模型，例如 "${firstModel}"。`;
  }
  return undefined;
}

function findProvidersForModel(config: IMicaConfig, providers: unknown[]): string[] {
  if (!isNonEmptyString(config.model)) return [];
  return providers
    .flatMap((provider) => {
      if (!isRecord(provider)) return [];
      const matchesModel =
        provider.model === config.model || (Array.isArray(provider.models) && provider.models.includes(config.model));
      return matchesModel ? [provider.id] : [];
    })
    .filter(isNonEmptyString);
}

function firstProviderModel(provider: ProviderDefinition | Record<string, unknown>): string | undefined {
  if (isNonEmptyString(provider.model)) return provider.model;
  if (Array.isArray(provider.models)) return provider.models.find(isNonEmptyString);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isEffortOption(value: unknown): value is EffortOption {
  return EFFORT_OPTIONS.includes(value as EffortOption);
}

function parseModelIds(payload: unknown): string[] {
  if (!isModelListResponse(payload)) {
    return [];
  }

  return [
    ...new Set(
      payload.data.flatMap((item) => {
        if (isModelObject(item)) {
          return item.id;
        }
        return [];
      }),
    ),
  ];
}

function isModelListResponse(payload: unknown): payload is { data: unknown[] } {
  return Boolean(
    payload && typeof payload === 'object' && 'data' in payload && Array.isArray((payload as { data?: unknown }).data),
  );
}

function isModelObject(item: unknown): item is { id: string } {
  return Boolean(
    item &&
    typeof item === 'object' &&
    'id' in item &&
    typeof (item as { id?: unknown }).id === 'string' &&
    (item as { id: string }).id.length > 0,
  );
}

function resolveMicaHomePath(...parts: string[]): string {
  const micaHome = process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : resolve(homedir(), '.mica');
  return resolve(micaHome, ...parts);
}

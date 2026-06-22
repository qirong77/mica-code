import { atom } from 'nanostores';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import defaultConfig from './default.json';

export const CONFIG_PATH = resolve(homedir(), '.mica', 'config.json');
export const EFFORT_OPTIONS = ['none', 'low', 'medium', 'high'] as const;

export type EffortOption = (typeof EFFORT_OPTIONS)[number];

export interface ProviderDefinition {
  id: string;
  name?: string;
  api_base: string;
  api_key?: string;
  model: string;
  effort: EffortOption;
  models?: string[];
  contextWindowSize: number;
  supportsEffort?: boolean;
  get_model_url?: string;
}

export interface IMicaConfig {
  provider: string;
  model: string;
  effort: EffortOption;
  contextWindowSize: number;
  providers: ProviderDefinition[];
}

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
  ensureConfigFile();
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as IMicaConfig;
  } catch {
    backupInvalidConfig();
    writeDefaultConfig();
    return defaultConfig as IMicaConfig;
  }
}

export function getConfig() {
  return configAtom.get();
}

export function updateConfig(updater: (config: IMicaConfig) => IMicaConfig): IMicaConfig {
  const next = updater(getConfig());
  configAtom.set(next);
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  return next;
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
    if (!isEffortOption(provider.effort)) {
      issues.push({
        severity: invalidProviderSeverity,
        code: 'provider_effort_invalid',
        path: `providers[${index}].effort`,
        message: `provider "${provider.id}" 的 effort 必须是 ${EFFORT_OPTIONS.join(' | ')}。`,
      });
    }
    if (!isPositiveNumber(provider.contextWindowSize)) {
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
        severity: 'error',
        code: 'model_empty',
        path: 'model',
        message: '顶层 "model" 不能为空。',
        suggestion: isNonEmptyString(currentProvider.model)
          ? `可以把 "model" 设置为当前 provider 的默认模型 "${currentProvider.model}"。`
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

    if (currentProvider.supportsEffort === false && config.effort !== 'none') {
      issues.push({
        severity: 'warning',
        code: 'effort_ignored',
        path: 'effort',
        message: `当前 provider "${currentProvider.id}" 不使用 reasoning effort，运行时会显示为 none。`,
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

  updateConfig((config) => {
    const providers = config.providers.map((item) =>
      item.id === providerId
        ? {
            ...item,
            models,
            model: models.includes(item.model) ? item.model : (models[0] ?? item.model),
          }
        : item,
    );
    const current = config.provider === providerId ? providers.find((item) => item.id === providerId) : null;
    return {
      ...config,
      providers,
      model: current && !models.includes(config.model) ? models[0] || current.model : config.model,
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

function ensureConfigFile() {
  if (existsSync(CONFIG_PATH)) return;
  ensureConfigDir();
  writeDefaultConfig();
}

function ensureConfigDir() {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
}

function writeDefaultConfig() {
  ensureConfigDir();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf-8');
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
  const firstModel = currentProvider.models?.find(isNonEmptyString) ?? currentProvider.model;
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

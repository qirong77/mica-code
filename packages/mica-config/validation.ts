import { getProviderEffortOptions } from './effort.js';
import {
  CONFIG_PATH,
  EFFORT_OPTIONS,
  PROVIDER_PROTOCOLS,
  findProvidersForModel,
  firstProviderModel,
  isEffortOption,
  isNonEmptyString,
  isNonEmptyStringArray,
  isPositiveNumber,
  isProviderProtocol,
  isRecord,
  type ConfigValidationIssue,
  type ConfigValidationResult,
  type ConfigValidationSeverity,
  type IMicaConfig,
  type ProviderDefinition,
} from './types.js';

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[], configPath = CONFIG_PATH) {
    super(formatConfigValidationIssues(issues, configPath));
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export function validateConfig(config: IMicaConfig): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];
  const providers = Array.isArray(config.providers) ? (config.providers as unknown[]) : [];
  const providerIds = providers.flatMap((provider) =>
    isRecord(provider) && isNonEmptyString(provider.id) ? [provider.id] : [],
  );
  const add = (severity: ConfigValidationSeverity, code: string, path: string, message: string, suggestion?: string) =>
    issues.push({ severity, code, path, message, ...(suggestion ? { suggestion } : {}) });

  if (!isNonEmptyString(config.provider)) {
    add(
      'error',
      'provider_empty',
      'provider',
      '顶层 "provider" 不能为空。',
      '请把 "provider" 设置为 providers[].id 中的一个值。',
    );
  }
  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    add('error', 'providers_empty', 'providers', '"providers" 必须是非空数组。', '请至少配置一个 provider。');
  }

  const configuredProvider = isNonEmptyString(config.provider) ? config.provider : '';
  const seenProviderIds = new Map<string, number>();
  providers.forEach((provider, index) => {
    if (!isRecord(provider)) {
      add('error', 'provider_invalid', `providers[${index}]`, 'provider 配置项必须是 object。');
      return;
    }
    if (!isNonEmptyString(provider.id)) {
      add('error', 'provider_id_empty', `providers[${index}].id`, 'provider id 不能为空。');
      return;
    }

    const firstIndex = seenProviderIds.get(provider.id);
    if (firstIndex === undefined) {
      seenProviderIds.set(provider.id, index);
    } else {
      add(
        'error',
        'provider_id_duplicate',
        `providers[${index}].id`,
        `provider id "${provider.id}" 重复。`,
        `请修改 providers[${index}].id 或 providers[${firstIndex}].id，确保每个 provider id 唯一。`,
      );
    }

    const severity: ConfigValidationSeverity = provider.id === configuredProvider ? 'error' : 'warning';
    if (!isNonEmptyString(provider.api_base)) {
      add(
        severity,
        'provider_api_base_empty',
        `providers[${index}].api_base`,
        `provider "${provider.id}" 的 api_base 不能为空。`,
      );
    }
    if (!isProviderProtocol(provider.protocol)) {
      add(
        severity,
        'provider_protocol_invalid',
        `providers[${index}].protocol`,
        `provider "${provider.id}" 的 protocol 必须是 ${PROVIDER_PROTOCOLS.join(' | ')}。`,
      );
    }

    if (provider.models !== undefined && !isNonEmptyStringArray(provider.models)) {
      add(
        severity,
        'provider_models_invalid',
        `providers[${index}].models`,
        `provider "${provider.id}" 的 models 必须是非空字符串数组。`,
      );
    }
  });

  if (!isEffortOption(config.effort)) {
    add('error', 'effort_invalid', 'effort', `顶层 "effort" 必须是 ${EFFORT_OPTIONS.join(' | ')}。`);
  }
  if (!isPositiveNumber(config.contextWindowSize)) {
    add('error', 'context_window_invalid', 'contextWindowSize', '顶层 "contextWindowSize" 必须是正数。');
  }

  const currentProvider = providers.find(
    (provider): provider is ProviderDefinition => isRecord(provider) && provider.id === config.provider,
  );
  if (!currentProvider) {
    const matches = findProvidersForModel(config, providers);
    add(
      'error',
      'provider_not_found',
      'provider',
      `当前 provider "${config.provider || '(empty)'}" 不存在，必须匹配 providers[].id。`,
      providerNotFoundSuggestion(providerIds, config.model, matches),
    );
    return validationResult(issues);
  }

  validateCurrentProvider(config, providers, currentProvider, add);
  return validationResult(issues);
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

function validateCurrentProvider(
  config: IMicaConfig,
  providers: unknown[],
  currentProvider: ProviderDefinition,
  add: (severity: ConfigValidationSeverity, code: string, path: string, message: string, suggestion?: string) => number,
) {
  const currentProviderIndex = providers.indexOf(currentProvider);
  if (!isNonEmptyString(config.model)) {
    add(
      isNonEmptyString(currentProvider.get_model_url) ? 'warning' : 'error',
      'model_empty',
      'model',
      '顶层 "model" 不能为空。',
      isNonEmptyString(currentProvider.get_model_url)
        ? `provider "${currentProvider.id}" 配置了 get_model_url，模型列表会在运行时获取。`
        : firstProviderModel(currentProvider)
          ? `可以把 "model" 设置为当前 provider 的默认模型 "${firstProviderModel(currentProvider)}"。`
          : undefined,
    );
  } else if (isNonEmptyStringArray(currentProvider.models) && !currentProvider.models.includes(config.model)) {
    add(
      'error',
      'model_not_supported',
      'model',
      `当前 model "${config.model}" 不在 provider "${currentProvider.id}" 的 models 列表中。`,
      modelNotSupportedSuggestion(config.model, currentProvider, findProvidersForModel(config, providers)),
    );
  }

  if (!isNonEmptyString(currentProvider.api_key)) {
    add(
      'warning',
      'provider_api_key_missing',
      `providers[${currentProviderIndex}].api_key`,
      `当前 provider "${currentProvider.id}" 没有配置 api_key。`,
      '可以先启动 UI，但首次发送消息前需要配置 api_key。',
    );
  }

  const effortOptions =
    isEffortOption(config.effort) && isNonEmptyString(currentProvider.api_base) && isNonEmptyString(config.model)
      ? getProviderEffortOptions(currentProvider, config.model)
      : undefined;
  if (currentProvider.supportsEffort === false && config.effort !== 'none') {
    add(
      'warning',
      'effort_ignored',
      'effort',
      `当前 provider "${currentProvider.id}" 不使用 reasoning effort，运行时会显示为 none。`,
    );
  } else if (effortOptions && !effortOptions.includes(config.effort)) {
    add(
      'error',
      'effort_not_supported_by_provider',
      'effort',
      `当前 provider "${currentProvider.id}" 的 model "${config.model}" 不支持 effort "${config.effort}"。`,
      `可用 effort: ${effortOptions.join(' | ')}。`,
    );
  }
}

function validationResult(issues: ConfigValidationIssue[]): ConfigValidationResult {
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

function providerNotFoundSuggestion(providerIds: string[], model: string, matchingProviderIds: string[]): string {
  const parts: string[] = [];
  if (providerIds.length > 0) parts.push(`可用 provider: ${providerIds.join(', ')}。`);
  if (isNonEmptyString(model) && matchingProviderIds.length > 0) {
    parts.push(`当前 model "${model}" 可匹配 provider: ${matchingProviderIds.join(', ')}。`);
    if (matchingProviderIds.length === 1) parts.push(`可以把 "provider" 改为 "${matchingProviderIds[0]}"。`);
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
  return isNonEmptyString(firstModel)
    ? `可以把 "model" 改为当前 provider 支持的模型，例如 "${firstModel}"。`
    : undefined;
}

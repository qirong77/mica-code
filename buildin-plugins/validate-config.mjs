import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PROVIDER_PROTOCOL = 'openai_chat_completions';
export const PROVIDER_PROTOCOLS = [DEFAULT_PROVIDER_PROTOCOL, 'openai_responses'];

export class ConfigValidationError extends Error {
  constructor(issues, configPath) {
    super(formatConfigValidationIssues(issues, configPath));
    this.name = 'ConfigValidationError';
    this.issues = issues;
    this.configPath = configPath;
  }
}

/**
 * Mica single-file plugin entrypoint. The startup bootstrap applies defaults before
 * mica-config is imported; this setup function performs the complete validation
 * once the application can present failures in the UI.
 */
export default function setup(ctx) {
  const configRoot = ctx?.paths?.config;
  if (!isNonEmptyString(configRoot)) {
    throw new Error('validate-config requires ctx.paths.config');
  }

  const configPath = join(configRoot, 'config.json');
  const result = validateConfigFile(configPath);
  if (result.changed) {
    ctx.logger?.info?.('validate-config:defaults-applied', {
      configPath,
      changes: result.changes,
    });
  }
  for (const issue of result.issues.filter((item) => item.severity === 'warning')) {
    ctx.logger?.warn?.('validate-config:warning', issue);
  }
}

/**
 * Applies backwards-compatible defaults without rejecting other semantic issues.
 * This runs before mica-config is imported so its module-level snapshot sees the
 * migrated file. Invalid JSON is left to mica-config's existing backup recovery.
 */
export function applyConfigDefaultsToFile(configPath) {
  if (!existsSync(configPath)) return emptyFileResult();

  const content = readFileSync(configPath, 'utf-8');
  const parsed = parseConfigText(content, configPath);
  if (!parsed.ok) return parsed;

  const result = validateConfig(parsed.config);
  if (result.changed) writeConfigFile(configPath, result.config);
  return result;
}

export function validateConfigFile(configPath) {
  if (!existsSync(configPath)) return emptyFileResult();

  const defaultsResult = applyConfigDefaultsToFile(configPath);
  assertValidConfig(defaultsResult, configPath);
  return defaultsResult;
}

export function validateConfigText(content, configPath = 'config.json') {
  const parsed = parseConfigText(content, configPath);
  if (!parsed.ok) return parsed;
  return validateConfig(parsed.config);
}

export function validateConfig(input) {
  const { config, changed, changes } = applyConfigDefaults(input);
  const issues = [];
  const add = (severity, code, path, message, suggestion) => {
    issues.push({ severity, code, path, message, ...(suggestion ? { suggestion } : {}) });
  };

  if (!isRecord(config)) {
    add('error', 'config_invalid', '$', '配置文件根节点必须是 object。');
    return validationResult(config, changed, changes, issues);
  }

  if (!Array.isArray(config.providers) || config.providers.length === 0) {
    add('error', 'providers_empty', 'providers', '"providers" 必须是非空数组。', '请至少配置一个 provider。');
    return validationResult(config, changed, changes, issues);
  }

  const seenProviderIds = new Map();
  config.providers.forEach((provider, index) => {
    const providerPath = `providers[${index}]`;
    if (!isRecord(provider)) {
      add('error', 'provider_invalid', providerPath, 'provider 配置项必须是 object。');
      return;
    }

    if (!isNonEmptyString(provider.id)) {
      add('error', 'provider_id_empty', `${providerPath}.id`, 'provider id 不能为空。');
    } else {
      const firstIndex = seenProviderIds.get(provider.id);
      if (firstIndex === undefined) {
        seenProviderIds.set(provider.id, index);
      } else {
        add(
          'error',
          'provider_id_duplicate',
          `${providerPath}.id`,
          `provider id "${provider.id}" 重复。`,
          `请修改 providers[${index}].id 或 providers[${firstIndex}].id，确保每个 provider id 唯一。`,
        );
      }
    }

    const providerName = isNonEmptyString(provider.id) ? provider.id : `providers[${index}]`;
    if (!isNonEmptyString(provider.api_base)) {
      add(
        'error',
        'provider_api_base_empty',
        `${providerPath}.api_base`,
        `provider "${providerName}" 的 api_base 不能为空。`,
      );
    }
    if (!PROVIDER_PROTOCOLS.includes(provider.protocol)) {
      add(
        'error',
        'provider_protocol_invalid',
        `${providerPath}.protocol`,
        `provider "${providerName}" 的 protocol 必须是 ${PROVIDER_PROTOCOLS.join(' | ')}。`,
      );
    }
    if (provider.models !== undefined && !isNonEmptyStringArray(provider.models)) {
      add(
        'error',
        'provider_models_invalid',
        `${providerPath}.models`,
        `provider "${providerName}" 的 models 必须是非空字符串数组。`,
      );
    }
    if (provider.get_model_url !== undefined && !isNonEmptyString(provider.get_model_url)) {
      add(
        'error',
        'provider_get_model_url_invalid',
        `${providerPath}.get_model_url`,
        `provider "${providerName}" 的 get_model_url 必须是非空字符串。`,
      );
    }
    if (provider.supportsEffort !== undefined && typeof provider.supportsEffort !== 'boolean') {
      add(
        'error',
        'provider_supports_effort_invalid',
        `${providerPath}.supportsEffort`,
        `provider "${providerName}" 的 supportsEffort 必须是 boolean。`,
      );
    }
    if (provider.api_key !== undefined && typeof provider.api_key !== 'string') {
      add(
        'error',
        'provider_api_key_invalid',
        `${providerPath}.api_key`,
        `provider "${providerName}" 的 api_key 必须是字符串。`,
      );
    } else if (!isNonEmptyString(provider.api_key)) {
      add(
        'warning',
        'provider_api_key_missing',
        `${providerPath}.api_key`,
        `provider "${providerName}" 没有配置 api_key。`,
        '可以启动 UI，但发送消息前需要配置 api_key。',
      );
    }
  });

  if (config.serperApiKey !== undefined && typeof config.serperApiKey !== 'string') {
    add('error', 'serper_api_key_invalid', 'serperApiKey', '"serperApiKey" 必须是字符串。');
  }
  validateMcpServers(config.mcpServers, add);

  return validationResult(config, changed, changes, issues);
}

export function assertValidConfig(result, configPath = 'config.json') {
  if (!result.ok) throw new ConfigValidationError(result.issues, configPath);
  return result;
}

export function formatConfigValidationIssues(issues, configPath = 'config.json') {
  if (issues.length === 0) return `配置文件正常：${configPath}`;
  const lines = [`配置文件有问题：${configPath}`];
  for (const issue of issues) {
    lines.push('', `[${issue.severity}] ${issue.path}`, issue.message);
    if (issue.suggestion) lines.push(`建议：${issue.suggestion}`);
  }
  return lines.join('\n');
}

function applyConfigDefaults(input) {
  if (!isRecord(input) || !Array.isArray(input.providers)) {
    return { config: input, changed: false, changes: [] };
  }

  const changes = [];
  const providers = input.providers.map((provider, index) => {
    if (!isRecord(provider) || provider.protocol !== undefined) return provider;
    changes.push({
      path: `providers[${index}].protocol`,
      value: DEFAULT_PROVIDER_PROTOCOL,
    });
    return { ...provider, protocol: DEFAULT_PROVIDER_PROTOCOL };
  });

  return {
    config: changes.length > 0 ? { ...input, providers } : input,
    changed: changes.length > 0,
    changes,
  };
}

function validateMcpServers(mcpServers, add) {
  if (mcpServers === undefined) return;
  if (!isRecord(mcpServers)) {
    add('error', 'mcp_servers_invalid', 'mcpServers', '"mcpServers" 必须是 object。');
    return;
  }

  for (const [name, server] of Object.entries(mcpServers)) {
    const path = `mcpServers.${name}`;
    if (!isRecord(server)) {
      add('error', 'mcp_server_invalid', path, `MCP server "${name}" 必须是 object。`);
      continue;
    }

    if ('url' in server) {
      if (!isNonEmptyString(server.url)) {
        add('error', 'mcp_server_url_invalid', `${path}.url`, `MCP server "${name}" 的 url 不能为空。`);
      }
      if (server.type !== undefined && server.type !== 'http') {
        add('error', 'mcp_server_type_invalid', `${path}.type`, `MCP server "${name}" 的 type 必须是 http。`);
      }
      if (server.headers !== undefined && !isStringRecord(server.headers)) {
        add(
          'error',
          'mcp_server_headers_invalid',
          `${path}.headers`,
          `MCP server "${name}" 的 headers 必须是字符串键值 object。`,
        );
      }
      continue;
    }

    if (!isNonEmptyString(server.command)) {
      add('error', 'mcp_server_command_invalid', `${path}.command`, `MCP server "${name}" 的 command 不能为空。`);
    }
    if (server.args !== undefined && !isStringArray(server.args)) {
      add('error', 'mcp_server_args_invalid', `${path}.args`, `MCP server "${name}" 的 args 必须是字符串数组。`);
    }
    if (server.env !== undefined && !isStringRecord(server.env)) {
      add('error', 'mcp_server_env_invalid', `${path}.env`, `MCP server "${name}" 的 env 必须是字符串键值 object。`);
    }
    for (const field of ['stderr', 'cwd']) {
      if (server[field] !== undefined && typeof server[field] !== 'string') {
        add(
          'error',
          `mcp_server_${field}_invalid`,
          `${path}.${field}`,
          `MCP server "${name}" 的 ${field} 必须是字符串。`,
        );
      }
    }
  }
}

function parseConfigText(content, configPath) {
  try {
    return { ok: true, config: JSON.parse(content), changed: false, changes: [], issues: [] };
  } catch (error) {
    return validationResult(
      null,
      false,
      [],
      [
        {
          severity: 'error',
          code: 'json_invalid',
          path: '$',
          message: error instanceof Error ? error.message : '配置文件不是有效的 JSON。',
          suggestion: `请修复 ${configPath} 的 JSON 语法。`,
        },
      ],
    );
  }
}

function validationResult(config, changed, changes, issues) {
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    config,
    changed,
    changes,
    issues,
  };
}

function emptyFileResult() {
  return { ok: true, config: null, changed: false, changes: [], issues: [] };
}

function writeConfigFile(configPath, config) {
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value) {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

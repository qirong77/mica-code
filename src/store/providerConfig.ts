import { api, type ModelOption } from './config.js';
import { updateModelOptions } from './updateModelOptions.js';
import { resetClient } from '../agent/client.js';
import { appendSystemLog } from './logAtom.js';
import { readConfig, writeConfigEntriesSync } from './createPersistedAtom.js';

export interface ProviderConfig {
  name: string;
  api_base: string;
  models_url: string;
  api_key: string;
  api_key_env_name: string;
  api_base_env_name: string;
  models_auth_header: 'bearer' | 'x-api-key';
  models?: ModelOption[];
}

interface ProviderFile {
  current: string;
  providers: Record<string, ProviderConfig>;
}

interface ProviderFileInput {
  current?: unknown;
  providers?: unknown;
}

const defaultProviders: Record<string, ProviderConfig> = {
  deepseek: {
    name: 'DeepSeek',
    api_base: 'https://api.deepseek.com',
    models_url: 'https://api.deepseek.com/models',
    api_key: '',
    api_key_env_name: 'DEEPSEEK_API_KEY',
    api_base_env_name: 'DEEPSEEK_BASE_URL',
    models_auth_header: 'bearer',
  },
  claude: {
    name: 'Claude',
    api_base: 'https://api.anthropic.com/v1',
    models_url: 'https://api.anthropic.com/v1/models',
    api_key: '',
    api_key_env_name: 'ANTHROPIC_API_KEY',
    api_base_env_name: 'ANTHROPIC_BASE_URL',
    models_auth_header: 'x-api-key',
  },
  kimi: {
    name: 'Kimi',
    api_base: 'https://api.moonshot.ai/v1',
    models_url: 'https://api.moonshot.ai/v1/models',
    api_key: '',
    api_key_env_name: 'MOONSHOT_API_KEY',
    api_base_env_name: '',
    models_auth_header: 'bearer',
  },
};

const DEFAULT_PROVIDER_ID = 'kimi';

let _config: ProviderFile | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeProvider(providerId: string, rawProvider: unknown): ProviderConfig | null {
  if (!isRecord(rawProvider)) return null;

  const base = defaultProviders[providerId];
  const readString = (key: keyof ProviderConfig, fallback = ''): string => {
    const value = rawProvider[key];
    if (typeof value === 'string') return value;
    if (base && typeof base[key] === 'string') return base[key] as string;
    if (key === 'name') return providerId;
    return fallback;
  };

  const authHeader = rawProvider.models_auth_header;
  const modelsAuthHeader =
    authHeader === 'bearer' || authHeader === 'x-api-key'
      ? authHeader
      : base?.models_auth_header ?? 'bearer';

  let models: ModelOption[] | undefined;
  const rawModels = rawProvider.models;
  if (Array.isArray(rawModels) && rawModels.length > 0) {
    models = rawModels.map((m: unknown) => {
      if (typeof m === 'string') return { name: m, label: m };
      if (typeof m === 'object' && m !== null && 'name' in (m as Record<string, unknown>)) {
        const obj = m as Record<string, unknown>;
        return { name: String(obj.name), label: String(obj.label ?? obj.name) };
      }
      return null;
    }).filter((m): m is ModelOption => m !== null);
    if (models.length === 0) models = undefined;
  }

  return {
    name: readString('name', providerId),
    api_base: readString('api_base'),
    models_url: readString('models_url'),
    api_key: readString('api_key'),
    api_key_env_name: readString('api_key_env_name'),
    api_base_env_name: readString('api_base_env_name'),
    models_auth_header: modelsAuthHeader,
    models,
  };
}

function normalizeProviders(rawProviders: unknown): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};

  for (const [providerId, provider] of Object.entries(defaultProviders)) {
    providers[providerId] = { ...provider };
  }

  if (!isRecord(rawProviders)) {
    return providers;
  }

  for (const [providerId, rawProvider] of Object.entries(rawProviders)) {
    const normalized = normalizeProvider(providerId, rawProvider);
    if (normalized) {
      providers[providerId] = normalized;
    }
  }

  return providers;
}

function normalizeProviderFile(rawConfig: ProviderFileInput | null): ProviderFile {
  const providers = normalizeProviders(rawConfig?.providers);
  const current =
    typeof rawConfig?.current === 'string' && providers[rawConfig.current]
      ? rawConfig.current
      : providers[DEFAULT_PROVIDER_ID]
        ? DEFAULT_PROVIDER_ID
        : Object.keys(providers)[0] ?? DEFAULT_PROVIDER_ID;

  return { current, providers };
}

function loadProviderConfig(): ProviderFile {
  if (_config) return _config;

  const rawConfig: ProviderFileInput = {
    current: readConfig<unknown>('currentProvider', null),
    providers: readConfig<unknown>('providers', null),
  };

  _config = normalizeProviderFile(rawConfig);

  const shouldPersist =
    typeof rawConfig.current !== 'string' ||
    !isRecord(rawConfig.providers) ||
    JSON.stringify(rawConfig.providers) !== JSON.stringify(_config.providers) ||
    rawConfig.current !== _config.current;

  if (shouldPersist) {
    const saveError = saveProviderConfig(_config);
    if (saveError) {
      appendSystemLog(`Failed to persist provider config: ${saveError}`);
    }
  }

  return _config;
}

function saveProviderConfig(config: ProviderFile): string | null {
  try {
    writeConfigEntriesSync({
      currentProvider: config.current,
      providers: config.providers,
    });
    _config = {
      current: config.current,
      providers: config.providers,
    };
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Failed to save provider config: ${message}`);
    return message;
  }
}

function resolveProvider(provider: ProviderConfig): ProviderConfig {
  const resolved: ProviderConfig = { ...provider };
  const apiKeyFromProviderEnv =
    provider.api_key_env_name && process.env[provider.api_key_env_name]
      ? process.env[provider.api_key_env_name]
      : undefined;
  const apiBaseFromProviderEnv =
    provider.api_base_env_name && process.env[provider.api_base_env_name]
      ? process.env[provider.api_base_env_name]
      : undefined;

  if (apiKeyFromProviderEnv) {
    resolved.api_key = apiKeyFromProviderEnv;
  }

  if (apiBaseFromProviderEnv) {
    resolved.api_base = apiBaseFromProviderEnv;
  }

  return resolved;
}

function applyProvider(provider: ProviderConfig): void {
  api.baseUrl.set(provider.api_base);
  api.apiKey.set(provider.api_key);
}

export function getProviderList(): Array<{ name: string; label: string }> {
  const config = loadProviderConfig();
  return Object.entries(config.providers).map(([id, provider]) => ({
    name: id,
    label: provider.name,
  }));
}

export function getCurrentProvider(): string {
  return loadProviderConfig().current;
}

export async function switchProvider(
  providerId: string,
): Promise<{ error: string | null; provider?: ProviderConfig; modelOptionsError?: string | null }> {
  const config = loadProviderConfig();
  const rawProvider = config.providers[providerId];
  if (!rawProvider) {
    return { error: `unknown provider: ${providerId}` };
  }

  const nextConfig: ProviderFile = {
    current: providerId,
    providers: config.providers,
  };
  const saveError = saveProviderConfig(nextConfig);
  if (saveError) {
    return { error: `failed to save provider config: ${saveError}` };
  }

  const provider = resolveProvider(rawProvider);
  applyProvider(provider);
  resetClient();

  const updateResult = await updateModelOptions(
    provider.models_url || undefined,
    provider.api_key,
    provider.models_auth_header,
    provider.models,
  );

  return {
    error: null,
    provider,
    modelOptionsError: updateResult.error,
  };
}

export function initProvider(): { modelsUrl: string | undefined; modelsAuthHeader: 'bearer' | 'x-api-key'; customModels?: ModelOption[] } {
  const config = loadProviderConfig();
  const rawProvider = config.providers[config.current];
  if (!rawProvider) {
    appendSystemLog(
      `Provider "${config.current}" not found in config. Available: ${Object.keys(config.providers).join(', ')}`,
    );
    return { modelsUrl: undefined, modelsAuthHeader: 'bearer' };
  }

  const provider = resolveProvider(rawProvider);
  applyProvider(provider);
  return {
    modelsUrl: provider.models_url || undefined,
    modelsAuthHeader: provider.models_auth_header,
    customModels: provider.models,
  };
}

import { api } from './config.js';
import { updateModelOptions } from './updateModelOptions.js';
import { resetClient } from '../agent/client.js';
import { appendSystemLog } from './logAtom.js';
import { readConfig, writeConfig } from './createPersistedAtom.js';

export interface ProviderConfig {
  name: string;
  api_base: string;
  models_url: string;
  api_key: string;
  api_key_env_name: string;
  api_base_env_name: string;
  models_auth_header: 'bearer' | 'x-api-key';
}

interface ProviderFile {
  current: string;
  providers: Record<string, ProviderConfig>;
}

const defaultProviders: Record<string, ProviderConfig> = {
  deepseek: {
    name: 'DeepSeek',
    api_base: 'https://api.deepseek.com/anthropic',
    models_url: 'https://api.deepseek.com/models',
    api_key: '',
    api_key_env_name: 'DEEPSEEK_API_KEY',
    api_base_env_name: 'DEEPSEEK_BASE_URL',
    models_auth_header: 'bearer',
  },
  claude: {
    name: 'Claude',
    api_base: 'https://api.anthropic.com',
    models_url: 'https://api.anthropic.com/v1/models',
    api_key: '',
    api_key_env_name: 'ANTHROPIC_API_KEY',
    api_base_env_name: 'ANTHROPIC_BASE_URL',
    models_auth_header: 'x-api-key',
  },
  kimi: {
    name: 'Kimi',
    api_base: 'https://api.moonshot.cn/anthropic',
    models_url: 'https://api.moonshot.cn/v1/models',
    api_key: '',
    api_key_env_name: 'MOONSHOT_API_KEY',
    api_base_env_name: '',
    models_auth_header: 'bearer',
  },
};

let _config: ProviderFile | null = null;

function loadProviderConfig(): ProviderFile {
  if (_config) return _config;

  const providers = readConfig<Record<string, ProviderConfig>>('providers', {});
  const current = readConfig<string>('currentProvider', '');

  if (current && Object.keys(providers).length > 0) {
    _config = { current, providers };
    return _config;
  }

  _config = { current: 'kimi', providers: { ...defaultProviders } };
  try {
    writeConfig('currentProvider', _config.current);
    writeConfig('providers', _config.providers);
  } catch (err) {
    appendSystemLog(
      `Failed to write default provider config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return _config;
}

function saveProviderConfig(config: ProviderFile): string | null {
  _config = config;
  try {
    writeConfig('currentProvider', config.current);
    writeConfig('providers', config.providers);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Failed to save provider config: ${message}`);
    return message;
  }
}

function resolveProvider(provider: ProviderConfig): ProviderConfig {
  const resolved: ProviderConfig = { ...provider };
  if (provider.api_key_env_name && process.env[provider.api_key_env_name]) {
    resolved.api_key = process.env[provider.api_key_env_name]!;
  }
  if (provider.api_base_env_name && process.env[provider.api_base_env_name]) {
    resolved.api_base = process.env[provider.api_base_env_name]!;
  }
  if (!resolved.models_auth_header) {
    resolved.models_auth_header = 'bearer';
  }
  return resolved;
}

function applyProvider(provider: ProviderConfig): void {
  api.baseUrl.set(provider.api_base);
  api.apiKey.set(provider.api_key);
}

export function getProviderList(): Array<{ name: string; label: string }> {
  const config = loadProviderConfig();
  return Object.entries(config.providers).map(([id, p]) => ({
    name: id,
    label: p.name,
  }));
}

export function getCurrentProvider(): string {
  return loadProviderConfig().current;
}

export async function switchProvider(
  providerId: string,
): Promise<{ error: string | null; provider?: ProviderConfig }> {
  const config = loadProviderConfig();
  const rawProvider = config.providers[providerId];
  if (!rawProvider) return { error: `unknown provider: ${providerId}` };

  config.current = providerId;
  const saveError = saveProviderConfig(config);
  if (saveError) {
    return { error: `failed to save provider config: ${saveError}` };
  }

  const provider = resolveProvider(rawProvider);
  applyProvider(provider);
  resetClient();
  await updateModelOptions(provider.models_url || undefined, provider.api_key, provider.models_auth_header);

  return { error: null, provider };
}

export function initProvider(): { modelsUrl: string | undefined; modelsAuthHeader: 'bearer' | 'x-api-key' } {
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
  return { modelsUrl: provider.models_url || undefined, modelsAuthHeader: provider.models_auth_header };
}

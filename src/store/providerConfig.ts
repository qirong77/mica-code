import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { api } from './config.js';
import { updateModelOptions } from './updateModelOptions.js';
import { resetClient } from '../agent/client.js';
import { appendSystemLog } from './logAtom.js';

export interface ProviderConfig {
  name: string;
  api_base: string;
  models_url: string;
  api_key: string;
  api_key_env_name: string;
  api_base_env_name: string;
}

interface ProviderFile {
  current: string;
  providers: Record<string, ProviderConfig>;
}

export const PROVIDER_PATH = resolve(homedir(), '.mica', 'provider.json');

const defaultProviderConfig: ProviderFile = {
  current: 'kimi',
  providers: {
    deepseek: {
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com/anthropic',
      models_url: 'https://api.deepseek.com/models',
      api_key: '',
      api_key_env_name: 'DEEPSEEK_API_KEY',
      api_base_env_name: 'DEEPSEEK_BASE_URL',
    },
    claude: {
      name: 'Claude',
      api_base: 'https://api.anthropic.com',
      models_url: '',
      api_key: '',
      api_key_env_name: 'ANTHROPIC_API_KEY',
      api_base_env_name: 'ANTHROPIC_BASE_URL',
    },
    kimi: {
      name: 'Kimi',
      api_base: 'https://api.moonshot.cn/anthropic',
      models_url: 'https://api.moonshot.cn/v1/models',
      api_key: '',
      api_key_env_name: 'MOONSHOT_API_KEY',
      api_base_env_name: '',
    },
  },
};

let _config: ProviderFile | null = null;

function ensureMicaDir(): void {
  const dir = resolve(homedir(), '.mica');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeProviderConfig(config: ProviderFile): void {
  ensureMicaDir();
  writeFileSync(PROVIDER_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function applyEnvFallback(config: ProviderFile): boolean {
  let changed = false;
  for (const provider of Object.values(config.providers)) {
    if (provider.api_key_env_name && !provider.api_key && process.env[provider.api_key_env_name]) {
      provider.api_key = process.env[provider.api_key_env_name]!;
      changed = true;
    }
    if (provider.api_base_env_name && !provider.api_base && process.env[provider.api_base_env_name]) {
      provider.api_base = process.env[provider.api_base_env_name]!;
      changed = true;
    }
  }
  return changed;
}

function loadProviderConfig(): ProviderFile {
  if (_config) return _config;

  try {
    if (existsSync(PROVIDER_PATH)) {
      const parsed = JSON.parse(readFileSync(PROVIDER_PATH, 'utf-8'));
      if (!parsed?.providers || !parsed.current) {
        throw new Error('invalid provider.json structure');
      }
      _config = parsed as ProviderFile;
      if (applyEnvFallback(_config)) {
        try {
          writeProviderConfig(_config);
        } catch {}
      }
      return _config;
    }
  } catch (err) {
    appendSystemLog(
      `Failed to load provider config: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  _config = structuredClone(defaultProviderConfig);
  applyEnvFallback(_config);
  try {
    writeProviderConfig(_config);
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
    writeProviderConfig(config);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Failed to save provider config: ${message}`);
    return message;
  }
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
  const provider = config.providers[providerId];
  if (!provider) return { error: `unknown provider: ${providerId}` };

  config.current = providerId;
  const saveError = saveProviderConfig(config);
  if (saveError) {
    return { error: `failed to save provider config: ${saveError}` };
  }

  applyProvider(provider);
  resetClient();
  await updateModelOptions(provider.models_url || undefined, provider.api_key);

  return { error: null, provider };
}

export function initProvider(): string | undefined {
  if (!existsSync(PROVIDER_PATH)) {
    ensureMicaDir();
    writeFileSync(PROVIDER_PATH, JSON.stringify(defaultProviderConfig, null, 2), 'utf-8');
  }

  const config = loadProviderConfig();
  const provider = config.providers[config.current];
  if (!provider) return undefined;

  applyProvider(provider);
  return provider.models_url || undefined;
}

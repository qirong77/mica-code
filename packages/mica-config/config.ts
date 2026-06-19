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

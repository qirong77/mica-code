import { atom } from "nanostores";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import defaultConfig from './default.json'
import { homedir } from "node:os";
export const CONFIG_PATH = resolve(homedir(),'.mica', "config.json");
export const EFFORT_OPTIONS = ["none", "low", "medium", "high"] as const;

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
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf-8");
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as IMicaConfig;
}

export function getConfig() {
  return configAtom.get();
}

export function updateConfig(
  updater: (config: IMicaConfig) => IMicaConfig,
): IMicaConfig {
  const next = updater(getConfig());
  configAtom.set(next);
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export async function loadProviderModels(providerId: string): Promise<string[]> {
  const provider = requireProvider(getConfig(), providerId);
  if (!provider.get_model_url) {
    return provider.models ?? [];
  }

  const response = await fetch(provider.get_model_url, {
    headers: provider.api_key
      ? { Authorization: `Bearer ${provider.api_key}` }
      : undefined,
  });
  const data = (await response.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error(`Invalid model list for provider ${provider.id}`);
  }

  const models = data.filter((item): item is string => typeof item === "string");
  updateConfig((config) => {
    const providers = config.providers.map((item) =>
      item.id === providerId ? { ...item, models } : item,
    );
    const current = config.provider === providerId ? providers.find((item) => item.id === providerId) : null;
    return {
      ...config,
      providers,
      model:
        current && !models.includes(config.model)
          ? models[0] || current.model
          : config.model,
    };
  });
  return models;
}

export async function loadMissingProviderModels() {
  const providers = getConfig().providers.filter(
    (provider) => provider.get_model_url && !provider.models?.length,
  );
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

function requireProvider(config: IMicaConfig, providerId: string): ProviderDefinition {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${providerId || "(empty)"}`);
  }
  return provider;
}

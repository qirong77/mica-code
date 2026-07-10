import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { CONFIG_PATH, EFFORT_OPTIONS, type EffortMap } from '../types.js';
import { setModelData } from './index.js';

const MODELS_JSON_URL = 'https://models.dev/models.json';
const API_JSON_URL = 'https://models.dev/api.json';
const CACHE_FILE = resolve(dirname(CONFIG_PATH), 'models.dev.json');
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

const PROVIDER_ALIASES: Record<string, string[]> = {
  moonshot: ['moonshotai'],
  zhipu: ['zhipuai'],
};

interface CanonicalEntry {
  name: string;
  limit?: { context?: number };
  reasoning?: boolean;
  [key: string]: unknown;
}

interface ProviderModelEntry {
  name: string;
  reasoning_options?: {
    toggle?: boolean;
    effort_values?: string[];
    budget_tokens?: boolean | number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ProviderEntry {
  models: Record<string, ProviderModelEntry>;
  [key: string]: unknown;
}

interface ModelsDevCache {
  models: Record<string, CanonicalEntry>;
  providers: Record<string, ProviderEntry>;
  leafIndex: Map<string, string>;
}

let cacheData: ModelsDevCache | null = null;

function buildLeafIndex(models: Record<string, CanonicalEntry>): Map<string, string> {
  const index = new Map<string, string>();
  for (const canonicalId of Object.keys(models)) {
    const sep = canonicalId.indexOf('/');
    if (sep > 0 && sep < canonicalId.length - 1) {
      const leafId = canonicalId.slice(sep + 1).toLowerCase();
      if (!index.has(leafId)) index.set(leafId, canonicalId);
    }
  }
  return index;
}

function resolveCanonicalId(modelId: string): string | null {
  if (!cacheData) return null;
  if (cacheData.models[modelId]) return modelId;
  const leafId = modelId.split('/').at(-1)?.toLowerCase();
  if (leafId) {
    const fromIndex = cacheData.leafIndex.get(leafId);
    if (fromIndex) return fromIndex;
  }
  return null;
}

function shouldRefresh(): boolean {
  try {
    if (!existsSync(CACHE_FILE)) return true;
    return Date.now() - statSync(CACHE_FILE).mtimeMs >= REFRESH_INTERVAL_MS;
  } catch {
    return true;
  }
}

function loadFromDisk(): ModelsDevCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    const { models, providers } = raw as { models?: Record<string, unknown>; providers?: Record<string, unknown> };
    if (!models || !providers) return null;
    return {
      models: models as Record<string, CanonicalEntry>,
      providers: providers as Record<string, ProviderEntry>,
      leafIndex: buildLeafIndex(models as Record<string, CanonicalEntry>),
    };
  } catch {
    return null;
  }
}

function saveToDisk(models: Record<string, CanonicalEntry>, providers: Record<string, ProviderEntry>): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ models, providers }), 'utf-8');
  } catch {
    // Non-fatal: cache is recoverable
  }
}

export async function ensureModelsDevCache(): Promise<void> {
  if (cacheData) return;
  if (!shouldRefresh()) {
    const cached = loadFromDisk();
    if (cached) {
      cacheData = cached;
      return;
    }
  }
  try {
    const [modelsRes, apiRes] = await Promise.all([
      fetch(MODELS_JSON_URL, { signal: AbortSignal.timeout(30_000) }),
      fetch(API_JSON_URL, { signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!modelsRes.ok || !apiRes.ok) throw new Error(`HTTP ${modelsRes.status} / ${apiRes.status}`);
    const models = (await modelsRes.json()) as Record<string, CanonicalEntry>;
    const providers = (await apiRes.json()) as Record<string, ProviderEntry>;
    cacheData = { models, providers, leafIndex: buildLeafIndex(models) };
    saveToDisk(models, providers);
  } catch {
    const cached = loadFromDisk();
    if (cached) {
      cacheData = cached;
      return;
    }
  }
}

export function lookupContextSize(modelId: string): number | null {
  if (!cacheData) return null;
  const canonicalId = resolveCanonicalId(modelId);
  if (!canonicalId) return null;
  const entry = cacheData.models[canonicalId];
  const context = entry?.limit?.context;
  return typeof context === 'number' && context > 0 ? context : null;
}

export function lookupEffortMap(modelId: string): EffortMap | null {
  if (!cacheData) return null;
  const canonicalId = resolveCanonicalId(modelId);
  if (!canonicalId) return null;
  const entry = cacheData.models[canonicalId];
  if (!entry || entry.reasoning !== true) return null;
  const sep = canonicalId.indexOf('/');
  const lab = canonicalId.slice(0, sep);
  const leafId = canonicalId.slice(sep + 1);
  const providerIds = [lab, ...(PROVIDER_ALIASES[lab] ?? [])];
  for (const pid of providerIds) {
    const provider = cacheData.providers[pid];
    if (!provider) continue;
    const modelEntry =
      provider.models[leafId] ??
      Object.values(provider.models).find((m) => m.name === entry.name);
    if (!modelEntry) continue;
    const options = modelEntry.reasoning_options;
    if (!options || !options.effort_values) continue;
    const effortValues = options.effort_values;
    if (effortValues.length === 0) return null;
    const effortMap: EffortMap = {};
    if (options.toggle && !effortValues.includes('none')) effortMap.none = null;
    for (const effort of EFFORT_OPTIONS) {
      if (effortValues.includes(effort)) effortMap[effort] = effort;
    }
    return Object.keys(effortMap).length > 0 ? effortMap : null;
  }
  return null;
}

export async function loadModelsDevDataForModels(modelIds: string[]): Promise<void> {
  await ensureModelsDevCache();
  for (const modelId of modelIds) {
    const contextSize = lookupContextSize(modelId);
    const effortMap = lookupEffortMap(modelId);
    setModelData(modelId, contextSize, effortMap);
  }
}

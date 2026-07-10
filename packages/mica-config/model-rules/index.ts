import { DEFAULT_MODEL_CONTEXT_SIZE, type EffortMap, type EffortOption } from '../types.js';

export const DEFAULT_EFFORT_MAP: EffortMap = {
  none: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/**
 * Per-model runtime data cache.
 * Populated by providerModels.ts after loading model lists from get_model_url.
 * Models not in this cache fall back to defaults.
 */
interface ModelData {
  contextWindowSize: number;
  effortMap: EffortMap | null;
}

const modelDataCache = new Map<string, ModelData>();

export function setModelData(modelId: string, contextWindowSize: number | null, effortMap: EffortMap | null): void {
  modelDataCache.set(modelId, {
    contextWindowSize: contextWindowSize ?? DEFAULT_MODEL_CONTEXT_SIZE * 1000,
    effortMap,
  });
}

/** Clear all cached model data (useful for testing). */
export function clearModelData(): void {
  modelDataCache.clear();
}

export function getEffortMapFromConfig(modelId: string): EffortMap | null {
  const data = modelDataCache.get(modelId)?.effortMap;
  // Return null only when model data exists with effort explicitly disabled
  if (data === null) return null;
  if (data !== undefined) return data;
  return DEFAULT_EFFORT_MAP;
}

export function getModelContextWindowSizeFromConfig(modelId: string): number {
  const data = modelDataCache.get(modelId);
  return data?.contextWindowSize ?? DEFAULT_MODEL_CONTEXT_SIZE * 1000;
}

export function hasOwnEffort(effortMap: EffortMap, effort: EffortOption): boolean {
  return Object.prototype.hasOwnProperty.call(effortMap, effort);
}

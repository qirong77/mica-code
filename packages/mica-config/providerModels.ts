import { requireProvider, type IMicaConfig } from './types.js';
import { ensureModelRule, getModelRule, normalizeModelEffort } from './getModelRule.js';

export type RuntimeConfigStore = {
  getConfig(): IMicaConfig;
  updateRuntimeConfig(updater: (config: IMicaConfig) => IMicaConfig): IMicaConfig;
};

export async function loadProviderModelsFromStore(store: RuntimeConfigStore, providerId: string): Promise<string[]> {
  const provider = requireProvider(store.getConfig(), providerId);
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

  const currentConfig = store.getConfig();
  if (currentConfig.provider === providerId) {
    const model = currentConfig.model || models[0]!;
    void ensureModelRule(model).catch(() => undefined);
  }

  store.updateRuntimeConfig((config) => {
    const providers = config.providers.map((item) => {
      if (item.id !== providerId) return item;
      const availableModels = config.provider === providerId && config.model ? [config.model, ...models] : models;
      return {
        ...item,
        models: [...new Set(availableModels)],
      };
    });
    const current = config.provider === providerId ? providers.find((item) => item.id === providerId) : null;
    const model = current && !config.model ? models[0]! : config.model;
    return {
      ...config,
      providers,
      model,
      contextWindowSize: current ? getModelRule(model).contextSize : config.contextWindowSize,
      effort:
        current?.supportsEffort === false
          ? 'none'
          : current
            ? normalizeModelEffort(model, config.effort)
            : config.effort,
    };
  });
  return models;
}

export async function loadMissingProviderModelsFromStore(store: RuntimeConfigStore) {
  const providers = store
    .getConfig()
    .providers.filter((provider) => provider.get_model_url && !provider.models?.length);
  await Promise.all(
    providers.map(async (provider) => {
      try {
        await loadProviderModelsFromStore(store, provider.id);
      } catch (error) {
        console.error(`Failed to fetch models for provider ${provider.id}:`, error);
      }
    }),
  );
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

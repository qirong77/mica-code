import { isEffortOption, micaConfig, type EffortOption, type IMicaConfig } from '@packages/mica-config/index.js';
import type { AgentRuntimeConfigOverride } from '../agent/AgentRuntimeConfig.js';

export async function listRuntimeModelIds(): Promise<string[]> {
  const initial = micaConfig.get();
  await Promise.all(
    initial.providers.map(async (provider) => {
      if (!provider.get_model_url || provider.models?.length) return;
      try {
        await micaConfig.loadProviderModels(provider.id);
      } catch {
        // Dynamic discovery is best-effort. Multica supports manual model entry
        // when a runtime reports an empty or partial catalog.
      }
    }),
  );

  const config = micaConfig.get();
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const provider of config.providers) {
    const models = [...(provider.models ?? [])];
    if (provider.id === config.provider && config.model && !models.includes(config.model)) {
      models.push(config.model);
    }
    for (const model of models) {
      const id = `${provider.id}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function resolveRuntimeConfigOverride(
  config: IMicaConfig,
  modelID?: string,
  variant?: string,
): AgentRuntimeConfigOverride {
  const effort = resolveEffort(variant);
  if (!modelID) return effort ? { effort } : {};

  const matchedProvider = [...config.providers]
    .sort((a, b) => b.id.length - a.id.length)
    .find((provider) => modelID.startsWith(`${provider.id}/`));
  if (!matchedProvider) {
    return {
      model: modelID,
      ...(effort ? { effort } : {}),
    };
  }
  const model = modelID.slice(matchedProvider.id.length + 1);
  if (!model) throw new Error(`Missing model name after provider prefix: ${modelID}`);
  return {
    providerId: matchedProvider.id,
    model,
    ...(effort ? { effort } : {}),
  };
}

function resolveEffort(variant?: string): EffortOption | undefined {
  if (!variant) return undefined;
  if (!isEffortOption(variant)) {
    throw new Error(`Unsupported --variant value: ${variant}. Use none, low, medium, high, or xhigh.`);
  }
  return variant;
}

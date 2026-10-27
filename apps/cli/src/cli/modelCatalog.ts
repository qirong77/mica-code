import {
  isEffortLevelName,
  micaConfig,
  type EffortOption,
  type IMicaConfig,
  type ProviderDefinition,
} from '@packages/mica-config/index.js';
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
  options: { strictEffort?: boolean } = {},
): AgentRuntimeConfigOverride {
  const matchedProvider = [...config.providers]
    .sort((left, right) => right.id.length - left.id.length)
    .find((provider) => modelID?.startsWith(`${provider.id}/`));
  const model = !modelID ? config.model : matchedProvider ? modelID.slice(matchedProvider.id.length + 1) : modelID;
  if (modelID && matchedProvider && !model) {
    throw new Error(`Missing model name after provider prefix: ${modelID}`);
  }
  const provider = matchedProvider ?? config.providers.find((item) => item.id === config.provider);
  const effort = resolveEffort(variant, model, provider, options.strictEffort === true);

  if (!modelID) return effort ? { effort } : {};
  if (!matchedProvider) {
    return {
      model: modelID,
      ...(effort ? { effort } : {}),
    };
  }
  return {
    providerId: matchedProvider.id,
    model,
    ...(effort ? { effort } : {}),
  };
}

function resolveEffort(
  variant: string | undefined,
  model: string | undefined,
  provider: ProviderDefinition | undefined,
  strict: boolean,
): EffortOption | undefined {
  if (!variant) return undefined;
  // 档位名由模型自己声明（`max`、`minimal` …），不换算也不落别名；这里只挡不是档位名的输入。
  // 命令行显式指定时再按该模型的真实档位校验，避免把写错的档位静默换成别的值。
  if (!isEffortLevelName(variant)) {
    throw new Error(`Unsupported --variant value: ${variant}. Use one of the levels that model declares.`);
  }
  if (!strict || !model) return variant;
  const levels = micaConfig.getModelEffortOptions(model, provider?.protocol, provider);
  if (levels.length === 0) {
    throw new Error(
      `Model ${model} exposes no reasoning effort levels; add providers[].effortLevels if the endpoint accepts them.`,
    );
  }
  if (!levels.includes(variant)) {
    throw new Error(`Unsupported --variant ${variant} for ${model}; available levels: ${levels.join(', ')}.`);
  }
  return variant;
}

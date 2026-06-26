import { micaConfig, type EffortOption, type ProviderDefinition } from '@packages/mica-config/index.js';
import type { OpenAIClientOptions } from '@packages/mica-agent/index.js';

export type RuntimeProviderDefinition = ProviderDefinition & { contextWindowSize: number };

export type AgentRuntimeConfig = {
  provider: RuntimeProviderDefinition;
  model: string;
  effort: EffortOption;
};

export type AgentRuntimeConfigSnapshot = {
  providerId: string;
  model: string;
  effort: EffortOption;
};

export function readAgentRuntimeConfig(): AgentRuntimeConfig {
  const config = micaConfig.get();
  micaConfig.assertValid(config);
  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider) {
    throw new Error(`Provider not found: ${config.provider || '(empty)'}`);
  }
  const model = config.model;
  const normalizedProvider = normalizeProviderForModel(provider, model);
  return {
    provider: normalizedProvider,
    model,
    effort: micaConfig.clampProviderEffort(normalizedProvider, config.effort, model),
  };
}

export function agentRuntimeConfigFromSnapshot(snapshot: AgentRuntimeConfigSnapshot): AgentRuntimeConfig {
  const config = micaConfig.get();
  const provider = config.providers.find((item) => item.id === snapshot.providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${snapshot.providerId || '(empty)'}`);
  }
  const model = snapshot.model || provider.model || provider.models?.[0] || '';
  const normalizedProvider = normalizeProviderForModel(provider, model);
  return {
    provider: normalizedProvider,
    model,
    effort: micaConfig.clampProviderEffort(normalizedProvider, snapshot.effort, model),
  };
}

export function createAgentClientOptions(config: AgentRuntimeConfig): OpenAIClientOptions {
  return {
    apiKey: config.provider.api_key,
    baseURL: config.provider.api_base,
    model: config.model,
    effort: micaConfig.clampProviderEffort(config.provider, config.effort, config.model),
    provider: config.provider,
  };
}

function normalizeProviderForModel(provider: ProviderDefinition, model: string): RuntimeProviderDefinition {
  return {
    ...provider,
    contextWindowSize: micaConfig.getModelContextWindowSizeFromConfig(model),
  };
}

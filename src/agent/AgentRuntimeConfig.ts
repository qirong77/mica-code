import {
  micaConfig,
  type EffortOption,
  type ProviderDefinition,
  type ProviderProtocol,
} from '@packages/mica-config/index.js';
import type { ModelClientOptions } from '@packages/mica-agent/index.js';

export type RuntimeProviderDefinition = ProviderDefinition & { contextWindowSize: number };

export type AgentRuntimeConfig = {
  provider: RuntimeProviderDefinition;
  model: string;
  effort: EffortOption;
};

export type AgentRuntimeConfigSnapshot = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  effort: EffortOption;
};

export function readAgentRuntimeConfig(): AgentRuntimeConfig {
  const config = micaConfig.get();
  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider) {
    throw new Error(`Provider not found: ${config.provider || '(empty)'}`);
  }
  const model = config.model;
  const normalizedProvider = normalizeProviderForModel(provider, model);
  return {
    provider: normalizedProvider,
    model,
    effort: normalizedProvider.supportsEffort === false ? 'none' : micaConfig.normalizeModelEffort(model, config.effort),
  };
}

export function agentRuntimeConfigFromSnapshot(snapshot: AgentRuntimeConfigSnapshot): AgentRuntimeConfig {
  const config = micaConfig.get();
  const provider = config.providers.find((item) => item.id === snapshot.providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${snapshot.providerId || '(empty)'}`);
  }
  if (provider.protocol !== snapshot.protocol) {
    throw new Error(`Session protocol mismatch: ${snapshot.protocol} -> ${provider.protocol}`);
  }
  const model = snapshot.model;
  const normalizedProvider = normalizeProviderForModel(provider, model);
  return {
    provider: normalizedProvider,
    model,
    effort: normalizedProvider.supportsEffort === false ? 'none' : micaConfig.normalizeModelEffort(model, snapshot.effort),
  };
}

export function createAgentClientOptions(config: AgentRuntimeConfig): ModelClientOptions {
  return {
    apiKey: config.provider.api_key,
    baseURL: config.provider.api_base,
    model: config.model,
    effort: config.effort,
    provider: config.provider,
  };
}

function normalizeProviderForModel(provider: ProviderDefinition, model: string): RuntimeProviderDefinition {
  return {
    ...provider,
    contextWindowSize: micaConfig.getModelRule(model).contextSize,
  };
}

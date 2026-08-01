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

export type AgentRuntimeConfigOverride = {
  providerId?: string;
  model?: string;
  effort?: EffortOption;
};

export function readAgentRuntimeConfig(override: AgentRuntimeConfigOverride = {}): AgentRuntimeConfig {
  const config = micaConfig.get();
  const providerId = override.providerId ?? config.provider;
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider not found: ${providerId || '(empty)'}`);
  }
  const model = override.model ?? (provider.id === config.provider ? config.model : (provider.models?.[0] ?? ''));
  // model 为空时允许启动（无 key/无模型列表的新用户），首次发送消息前才需要可用 model。
  const normalizedProvider = normalizeProviderForModel(provider, model);
  const requestedEffort = override.effort ?? config.effort;
  return {
    provider: normalizedProvider,
    model,
    effort:
      normalizedProvider.supportsEffort === false ? 'none' : micaConfig.normalizeModelEffort(model, requestedEffort),
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
    effort:
      normalizedProvider.supportsEffort === false ? 'none' : micaConfig.normalizeModelEffort(model, snapshot.effort),
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

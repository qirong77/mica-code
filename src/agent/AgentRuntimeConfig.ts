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
    // 会话引用的 provider 已从配置移除（旧配置/重命名/迁移）。降级到当前
    // 默认 provider 恢复会话，而不是让整个会话变成 "Session not found"。
    const fallback =
      config.providers.find((item) => item.id === config.provider) ?? config.providers[0];
    if (fallback) {
      const model = fallback.models?.includes(snapshot.model)
        ? snapshot.model
        : (fallback.models?.[0] ?? config.model ?? '');
      return {
        provider: normalizeProviderForModel(fallback, model),
        model,
        effort:
          fallback.supportsEffort === false
            ? 'none'
            : micaConfig.normalizeModelEffort(model, snapshot.effort),
      };
    }
    throw new Error(`Provider not found: ${snapshot.providerId || '(empty)'}`);
  }
  if (provider.protocol !== snapshot.protocol) {
    // provider 存在但协议已迁移，同样降级到默认 provider 而不是拒绝恢复。
    const fallback =
      config.providers.find((item) => item.id === config.provider) ?? config.providers[0];
    if (fallback && fallback.id !== provider.id) {
      const model = fallback.models?.includes(snapshot.model)
        ? snapshot.model
        : (fallback.models?.[0] ?? config.model ?? '');
      return {
        provider: normalizeProviderForModel(fallback, model),
        model,
        effort:
          fallback.supportsEffort === false
            ? 'none'
            : micaConfig.normalizeModelEffort(model, snapshot.effort),
      };
    }
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

import { formatTokenCount } from '@packages/mica-common/format.js';
import {
  micaConfig,
  type EffortOption,
  type IMicaConfig,
  type ProviderDefinition,
} from '@packages/mica-config/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

export type ConfigSwitchReason = 'model' | 'effort' | 'provider';

type ConfigSwitchAdjustment =
  | { field: 'effort'; from: EffortOption; to: EffortOption; model: string; provider: string }
  | { field: 'contextWindowSize'; from: number; to: number; model: string; provider: string };

export function reportConfigSwitchError(
  services: CommandRuntimeServices,
  reason: ConfigSwitchReason,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  services.showMessage(`Switch ${reason} failed: ${message}`, 6000, services.getCurrentAgentSessionId());
}

export function applyConfigSwitchUpdate({
  agent,
  sessionController,
  services,
  update,
  successMessage,
  successTtl,
}: {
  agent: CommandAgent;
  sessionController: CommandSessionController;
  services: CommandRuntimeServices;
  update: (config: IMicaConfig) => IMicaConfig;
  successMessage: (config: IMicaConfig) => string;
  successTtl?: number;
}): IMicaConfig {
  let adjustments: ConfigSwitchAdjustment[] = [];
  const next = micaConfig.update((config) => {
    const normalized = normalizeConfigSwitchSelection(update(configForAgent(config, agent)));
    adjustments = normalized.adjustments;
    return normalized.config;
  });
  agent.reloadConfig(false);
  sessionController.saveCurrent();
  services.syncModelDisplay(agent);
  if (adjustments.length > 0) {
  }
  services.showMessage(formatConfigSwitchSuccess(successMessage(next), adjustments), successTtl);
  return next;
}

export function syncConfigFromAgent(agent: CommandAgent): IMicaConfig {
  return micaConfig.update((config) => normalizeConfigSwitchSelection(configForAgent(config, agent)).config);
}

function normalizeConfigSwitchSelection(config: IMicaConfig): {
  config: IMicaConfig;
  adjustments: ConfigSwitchAdjustment[];
} {
  const provider = findCurrentProvider(config);
  if (!provider) return { config, adjustments: [] };

  const model = config.model || provider.models?.[0] || '';
  const effort = isEffortOption(config.effort)
    ? micaConfig.clampProviderEffort(provider, config.effort, model)
    : micaConfig.clampProviderEffort(provider, 'medium', model);
  const contextWindowSize = micaConfig.getModelContextWindowSizeFromConfig(model);
  const adjustments: ConfigSwitchAdjustment[] = [];

  if (config.effort !== effort) {
    adjustments.push({
      field: 'effort',
      from: config.effort,
      to: effort,
      model,
      provider: provider.id,
    });
  }
  if (config.contextWindowSize !== contextWindowSize) {
    adjustments.push({
      field: 'contextWindowSize',
      from: config.contextWindowSize,
      to: contextWindowSize,
      model,
      provider: provider.id,
    });
  }

  return {
    config: {
      ...config,
      model,
      effort,
      contextWindowSize,
    },
    adjustments,
  };
}

function configForAgent(config: IMicaConfig, agent: CommandAgent): IMicaConfig {
  const agentProvider = agent.config.provider;
  const provider = config.providers.find((item) => item.id === agentProvider.id) ?? agentProvider;
  const model = agent.config.model || provider.models?.[0] || '';
  const effort = isEffortOption(agent.config.effort)
    ? micaConfig.clampProviderEffort(provider, agent.config.effort, model)
    : config.effort;

  return {
    ...config,
    provider: provider.id,
    model,
    effort,
    contextWindowSize: micaConfig.getModelContextWindowSizeFromConfig(model),
  };
}

function findCurrentProvider(config: IMicaConfig): ProviderDefinition | undefined {
  return config.providers.find((item) => item.id === config.provider);
}

function formatConfigSwitchSuccess(message: string, adjustments: ConfigSwitchAdjustment[]): string {
  if (adjustments.length === 0) return message;
  return `${message}; ${formatConfigSwitchAdjustments(adjustments)}`;
}

function formatConfigSwitchAdjustments(adjustments: ConfigSwitchAdjustment[]): string {
  const parts = adjustments.map((adjustment) => {
    if (adjustment.field === 'effort') {
      return `effort ${adjustment.from} -> ${adjustment.to}`;
    }
    return `context ${formatTokenCount(adjustment.from, { roundedThousands: true })} -> ${formatTokenCount(adjustment.to, { roundedThousands: true })}`;
  });
  return `Adjusted defaults: ${parts.join(', ')}`;
}

function isEffortOption(value: string): value is EffortOption {
  return micaConfig.effortOptions.includes(value as EffortOption);
}

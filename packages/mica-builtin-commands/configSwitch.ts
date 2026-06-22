import { micaLogger } from '@packages/mica-logger/index.js';
import {
  micaConfig,
  type EffortOption,
  type IMicaConfig,
  type ProviderDefinition,
} from '@packages/mica-config/index.js';
import { isCompactionNotNeededError } from '@packages/mica-context/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

export type ConfigSwitchReason = 'model' | 'effort' | 'provider';

type ConfigSwitchAdjustment =
  | { field: 'effort'; from: EffortOption; to: EffortOption; model: string; provider: string }
  | { field: 'contextWindowSize'; from: number; to: number; model: string; provider: string };

export async function compactBeforeConfigSwitch(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  reason: ConfigSwitchReason,
): Promise<void> {
  const snapshot = agent.getSnapshot();
  if (snapshot.messages.length === 0) return;

  const ownerSessionId = services.getCurrentAgentSessionId();
  services.showMessage(`Compacting before switching ${reason}...`, 4000, ownerSessionId);
  micaLogger.logRuntime('plugin.config_switch', 'compact:start', {
    reason,
    messages: snapshot.messages.length,
  });

  const result = await services
    .runExclusiveTask(agent, { ownerSessionId, statusText: `switch ${reason}: compacting context` }, () =>
      services.compact(agent, sessionController, ownerSessionId),
    )
    .catch((error) => {
      if (!isCompactionNotNeededError(error)) throw error;
      micaLogger.logRuntime('plugin.config_switch', 'compact:skipped', {
        reason,
        messages: snapshot.messages.length,
        message: error instanceof Error ? error.message : String(error),
      });
      services.showMessage('Current session is short; switching without compact', 4000, ownerSessionId);
      return undefined;
    });
  if (!result) return;

  services.showMessage(
    `Compact: ${result.beforeCount} -> ${result.afterCount} messages, tokens ${result.beforeTokenEstimate} -> ${result.afterTokenEstimate}`,
    6000,
    ownerSessionId,
  );
  micaLogger.logRuntime('plugin.config_switch', 'compact:done', {
    reason,
    beforeCount: result.beforeCount,
    afterCount: result.afterCount,
    beforeTokenEstimate: result.beforeTokenEstimate,
    afterTokenEstimate: result.afterTokenEstimate,
  });
}

export function reportConfigSwitchError(
  services: CommandRuntimeServices,
  reason: ConfigSwitchReason,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  micaLogger.logRuntime('plugin.config_switch', 'error', { reason, message }, 'error');
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
    micaLogger.logRuntime('plugin.config_switch', 'normalized', {
      provider: next.provider,
      model: next.model,
      adjustments,
    });
  }
  services.showMessage(formatConfigSwitchSuccess(successMessage(next), adjustments), successTtl);
  return next;
}

export function syncConfigFromAgent(agent: CommandAgent): IMicaConfig {
  return micaConfig.update((config) => normalizeConfigSwitchSelection(configForAgent(config, agent)).config);
}

function normalizeConfigSwitchSelection(config: IMicaConfig): { config: IMicaConfig; adjustments: ConfigSwitchAdjustment[] } {
  const provider = findCurrentProvider(config);
  if (!provider) return { config, adjustments: [] };

  const model = config.model || provider.model || provider.models?.[0] || '';
  const effort = isEffortOption(config.effort)
    ? micaConfig.clampProviderEffort(provider, config.effort, model)
    : micaConfig.clampProviderEffort(provider, provider.effort ?? 'medium', model);
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
  const model = agent.config.model || provider.model || provider.models?.[0] || '';
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
    return `context ${formatTokenCount(adjustment.from)} -> ${formatTokenCount(adjustment.to)}`;
  });
  return `Adjusted defaults: ${parts.join(', ')}`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return String(value);
}

function isEffortOption(value: string): value is EffortOption {
  return micaConfig.effortOptions.includes(value as EffortOption);
}

import { micaLogger } from '@packages/mica-logger/index.js';
import { micaConfig, type IMicaConfig } from '@packages/mica-config/index.js';
import { isCompactionNotNeededError } from '@packages/mica-context/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

export type ConfigSwitchReason = 'model' | 'effort' | 'provider';

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
  const next = micaConfig.update(update);
  agent.reloadConfig(false);
  sessionController.saveCurrent();
  services.syncModelDisplay(agent);
  services.showMessage(successMessage(next), successTtl);
  return next;
}

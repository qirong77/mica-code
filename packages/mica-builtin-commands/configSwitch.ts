import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

export async function compactBeforeConfigSwitch(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  reason: 'model' | 'effort' | 'provider',
): Promise<void> {
  const snapshot = agent.getSnapshot();
  if (snapshot.messages.length === 0) return;

  const ownerSessionId = services.getCurrentAgentSessionId();
  services.showMessage(`Compacting before switching ${reason}...`, 4000, ownerSessionId);
  micaLogger.logRuntime('plugin.config_switch', 'compact:start', {
    reason,
    messages: snapshot.messages.length,
  });

  const result = await services.runExclusiveTask(
    agent,
    { ownerSessionId, statusText: `switch ${reason}: compacting context` },
    () => services.compact(agent, sessionController, ownerSessionId),
  );
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
  reason: 'model' | 'effort' | 'provider',
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  micaLogger.logRuntime('plugin.config_switch', 'error', { reason, message }, 'error');
  services.showMessage(`Switch ${reason} failed: ${message}`, 6000, services.getCurrentAgentSessionId());
}

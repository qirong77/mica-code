import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';

import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand, showConfirmPrompt } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { isCompactionNotNeededError } from '@packages/mica-context/index.js';
import type { CommandRuntimeServices, CommandSessionController } from './services.js';
import { applyConfigSwitchUpdate, reportConfigSwitchError } from './configSwitch.js';

export function createEffortCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'effort',
    description: '切换推理强度',
    action: () => {
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      micaLogger.logRuntime('plugin.effort', 'opened', {
        current: targetAgent.config.provider.supportsEffort !== false ? targetAgent.config.effort : 'none',
        provider: targetAgent.config.provider.id,
      });
      showSelectCommand({
        id: 'select-effort',
        title: 'select effort',
        current: targetAgent.config.provider.supportsEffort !== false ? targetAgent.config.effort : 'none',
        options: micaConfig.effortOptions.map((effort) => ({
          name: effort,
          label: effort,
        })),
        onSelect: (effort) => {
          return applyEffortSelection(targetAgent, targetSessionController, services, effort);
        },
      });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

async function applyEffortSelection(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  effort: string,
): Promise<void> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching effort');
      return;
    }
    if (agent.config.provider.supportsEffort === false) {
      micaLogger.logRuntime('plugin.effort', 'provider_ignores_effort', { provider: agent.config.provider.id }, 'warn');
      services.showMessage(
        `${agent.config.provider.name ?? agent.config.provider.id} does not use reasoning effort; status shows none`,
      );
      return;
    }
    if (effort === agent.config.effort) {
      micaLogger.logRuntime('plugin.effort', 'selected_current', { effort });
      return;
    }
    micaLogger.logRuntime('plugin.effort', 'selected', {
      from: agent.config.effort,
      to: effort,
      provider: agent.config.provider.id,
    });

    // 如果上下文使用率超过 20%，询问用户是否压缩
    const snapshot = agent.getSnapshot();
    if (snapshot.messages.length > 0) {
      const usagePercent =
        agent.config.provider.contextWindowSize > 0
          ? (snapshot.lastUsage?.totalTokens ?? 0) / agent.config.provider.contextWindowSize
          : 0;
      if (usagePercent > 0.2) {
        const shouldCompact = await showConfirmPrompt(
          `Context usage is ${Math.round(usagePercent * 100)}%. Compact before switching effort?`,
          true,
        );
        if (shouldCompact) {
          micaLogger.logRuntime('plugin.effort', 'compact:start', { usagePercent });
          const ownerSessionId = services.getCurrentAgentSessionId();
          const result = await services
            .runExclusiveTask(agent, { ownerSessionId, statusText: 'switch effort: compacting context' }, () =>
              services.compact(agent, sessionController, ownerSessionId),
            )
            .catch((error) => {
              if (!isCompactionNotNeededError(error)) throw error;
              micaLogger.logRuntime('plugin.effort', 'compact:skipped', {
                usagePercent,
                messages: snapshot.messages.length,
                message: error instanceof Error ? error.message : String(error),
              });
              services.showMessage('Current session is short; switching without compact', 4000, ownerSessionId);
              return undefined;
            });
          if (result) {
            services.showMessage(
              `Compact: ${result.beforeCount} -> ${result.afterCount} messages, tokens ${result.beforeTokenEstimate} -> ${result.afterTokenEstimate}`,
              6000,
              ownerSessionId,
            );
            micaLogger.logRuntime('plugin.effort', 'compact:done', {
              beforeCount: result.beforeCount,
              afterCount: result.afterCount,
            });
          }
        }
      }
    }

    applyConfigSwitchUpdate({
      agent,
      sessionController,
      services,
      update: (config) => ({
        ...config,
        effort: effort as (typeof micaConfig.effortOptions)[number],
      }),
      successMessage: () => `Effort: ${effort}`,
    });
    micaLogger.logRuntime('plugin.effort', 'applied', { effort });
  } catch (error) {
    reportConfigSwitchError(services, 'effort', error);
  }
}

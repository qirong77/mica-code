import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';

import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices, CommandSessionController } from './services.js';
import { compactBeforeConfigSwitch, reportConfigSwitchError } from './configSwitch.js';

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
    await compactBeforeConfigSwitch(agent, sessionController, services, 'effort');
    micaConfig.update((config) => ({
      ...config,
      effort: effort as (typeof micaConfig.effortOptions)[number],
    }));
    agent.reloadConfig(false);
    sessionController.saveCurrent();
    services.syncModelDisplay(agent);
    services.showMessage(`Effort: ${effort}`);
    micaLogger.logRuntime('plugin.effort', 'applied', { effort });
  } catch (error) {
    reportConfigSwitchError(services, 'effort', error);
  }
}

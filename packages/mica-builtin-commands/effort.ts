import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';

import { micaConfig, type EffortOption } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
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
      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('Agent is busy; wait or abort before switching effort');
        return;
      }
      showEffortSelector(targetAgent, targetSessionController, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function showEffortSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  options: { onAfterSelect?: (effort: string) => void | Promise<void> } = {},
): void {
  const effortOptions = agent.config.provider.supportsEffort === false
    ? ['none']
    : micaConfig.getModelEffortOptions(agent.config.model);
  showSelectCommand({
    id: 'select-effort',
    title: 'select effort',
    current: agent.config.provider.supportsEffort === false ? 'none' : agent.config.effort,
    options: effortOptions.map((effort) => ({
      name: effort,
      label: effort,
    })),
    onSelect: (effort) => {
      return applyEffortSelection(agent, sessionController, services, effort);
    },
    onAfterSelect: options.onAfterSelect,
  });
}

async function applyEffortSelection(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  effort: string,
): Promise<boolean> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching effort');
      return false;
    }
    if (agent.config.provider.supportsEffort === false) {
      services.showMessage(
        `${agent.config.provider.name ?? agent.config.provider.id} does not use reasoning effort; status shows none`,
      );
      return false;
    }
    if (effort === agent.config.effort) {
      return true;
    }

    services.showMessage(
      'Effort changed, prompt cache may be invalidated. Consider /compact',
      6000,
      services.getCurrentAgentSessionId(),
    );

    applyConfigSwitchUpdate({
      agent,
      sessionController,
      services,
      update: (config) => ({
        ...config,
        effort: effort as EffortOption,
      }),
      successMessage: () => `Effort: ${effort}`,
    });
    return true;
  } catch (error) {
    reportConfigSwitchError(services, 'effort', error);
    return false;
  }
}

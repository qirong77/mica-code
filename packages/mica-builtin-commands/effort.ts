import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';

import { micaConfig, type EffortOption } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
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
  micaLogger.logRuntime('plugin.effort', 'opened', {
    current: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
    provider: agent.config.provider.id,
  });
  const effortOptions = micaConfig.getProviderEffortOptions(agent.config.provider, agent.config.model);
  showSelectCommand({
    id: 'select-effort',
    title: 'select effort',
    current: micaConfig.clampProviderEffort(agent.config.provider, agent.config.effort as EffortOption, agent.config.model),
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
      micaLogger.logRuntime('plugin.effort', 'provider_ignores_effort', { provider: agent.config.provider.id }, 'warn');
      services.showMessage(
        `${agent.config.provider.name ?? agent.config.provider.id} does not use reasoning effort; status shows none`,
      );
      return false;
    }
    const availableEfforts = micaConfig.getProviderEffortOptions(agent.config.provider, agent.config.model);
    if (!availableEfforts.includes(effort as EffortOption)) {
      services.showMessage(
        `${agent.config.provider.name ?? agent.config.provider.id} supports effort: ${availableEfforts.join(', ')}`,
      );
      return false;
    }
    if (effort === agent.config.effort) {
      micaLogger.logRuntime('plugin.effort', 'selected_current', { effort });
      return true;
    }
    micaLogger.logRuntime('plugin.effort', 'selected', {
      from: agent.config.effort,
      to: effort,
      provider: agent.config.provider.id,
    });

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
        effort: micaConfig.clampProviderEffort(
          config.providers.find((provider) => provider.id === config.provider) ?? agent.config.provider,
          effort as EffortOption,
          config.model,
        ),
      }),
      successMessage: () => `Effort: ${effort}`,
    });
    micaLogger.logRuntime('plugin.effort', 'applied', { effort });
    return true;
  } catch (error) {
    reportConfigSwitchError(services, 'effort', error);
    return false;
  }
}

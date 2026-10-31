import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from '../services.js';

import { micaConfig, type EffortOption } from '@packages/mica-config/index.js';
import { showSelectCommand } from '../shared/selectCommand.js';
import type { CommandRuntimeServices, CommandSessionController } from '../services.js';
import { applyConfigSwitchUpdate, reportConfigSwitchError } from '../shared/configSwitch.js';

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
        services.showNotice('Agent is busy; wait or abort before switching effort', undefined, {
          command: '/effort',
          status: 'warning',
        });
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
  if (agent.config.provider.supportsEffort === false) {
    services.showNotice(
      `${agent.config.provider.id} does not use reasoning effort; nothing to select`,
      undefined,
      { command: '/effort', status: 'info' },
    );
    return;
  }
  const effortOptions = micaConfig.getModelEffortOptions(
    agent.config.model,
    agent.config.provider.protocol,
    agent.config.provider,
  );
  if (effortOptions.length === 0) {
    // 该协议下没有可用档位（非推理模型、只有 budget，或 models.dev 没收录）：不弹空列表，直接说明。
    // 未收录的模型可以自己在 provider 上声明档位，所以提示里点出这个入口。
    services.showNotice(
      `${agent.config.model} declares no reasoning effort levels for ${agent.config.provider.protocol}; ` +
        'add providers[].effortLevels in config.json if this endpoint accepts them',
      undefined,
      { command: '/effort', status: 'info' },
    );
    return;
  }
  showSelectCommand({
    id: 'select-effort',
    title: 'select effort',
    current: agent.config.effort,
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
      services.showNotice('Agent is busy; wait or abort before switching effort', undefined, {
        command: '/effort',
        status: 'warning',
      });
      return false;
    }
    if (agent.config.provider.supportsEffort === false) {
      services.showNotice(
        `${agent.config.provider.id} does not use reasoning effort; status shows none`,
        undefined,
        { command: '/effort', status: 'info' },
      );
      return false;
    }
    if (effort === agent.config.effort) {
      return true;
    }

    await applyConfigSwitchUpdate({
      agent,
      sessionController,
      services,
      command: '/effort',
      update: (config) => ({
        ...config,
        effort: effort as EffortOption,
      }),
      successMessage: () => `Effort: ${effort}`,
      successHint: 'Prompt cache may be invalidated. Consider /compact',
    });
    return true;
  } catch (error) {
    reportConfigSwitchError(services, 'effort', error);
    return false;
  }
}

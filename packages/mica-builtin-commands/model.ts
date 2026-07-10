import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import type { CommandRuntimeServices, CommandSessionController } from './services.js';
import { applyConfigSwitchUpdate, reportConfigSwitchError, syncConfigFromAgent } from './configSwitch.js';
import { showEffortSelector } from './effort.js';

export function createModelCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'model',
    description: '切换当前 provider 的模型',
    action: () => {
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('Agent is busy; wait or abort before switching model');
        return;
      }
      void showModelSelector(targetAgent, targetSessionController, services, { activateEffortAfterSelect: true });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export async function showModelSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  options: { activateEffortAfterSelect?: boolean } = {},
) {
  const config = syncConfigFromAgent(agent);
  let provider = config.providers.find((item) => item.id === agent.config.provider.id) ?? agent.config.provider;
  const providerId = provider.id;
  if (provider.get_model_url && !provider.models?.length) {
    try {
      await micaConfig.loadProviderModels(providerId);
      provider = micaConfig.get().providers.find((item) => item.id === providerId) ?? provider;
      if (!agent.isRunning) {
        agent.reloadConfig(false);
        sessionController.saveCurrent();
        services.syncModelDisplay(agent);
      }
    } catch (error) {
      services.showMessage(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  showSelectCommand({
    id: 'select-model',
    title: 'select model',
    current: agent.config.model,
    options: provider.models?.sort((a, b) => a.localeCompare(b)).map((model) => ({ name: model, label: model })) || [],
    emptyMessage: 'no models available',
    onSelect: (model) => {
      return applyModelSelection(agent, sessionController, services, model);
    },
    onAfterSelect: options.activateEffortAfterSelect
      ? () => {
          showEffortSelector(agent, sessionController, services);
        }
      : undefined,
  });
}

async function applyModelSelection(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  model: string,
): Promise<boolean> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching model');
      return false;
    }
    if (model === agent.config.model) {
      return true;
    }
    services.showMessage(
      'Model changed, prompt cache may be invalidated. Consider /compact',
      6000,
      services.getCurrentAgentSessionId(),
    );
    applyConfigSwitchUpdate({
      agent,
      sessionController,
      services,
      update: (config) => ({
        ...config,
        model,
      }),
      successMessage: () => `Model: ${model}`,
    });
    return true;
  } catch (error) {
    reportConfigSwitchError(services, 'model', error);
    return false;
  }
}

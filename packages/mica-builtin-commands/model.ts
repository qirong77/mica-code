import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices, CommandSessionController } from './services.js';
import { applyConfigSwitchUpdate, compactBeforeConfigSwitch, reportConfigSwitchError } from './configSwitch.js';

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
      micaLogger.logRuntime('plugin.model', 'opened', {
        current: targetAgent.config.model,
        provider: targetAgent.config.provider.id,
      });
      void showModelSelector(targetAgent, targetSessionController, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

async function showModelSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  const config = micaConfig.get();
  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider) {
    micaLogger.logRuntime('plugin.model', 'provider:not_found', { provider: config.provider }, 'error');
    services.showMessage('Provider not found');
    return;
  }
  micaLogger.logRuntime('plugin.model', 'selector:ready', {
    provider: provider.id,
    models: provider.models?.length ?? 0,
    current: agent.config.model,
  });
  showSelectCommand({
    id: 'select-model',
    title: 'select model',
    current: agent.config.model,
    options: provider.models?.map((model) => ({ name: model, label: model })) || [],
    emptyMessage: 'no models available',
    onSelect: (model) => {
      return applyModelSelection(agent, sessionController, services, provider.id, model);
    },
  });
}

async function applyModelSelection(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  providerId: string,
  model: string,
): Promise<void> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching model');
      return;
    }
    if (model === agent.config.model) {
      micaLogger.logRuntime('plugin.model', 'selected_current', { model });
      return;
    }
    micaLogger.logRuntime('plugin.model', 'selected', { from: agent.config.model, to: model, provider: providerId });
    await compactBeforeConfigSwitch(agent, sessionController, services, 'model');
    applyConfigSwitchUpdate({
      agent,
      sessionController,
      services,
      update: (config) => ({ ...config, model }),
      successMessage: () => `Model: ${model}`,
    });
  } catch (error) {
    reportConfigSwitchError(services, 'model', error);
  }
}

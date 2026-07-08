import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
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
      micaLogger.logRuntime('plugin.model', 'opened', {
        current: targetAgent.config.model,
        provider: targetAgent.config.provider.id,
      });
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
      micaLogger.logRuntime('plugin.model', 'models:load:start', { provider: providerId });
      await micaConfig.loadProviderModels(providerId);
      provider = micaConfig.get().providers.find((item) => item.id === providerId) ?? provider;
      if (!agent.isRunning) {
        agent.reloadConfig(false);
        sessionController.saveCurrent();
        services.syncModelDisplay(agent);
      }
      micaLogger.logRuntime('plugin.model', 'models:load:done', { provider: provider.id });
    } catch (error) {
      micaLogger.logRuntime(
        'plugin.model',
        'models:load:error',
        {
          provider: providerId,
          error: error instanceof Error ? error.message : String(error),
        },
        'error',
      );
      services.showMessage(error instanceof Error ? error.message : String(error));
      return;
    }
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
    options: provider.models?.sort((a, b) => a.localeCompare(b)).map((model) => ({ name: model, label: model })) || [],
    emptyMessage: 'no models available',
    onSelect: (model) => {
      return applyModelSelection(agent, sessionController, services, provider.id, model);
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
  providerId: string,
  model: string,
): Promise<boolean> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching model');
      return false;
    }
    if (model === agent.config.model) {
      micaLogger.logRuntime('plugin.model', 'selected_current', { model });
      return true;
    }
    micaLogger.logRuntime('plugin.model', 'selected', { from: agent.config.model, to: model, provider: providerId });
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

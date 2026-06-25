import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices, CommandSessionController } from './services.js';
import { applyConfigSwitchUpdate, reportConfigSwitchError } from './configSwitch.js';

export function createProviderCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'provider',
    description: '切换 AI 服务提供商',
    action: () => {
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('Agent is busy; wait or abort before switching provider');
        return;
      }
      const config = micaConfig.get();
      micaLogger.logRuntime('plugin.provider', 'opened', {
        current: config.provider,
        providers: config.providers.length,
      });
      showSelectCommand({
        id: 'select-provider',
        title: 'select provider' + ' (' + micaConfig.path + ')',
        current: config.provider,
        options: config.providers.map((provider) => ({
          name: provider.id,
          label: provider.name ?? provider.id,
          description: provider.api_base ? `(${provider.api_base})` : undefined,
        })),
        onSelect: (providerId) => {
          return applyProviderSelection(targetAgent, targetSessionController, services, providerId);
        },
      });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

async function applyProviderSelection(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  providerId: string,
): Promise<void> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching provider');
      return;
    }
    if (providerId === agent.config.provider.id) {
      micaLogger.logRuntime('plugin.provider', 'selected_current', { provider: providerId });
      return;
    }
    micaLogger.logRuntime('plugin.provider', 'selected', { from: agent.config.provider.id, to: providerId });
    services.showMessage(
      'Provider changed, prompt cache may be invalidated. Consider /compact',
      6000,
      services.getCurrentAgentSessionId(),
    );
    await loadProviderModelsForSwitch(providerId, services);

    const next = applyConfigSwitchUpdate({
      agent,
      sessionController,
      services,
      update: (config) => {
        const provider = config.providers.find((item) => item.id === providerId);
        if (!provider) {
          micaLogger.logRuntime('plugin.provider', 'provider:not_found', { provider: providerId }, 'error');
          throw new Error(`Provider not found: ${providerId}`);
        }
        const model = provider.models?.[0] || provider.model;
        if (!model) {
          throw new Error(`Provider ${providerId} has no models configured`);
        }
        return {
          ...config,
          provider: provider.id,
          model,
          effort: provider.effort ?? config.effort,
        };
      },
      successMessage: (config) => `Provider: ${config.provider}`,
      successTtl: 3000,
    });

    micaLogger.logRuntime('plugin.provider', 'applied', {
      provider: next.provider,
      model: next.model,
      effort: next.effort,
    });
  } catch (error) {
    reportConfigSwitchError(services, 'provider', error);
  }
}

async function loadProviderModelsForSwitch(providerId: string, services: CommandRuntimeServices): Promise<void> {
  const provider = micaConfig.get().providers.find((item) => item.id === providerId);
  if (!provider?.get_model_url || provider.models?.length) return;

  try {
    micaLogger.logRuntime('plugin.provider', 'models:load:start', { provider: providerId });
    await micaConfig.loadProviderModels(providerId);
    micaLogger.logRuntime('plugin.provider', 'models:load:done', { provider: providerId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    micaLogger.logRuntime(
      'plugin.provider',
      'models:load:error',
      {
        provider: providerId,
        error: message,
      },
      'error',
    );
    services.showMessage(message);
    throw error;
  }
}

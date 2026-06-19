import { Text } from '@anthropic/ink';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices, CommandSessionController } from './services.js';
import { compactBeforeConfigSwitch, reportConfigSwitchError } from './configSwitch.js';

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
          label: (
            <>
              {provider.name ?? provider.id}
              <Text dimColor>{` (${provider.api_base})`}</Text>
            </>
          ),
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
    await compactBeforeConfigSwitch(agent, sessionController, services, 'provider');

    const next = micaConfig.update((config) => {
      const provider = config.providers.find((item) => item.id === providerId);
      if (!provider) {
        micaLogger.logRuntime('plugin.provider', 'provider:not_found', { provider: providerId }, 'error');
        throw new Error(`Provider not found: ${providerId}`);
      }
      return {
        ...config,
        provider: provider.id,
        model: provider.models?.[0] || provider.model,
        effort: provider.supportsEffort === false ? 'none' : provider.effort,
        contextWindowSize: provider.contextWindowSize,
      };
    });

    const provider = next.providers.find((item) => item.id === providerId);
    if (provider?.get_model_url && !provider.models?.length) {
      micaLogger.logRuntime('plugin.provider', 'models:load:start', { provider: providerId });
      void micaConfig
        .loadProviderModels(providerId)
        .then(() => {
          if (!agent.isRunning) {
            agent.reloadConfig(false);
            sessionController.saveCurrent();
            services.syncModelDisplay(agent);
          }
          micaLogger.logRuntime('plugin.provider', 'models:load:done', { provider: providerId });
        })
        .catch((error) => {
          micaLogger.logRuntime(
            'plugin.provider',
            'models:load:error',
            {
              provider: providerId,
              error: error instanceof Error ? error.message : String(error),
            },
            'error',
          );
        });
    }
    agent.reloadConfig(false);
    sessionController.saveCurrent();
    services.syncModelDisplay(agent);
    services.showMessage(`Provider: ${next.provider}`, 3000);
    micaLogger.logRuntime('plugin.provider', 'applied', {
      provider: next.provider,
      model: next.model,
      effort: next.effort,
    });
  } catch (error) {
    reportConfigSwitchError(services, 'provider', error);
  }
}

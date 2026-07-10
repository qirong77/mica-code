import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import {
  micaConfig,
  providerSupportsModel,
  type EffortOption,
  type ProviderDefinition,
} from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import type { CommandRuntimeServices, CommandSessionController } from './services.js';
import { applyConfigSwitchUpdate, reportConfigSwitchError } from './configSwitch.js';
import { showModelSelector } from './model.js';

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
        onAfterSelect: () => {
          void showModelSelector(targetAgent, targetSessionController, services, { activateEffortAfterSelect: true });
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
): Promise<boolean> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching provider');
      return false;
    }
    if (providerId === agent.config.provider.id) {
      return true;
    }
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
          throw new Error(`Provider not found: ${providerId}`);
        }
        const preference = micaConfig.storage.providerPreference.read(providerId);
        const model = resolvePreferenceModel(provider, preference.model);
        const effort: EffortOption = (preference.effort as EffortOption | undefined) ?? config.effort;
        return {
          ...config,
          provider: provider.id,
          model,
          effort,
        };
      },
      successMessage: (config) => `Provider: ${config.provider}`,
      successTtl: 3000,
    });
    return true;
  } catch (error) {
    reportConfigSwitchError(services, 'provider', error);
    return false;
  }
}

async function loadProviderModelsForSwitch(providerId: string, services: CommandRuntimeServices): Promise<void> {
  const provider = micaConfig.get().providers.find((item) => item.id === providerId);
  if (!provider?.get_model_url || provider.models?.length) return;

  try {
    await micaConfig.loadProviderModels(providerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showMessage(message);
    throw error;
  }
}

function resolvePreferenceModel(provider: ProviderDefinition, preferenceModel?: string): string {
  if (preferenceModel && providerSupportsModel(provider, preferenceModel)) return preferenceModel;
  return provider.models?.[0] || '';
}

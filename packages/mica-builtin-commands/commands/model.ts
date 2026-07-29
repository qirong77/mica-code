import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from '../services.js';
import { micaConfig, type EffortOption } from '@packages/mica-config/index.js';
import { showSelectCommand } from '../shared/selectCommand.js';
import type { CommandRuntimeServices, CommandSessionController } from '../services.js';
import { applyConfigSwitchUpdate, reportConfigSwitchError, syncConfigFromAgent } from '../shared/configSwitch.js';
import { showEffortSelector } from './effort.js';

type ModelSelection = {
  providerId: string;
  model: string;
};

export function createModelCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'model',
    description: '切换 provider 和模型',
    action: () => {
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('Agent is busy; wait or abort before switching model');
        return;
      }
      showModelSelector(targetAgent, targetSessionController, services, { activateEffortAfterSelect: true });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function showModelSelector(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
  options: { activateEffortAfterSelect?: boolean } = {},
) {
  const config = syncConfigFromAgent(agent);
  const current = encodeModelSelection({ providerId: agent.config.provider.id, model: agent.config.model });
  showSelectCommand({
    id: 'select-model',
    title: 'select model',
    current,
    options: config.providers.flatMap((provider) => {
      const activeModel = provider.id === config.provider ? config.model : '';
      return [...new Set(activeModel ? [activeModel, ...(provider.models ?? [])] : (provider.models ?? []))]
        .sort((a, b) => a.localeCompare(b))
        .map((model) => ({
          name: encodeModelSelection({ providerId: provider.id, model }),
          label: model,
          description: provider.name ?? provider.id,
          searchField: `${model} ${provider.name ?? ''} ${provider.id}`,
        }));
    }),
    emptyMessage: 'no models available',
    filterable: true,
    onSelect: (selection) => {
      return applyModelSelection(agent, sessionController, services, decodeModelSelection(selection));
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
  selection: ModelSelection,
): Promise<boolean> {
  try {
    if (services.isAgentBusy(agent)) {
      services.showMessage('Agent is busy; wait or abort before switching model');
      return false;
    }
    if (selection.providerId === agent.config.provider.id && selection.model === agent.config.model) {
      return true;
    }
    const providerChanged = selection.providerId !== agent.config.provider.id;
    services.showMessage(
      `${providerChanged ? 'Provider and model' : 'Model'} changed, prompt cache may be invalidated. Consider /compact`,
      6000,
      services.getCurrentAgentSessionId(),
    );
    await applyConfigSwitchUpdate({
      agent,
      sessionController,
      services,
      update: (config) => {
        const provider = config.providers.find((item) => item.id === selection.providerId);
        if (!provider) throw new Error(`Provider not found: ${selection.providerId}`);
        if (!provider.models?.includes(selection.model)) {
          throw new Error(`Model not found for provider ${selection.providerId}: ${selection.model}`);
        }
        const storedEffort = providerChanged
          ? micaConfig.storage.providerPreference.read(selection.providerId).effort
          : undefined;
        const preferredEffort = isEffortOption(storedEffort) ? storedEffort : undefined;
        return {
          ...config,
          provider: selection.providerId,
          model: selection.model,
          effort: preferredEffort ?? config.effort,
        };
      },
      successMessage: (config) => {
        const provider = config.providers.find((item) => item.id === config.provider);
        return `Model: ${provider?.name ?? config.provider} / ${config.model}`;
      },
    });
    return true;
  } catch (error) {
    reportConfigSwitchError(services, 'model', error);
    return false;
  }
}

function encodeModelSelection(selection: ModelSelection): string {
  return JSON.stringify([selection.providerId, selection.model]);
}

function decodeModelSelection(value: string): ModelSelection {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new Error('Invalid model selection');
  }
  return { providerId: parsed[0], model: parsed[1] };
}

function isEffortOption(value: string | undefined): value is EffortOption {
  return micaConfig.effortOptions.includes(value as EffortOption);
}

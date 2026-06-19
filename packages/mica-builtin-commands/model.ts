import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createModelCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'model',
    description: '切换当前 provider 的模型',
    action: () => {
      micaLogger.logRuntime('plugin.model', 'opened', {
        current: agent.config.model,
        provider: agent.config.provider.id,
      });
      void showModelSelector(agent, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

async function showModelSelector(agent: CommandAgent, services: CommandRuntimeServices) {
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
      micaLogger.logRuntime('plugin.model', 'selected', { from: agent.config.model, to: model, provider: provider.id });
      micaConfig.update((config) => ({ ...config, model }));
      agent.reloadConfig();
      services.syncModelDisplay(agent);
      services.showMessage(`Model: ${model}`);
    },
  });
}

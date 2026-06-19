import { micaUI } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { showMessage, syncModelDisplay } from '../app/bootstrap.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { logRuntime } from '@packages/mica-logger/index.js';

export function registerModelPlugin(agent: AgentRuntime) {
  return {
    name: 'model',
    description: '切换当前 provider 的模型',
    action: () => {
      logRuntime('plugin.model', 'opened', {
        current: agent.config.model,
        provider: agent.config.provider.id,
      });
      void showModelSelector(agent);
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

async function showModelSelector(agent: AgentRuntime) {
  const config = micaConfig.get();
  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider) {
    logRuntime('plugin.model', 'provider:not_found', { provider: config.provider }, 'error');
    showMessage('Provider not found');
    return;
  }
  logRuntime('plugin.model', 'selector:ready', {
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
      logRuntime('plugin.model', 'selected', { from: agent.config.model, to: model, provider: provider.id });
      micaConfig.update((config) => ({ ...config, model }));
      agent.reloadConfig();
      syncModelDisplay(agent);
      showMessage(`Model: ${model}`);
    },
  });
}

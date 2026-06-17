import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { showMessage, syncModelDisplay } from '../bootstrap.js';
import {
  getConfig,
  updateConfig,
} from '../store/index.js';
import { showSelectCommand } from './selectCommand.js';

export function registerModelPlugin(agent: AgentRuntime) {
  return {
    name: 'model',
    description: '切换当前 provider 的模型',
    action: () => {
      void showModelSelector(agent);
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

async function showModelSelector(agent: AgentRuntime) {
  const config = getConfig();
  const provider = config.providers.find((item) => item.id === config.provider);
  if (!provider) {
    showMessage('Provider not found');
    return;
  }
  showSelectCommand({
    id: 'select-model',
    title: 'select model',
    current: agent.config.model,
    options: provider.models?.map((model) => ({ name: model, label: model })) || [],
    emptyMessage: 'no models available',
    onSelect: (model) => {
      updateConfig((config) => ({ ...config, model }));
      agent.reloadConfig();
      syncModelDisplay(agent);
      showMessage(`Model: ${model}`);
    },
  });
}

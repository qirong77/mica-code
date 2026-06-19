import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent } from './services.js';

import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';

export function createEffortCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'effort',
    description: '切换推理强度',
    action: () => {
      micaLogger.logRuntime('plugin.effort', 'opened', {
        current: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
        provider: agent.config.provider.id,
      });
      showSelectCommand({
        id: 'select-effort',
        title: 'select effort',
        current: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
        options: micaConfig.effortOptions.map((effort) => ({
          name: effort,
          label: effort,
        })),
        onSelect: (effort) => {
          micaLogger.logRuntime('plugin.effort', 'selected', {
            from: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
            to: effort,
            provider: agent.config.provider.id,
          });
          micaConfig.update((config) => ({
            ...config,
            effort:
              config.providers.find((item) => item.id === config.provider)?.supportsEffort === false
                ? 'none'
                : (effort as (typeof micaConfig.effortOptions)[number]),
          }));
          agent.reloadConfig();
          services.syncModelDisplay(agent);
          if (agent.config.provider.supportsEffort === false) {
            micaLogger.logRuntime('plugin.effort', 'provider_ignores_effort', { provider: agent.config.provider.id }, 'warn');
            services.showMessage(
              `${agent.config.provider.name ?? agent.config.provider.id} does not use reasoning effort; status shows none`,
            );
            return;
          }
          services.showMessage(`Effort: ${effort}`);
          micaLogger.logRuntime('plugin.effort', 'applied', { effort });
        },
      });
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';

import { showMessage, syncModelDisplay } from '../app/bootstrap.js';
import { EFFORT_OPTIONS, updateConfig } from '../config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { logRuntime } from '../logger.js';

export function registerEffortPlugin(agent: AgentRuntime) {
  return {
    name: 'effort',
    description: '切换推理强度',
    action: () => {
      logRuntime('plugin.effort', 'opened', {
        current: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
        provider: agent.config.provider.id,
      });
      showSelectCommand({
        id: 'select-effort',
        title: 'select effort',
        current: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
        options: EFFORT_OPTIONS.map((effort) => ({
          name: effort,
          label: effort,
        })),
        onSelect: (effort) => {
          logRuntime('plugin.effort', 'selected', {
            from: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
            to: effort,
            provider: agent.config.provider.id,
          });
          updateConfig((config) => ({
            ...config,
            effort:
              config.providers.find((item) => item.id === config.provider)?.supportsEffort === false
                ? 'none'
                : (effort as (typeof EFFORT_OPTIONS)[number]),
          }));
          agent.reloadConfig();
          syncModelDisplay(agent);
          if (agent.config.provider.supportsEffort === false) {
            logRuntime('plugin.effort', 'provider_ignores_effort', { provider: agent.config.provider.id }, 'warn');
            showMessage(
              `${agent.config.provider.name ?? agent.config.provider.id} does not use reasoning effort; status shows none`,
            );
            return;
          }
          showMessage(`Effort: ${effort}`);
          logRuntime('plugin.effort', 'applied', { effort });
        },
      });
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

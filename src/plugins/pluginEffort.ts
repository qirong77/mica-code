import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';

import { showMessage, syncModelDisplay } from '../bootstrap.js';
import { EFFORT_OPTIONS, updateConfig } from '../store/index.js';
import { showSelectCommand } from './selectCommand.js';

export function registerEffortPlugin(agent: AgentRuntime) {
  return {
    name: 'effort',
    description: '切换推理强度',
    action: () => {
      showSelectCommand({
        id: 'select-effort',
        title: 'select effort',
        current: agent.config.provider.supportsEffort !== false ? agent.config.effort : 'none',
        options: EFFORT_OPTIONS.map((effort) => ({
          name: effort,
          label: effort,
        })),
        onSelect: (effort) => {
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
            showMessage(
              `${agent.config.provider.name ?? agent.config.provider.id} does not use reasoning effort; status shows none`,
            );
            return;
          }
          showMessage(`Effort: ${effort}`);
        },
      });
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

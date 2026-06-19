import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { micaUI } from '../../packages/mica-ui/index.js';
import { listRunningAgents, type RunningAgentRecord } from '../agents/agentRegistry.js';
import { logRuntime } from '../logger.js';

export function registerAgentsPlugin() {
  return {
    name: 'agents',
    description: '显示当前正在运行的 agents',
    action: () => {
      const agents = listRunningAgents();
      logRuntime('plugin.agents', 'opened', { count: agents.length });
      showAgentsPanel(agents);
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}

function showAgentsPanel(agents: RunningAgentRecord[]) {
  const panelId = 'agents-panel';
  const initialText = micaUI.terminalInput.text.get();

  function hide() {
    const nextPanels = micaUI.panels.pluginUIs.get().filter((panel) => panel.id !== panelId);
    micaUI.panels.setPluginUIs(nextPanels);
    logRuntime('plugin.agents', 'closed');
  }

  function AgentsPanel() {
    return (
      <micaUI.Dialog title="agents" footer={<micaUI.KeyHints hints={['esc exit', 'type to close']} />}>
        <Box flexDirection="column">
          {agents.length === 0 ? (
            <Text color={micaUI.theme.colors.dim}>No running agents</Text>
          ) : (
            agents.map((agent) => (
              <Box key={agent.id} flexDirection="column" paddingBottom={1}>
                <Text color={agent.pid === process.pid ? micaUI.theme.colors.accent : undefined}>
                  {agent.pid === process.pid ? '● ' : '○ '}
                  {agent.cwd}
                </Text>
                <Text color={micaUI.theme.colors.dim}>
                  pid {agent.pid} · {agent.providerName}/{agent.model} · {agent.status} · updated {formatRelativeTime(agent.updatedAt)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </micaUI.Dialog>
    );
  }

  micaUI.panels.setPluginUIs([
    ...micaUI.panels.pluginUIs.get().filter((panel) => panel.id !== panelId),
    {
      id: panelId,
      component: AgentsPanel,
      preserveInput: true,
      onInput: (_input, key) => {
        if (!key.escape) return false;
        hide();
        return true;
      },
      onTextChange: (value) => {
        if (value !== initialText) hide();
        return false;
      },
    },
  ]);
}

function formatRelativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

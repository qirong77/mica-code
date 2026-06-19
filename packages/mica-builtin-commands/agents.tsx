import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices, RunningAgentRecord } from './services.js';

type AgentsPanelState = { view: 'list'; selectedIdx: number };

export function createAgentsCommand(services: CommandRuntimeServices) {
  return {
    name: 'agents',
    description: '显示当前终端的 agents',
    action: () => {
      const agents = services.listRunningAgents();
      micaLogger.logRuntime('plugin.agents', 'opened', { count: agents.length });
      showAgentsPanel(agents, services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showAgentsPanel(agents: RunningAgentRecord[], services: CommandRuntimeServices) {
  const panelId = 'agents-panel';
  const initialText = micaUi.terminalInput.text.get();
  const stateAtom = atom<AgentsPanelState>({ view: 'list', selectedIdx: 0 });

  function hide() {
    const nextPanels = micaUi.panels.pluginUIs.get().filter((panel) => panel.id !== panelId);
    micaUi.panels.setPluginUIs(nextPanels);
    micaLogger.logRuntime('plugin.agents', 'closed');
  }

  function AgentsPanel() {
    const state = micaUi.useScheduleState(stateAtom);
    return (
      <micaUi.Dialog
        title={`agents (${agents.length})`}
        footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ switch', 'esc close']} />}
      >
        <micaUi.SelectList
          items={agents.map((agent) => ({ key: agent.id, label: agent.title }))}
          selectedIdx={state.selectedIdx}
          empty={<Text dimColor>No running agents</Text>}
          renderItem={(item) => {
            const agent = agents.find((entry) => entry.id === item.key);
            if (!agent) return null;
            return (
              <Box flexDirection="column">
                <Text color={agent.current ? micaUi.theme.colors.accent : undefined}>
                  {agent.current ? '● ' : '○ '}
                  {agent.title}
                </Text>
                <Text color={micaUi.theme.colors.dim}>
                  #{agent.index} · {formatSessionMeta(agent.updatedAt, agent.model)} · {agent.status} ·{' '}
                  {agent.providerName}
                </Text>
              </Box>
            );
          }}
        />
      </micaUi.Dialog>
    );
  }

  micaUi.panels.setPluginUIs([
    ...micaUi.panels.pluginUIs.get().filter((panel) => panel.id !== panelId),
    {
      id: panelId,
      component: AgentsPanel,
      preserveInput: true,
      onInput: (input, key) => {
        const state = stateAtom.get();
        if (key.escape) {
          hide();
          return true;
        }
        if (state.view === 'list') {
          if (key.upArrow || key.downArrow) {
            const next = navigate(state.selectedIdx, agents.length, key.downArrow ? 1 : -1);
            stateAtom.set({ view: 'list', selectedIdx: next });
            return true;
          }
          if (key.return && agents.length > 0) {
            switchToSelectedAgent(state.selectedIdx);
            return true;
          }
        }
        return false;
      },
      onTextChange: (value) => {
        if (value !== initialText) hide();
        return false;
      },
    },
  ]);

  function switchToSelectedAgent(selectedIdx: number) {
    const agent = agents[selectedIdx];
    if (!agent) return;
    try {
      const switched = services.switchAgentSession(agent.id);
      services.showMessage(`Switched to #${switched.index}: ${switched.title}`, 4000);
      hide();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      services.showMessage(`Switch failed: ${message}`, 5000);
    }
  }
}

function navigate(index: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return 0;
  if (direction === -1) return index > 0 ? index - 1 : length - 1;
  return index < length - 1 ? index + 1 : 0;
}

function formatSessionMeta(updatedAt: string, model: string): string {
  const date = new Date(updatedAt);
  const timestamp = Number.isNaN(date.getTime())
    ? updatedAt
    : date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
  return `[${timestamp} ${model}]`;
}

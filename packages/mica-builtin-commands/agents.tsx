import { Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices } from './services.js';
import { AgentRow } from '@packages/mica-ui/panels/AgentRow.js';

type AgentsPanelState = { selectedIdx: number };

export function createAgentsCommand(services: CommandRuntimeServices) {
  return {
    name: 'agents',
    description: '显示当前终端的 agents；/agents clear 清除空闲 agent',
    action: (arg?: string) => {
      if (arg?.trim().toLowerCase() === 'clear') {
        const result = services.clearIdleAgents();
        micaLogger.logRuntime('plugin.agents', 'clear:done', { cleared: result.cleared.length });
        services.showMessage(
          result.cleared.length > 0
            ? `Cleared ${result.cleared.length} idle agent${result.cleared.length === 1 ? '' : 's'}`
            : 'No idle agents to clear',
          4000,
        );
        return;
      }
      const agents = services.listRunningAgents();
      micaLogger.logRuntime('plugin.agents', 'opened', { count: agents.length });
      micaUi.panels.setAgentStatusItems(agents);
      showAgentsPanel(services);
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function showAgentsPanel(services: CommandRuntimeServices) {
  const panelId = 'agents-panel';
  const initialText = micaUi.terminalInput.text.get();
  const stateAtom = atom<AgentsPanelState>({ selectedIdx: 0 });

  function hide() {
    const nextPanels = micaUi.panels.pluginUIs.get().filter((panel) => panel.id !== panelId);
    micaUi.panels.setPluginUIs(nextPanels);
    micaLogger.logRuntime('plugin.agents', 'closed');
  }

  function AgentsPanel() {
    const state = micaUi.useScheduleState(stateAtom);
    const agents = micaUi.useScheduleState(micaUi.panels.agentStatusItems);
    return (
      <micaUi.Dialog
        title={`agents (${agents.length})`}
        footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ switch', 'esc close']} />}
      >
        <micaUi.SelectList
          items={agents.map((agent) => ({ key: agent.id, label: '' }))}
          selectedIdx={state.selectedIdx}
          itemGap={0}
          empty={<Text dimColor>No running agents</Text>}
          renderItem={(item, isSelected) => {
            const agent = agents.find((a) => a.id === item.key);
            if (!agent) return null;
            return <AgentRow agent={agent} selected={isSelected} />;
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
      onInput: (_input, key) => {
        const agents = micaUi.panels.agentStatusItems.get();
        const state = stateAtom.get();

        if (key.escape) {
          hide();
          return true;
        }

        if (agents.length === 0) return true;

        if (key.upArrow) {
          stateAtom.set({
            selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : agents.length - 1,
          });
          return true;
        }

        if (key.downArrow) {
          stateAtom.set({
            selectedIdx: state.selectedIdx < agents.length - 1 ? state.selectedIdx + 1 : 0,
          });
          return true;
        }

        if (key.return) {
          switchToSelectedAgent(state.selectedIdx);
          return true;
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
    const agents = micaUi.panels.agentStatusItems.get();
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

import { Box, Text, useTerminalSize } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { MicaUiAgentStatusItem } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices } from './services.js';
import { getWorkingStatusDisplay } from '@packages/mica-ui/utils/workingStatusDisplay.js';

type AgentsPanelState = { view: 'list'; selectedIdx: number };

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
  const stateAtom = atom<AgentsPanelState>({ view: 'list', selectedIdx: 0 });

  function hide() {
    const nextPanels = micaUi.panels.pluginUIs.get().filter((panel) => panel.id !== panelId);
    micaUi.panels.setPluginUIs(nextPanels);
    micaLogger.logRuntime('plugin.agents', 'closed');
  }

  function AgentsPanel() {
    const state = micaUi.useScheduleState(stateAtom);
    const agents = micaUi.useScheduleState(micaUi.panels.agentStatusItems);
    const terminalSize = useTerminalSize();
    const layout = buildAgentGrid(agents, terminalSize?.columns ?? process.stdout.columns ?? 100);
    const selectedIdx = clampSelectedIndex(state.selectedIdx, agents.length);
    return (
      <micaUi.Dialog
        title={`agents (${agents.length})`}
        footer={<micaUi.KeyHints hints={['←↑↓→ navigate', '↵ switch', 'esc close']} />}
      >
        <Box marginTop={1} flexDirection="column">
          {agents.length === 0 ? (
            <Text dimColor>No running agents</Text>
          ) : (
            layout.rows.map((row, rowIndex) => (
              <Box key={rowIndex} flexDirection="row">
                {row.map((agent, colIndex) => (
                  <AgentListItem
                    key={agent.id}
                    agent={agent}
                    width={layout.itemWidth}
                    selected={agents[selectedIdx]?.id === agent.id}
                    marginRight={colIndex < row.length - 1 ? 2 : 0}
                  />
                ))}
              </Box>
            ))
          )}
        </Box>
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
        const state = stateAtom.get();
        if (key.escape) {
          hide();
          return true;
        }
        if (state.view === 'list') {
          const agents = micaUi.panels.agentStatusItems.get();
          const selectedIdx = clampSelectedIndex(state.selectedIdx, agents.length);
          if (key.upArrow || key.downArrow) {
            const columns = buildAgentGrid(agents, process.stdout.columns ?? 100).columns;
            const next = navigateGrid(selectedIdx, agents.length, key.downArrow ? columns : -columns);
            stateAtom.set({ view: 'list', selectedIdx: next });
            return true;
          }
          if (key.leftArrow || key.rightArrow) {
            const next = navigateGrid(selectedIdx, agents.length, key.rightArrow ? 1 : -1);
            stateAtom.set({ view: 'list', selectedIdx: next });
            return true;
          }
          if (key.return && agents.length > 0) {
            switchToSelectedAgent(selectedIdx);
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

function AgentListItem({
  agent,
  width,
  selected,
  marginRight,
}: {
  agent: MicaUiAgentStatusItem;
  width: number;
  selected: boolean;
  marginRight: number;
}) {
  const status = getWorkingStatusDisplay(agent.status);
  const contentWidth = Math.max(12, width - 8);
  const statusWidth = Math.max(8, Math.min(18, Math.floor(contentWidth * 0.34)));
  const remaining = Math.max(4, contentWidth - statusWidth);
  const titleWidth = Math.max(6, Math.floor(remaining * 0.55));
  const metaWidth = Math.max(4, remaining - titleWidth);
  return (
    <Box width={width} marginRight={marginRight} flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={selected ? micaUi.theme.colors.accent : micaUi.theme.colors.dim}>{selected ? '▶' : ' '}</Text>
      </Box>
      <Box width={titleWidth} flexShrink={0}>
        <Text color={agent.current ? micaUi.theme.colors.accent : undefined} wrap="truncate">
          #{agent.index} {agent.title}
        </Text>
      </Box>
      <Text color={micaUi.theme.colors.dim}> · </Text>
      <Box width={statusWidth} flexShrink={0}>
        <Text color={status.color} wrap="truncate">
          {status.text}
        </Text>
      </Box>
      <Text color={micaUi.theme.colors.dim}> · </Text>
      <Box width={metaWidth} flexShrink={0}>
        <Text color={micaUi.theme.colors.dim} wrap="truncate">
          {formatSessionMeta(agent.updatedAt, agent.model)} {agent.providerName}
        </Text>
      </Box>
    </Box>
  );
}

function buildAgentGrid(agents: readonly MicaUiAgentStatusItem[], terminalColumns: number) {
  const available = Math.max(32, terminalColumns - 6);
  const minItemWidth = 60;
  const columns = Math.max(1, Math.min(agents.length || 1, Math.floor((available + 2) / (minItemWidth + 2))));
  const itemWidth =
    columns === 1 ? available : Math.max(minItemWidth, Math.floor((available - (columns - 1) * 2) / columns));
  const rows: MicaUiAgentStatusItem[][] = [];
  for (let i = 0; i < agents.length; i += columns) rows.push(agents.slice(i, i + columns));
  return { columns, itemWidth, rows };
}

function clampSelectedIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, index), length - 1);
}

function navigateGrid(index: number, length: number, direction: number): number {
  if (length <= 0) return 0;
  return (index + direction + length) % length;
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

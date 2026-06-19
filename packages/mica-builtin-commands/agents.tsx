import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { CommandRuntimeServices, RunningAgentRecord } from './services.js';

type AgentsPanelState =
  | { view: 'list'; selectedIdx: number }
  | { view: 'detail'; selectedIdx: number };

export function createAgentsCommand(services: CommandRuntimeServices) {
  return {
    name: 'agents',
    description: '显示当前正在运行的 agents',
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
    if (state.view === 'detail') {
      const agent = agents[state.selectedIdx];
      return (
        <micaUi.Dialog title="agent detail" footer={<micaUi.KeyHints hints={['esc back', 'type close']} />}>
          {agent ? <AgentDetail agent={agent} /> : <Text color={micaUi.theme.colors.dim}>Agent not found</Text>}
        </micaUi.Dialog>
      );
    }

    return (
      <micaUi.Dialog title={`agents (${agents.length})`} footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ detail', 'a switch', 'esc close']} />}>
        <micaUi.SelectList
          items={agents.map((agent) => ({ key: agent.id, label: agent.cwd }))}
          selectedIdx={state.selectedIdx}
          empty={<Text dimColor>No running agents</Text>}
          renderItem={(item) => {
            const agent = agents.find((entry) => entry.id === item.key);
            if (!agent) return null;
            const isCurrent = agent.pid === process.pid;
            return (
              <Box flexDirection="column">
                <Text color={isCurrent ? micaUi.theme.colors.accent : undefined}>
                  {isCurrent ? '● local ' : '○ remote '}
                  {agent.cwd}
                </Text>
                <Text color={micaUi.theme.colors.dim}>
                  pid {agent.pid} · {agent.providerName}/{agent.model} · {agent.status} · {formatControl(agent)} · updated{' '}
                  {formatRelativeTime(agent.updatedAt)}
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
          if (state.view === 'detail') {
            stateAtom.set({ view: 'list', selectedIdx: state.selectedIdx });
            return true;
          }
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
            stateAtom.set({ view: 'detail', selectedIdx: state.selectedIdx });
            return true;
          }
          if (input === 'a' && agents.length > 0) {
            const agent = agents[state.selectedIdx];
            if (!agent) return true;
            void services.attachAgent(agent).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              micaUi.messageBar.addMessage({ id: `agents-switch-${Date.now()}`, text: `Switch failed: ${message}` });
            });
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
}

function AgentDetail({ agent }: { agent: RunningAgentRecord }) {
  return (
    <Box flexDirection="column">
      {formatDetail(agent).map(([label, value]) => (
        <Text key={label} color={micaUi.theme.colors.dim}>
          {label.padEnd(14)} : {value}
        </Text>
      ))}
    </Box>
  );
}

function formatDetail(agent: RunningAgentRecord): Array<[string, string]> {
  return [
    ['id', agent.id],
    ['pid', String(agent.pid)],
    ['cwd', agent.cwd],
    ['provider', `${agent.providerName}/${agent.model}`],
    ['status', agent.status],
    ['control', formatControl(agent)],
    ['socket', agent.ipc.socketPath],
    ['protocol', `${agent.ipc.protocol}@${agent.ipc.version}`],
    ['capabilities', formatCapabilities(agent)],
    ['updated', agent.updatedAt],
  ];
}

function formatControl(agent: RunningAgentRecord): string {
  if (agent.control.mode === 'remote-controlled') {
    return `controlled by pid ${agent.control.controllerPid ?? 'unknown'}`;
  }
  return 'local control';
}

function formatCapabilities(agent: RunningAgentRecord): string {
  return Object.entries(agent.capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');
}

function navigate(index: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return 0;
  if (direction === -1) return index > 0 ? index - 1 : length - 1;
  return index < length - 1 ? index + 1 : 0;
}

function formatRelativeTime(value: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

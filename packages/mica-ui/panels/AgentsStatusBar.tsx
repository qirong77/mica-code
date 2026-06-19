import React from 'react';
import { Box, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { agentStatusItems } from './state.js';
import { AgentRow } from './AgentRow.js';

export function AgentsStatusBar(): React.ReactNode {
  const agents = useScheduleState(agentStatusItems);
  const { columns } = useTerminalSize();

  if (agents.length <= 1) return null;

  const rowWidth = (columns ?? process.stdout.columns ?? 100) - 4;

  return (
    <Box paddingX={1} flexDirection="column">
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} compact width={rowWidth} />
      ))}
    </Box>
  );
}

export const AgentsStatusBarUI = { renderFn: AgentsStatusBar };

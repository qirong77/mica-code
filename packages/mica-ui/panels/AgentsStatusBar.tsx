import React from 'react';
import { Box } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { agentStatusItems } from './state.js';
import { AgentRow } from './AgentRow.js';

export function AgentsStatusBar(): React.ReactNode {
  const agents = useScheduleState(agentStatusItems);

  if (agents.length <= 1) return null;

  return (
    <Box paddingX={1} flexDirection="column" width="100%" minWidth={0}>
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} compact />
      ))}
    </Box>
  );
}

export const AgentsStatusBarUI = { renderFn: AgentsStatusBar };

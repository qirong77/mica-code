import React, { useMemo } from 'react';
import { Box, Text, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { agentStatusItems } from './state.js';
import { themeColors } from '../theme.js';
import { Spin } from '../primitives/Spin.js';

const MIN_SEGMENT_WIDTH = 18;

export function AgentsStatusBar(): React.ReactNode {
  const agents = useScheduleState(agentStatusItems);
  const terminalSize = useTerminalSize();

  const segments = useMemo(() => {
    if (agents.length <= 1) return [];
    const available = Math.max(40, (terminalSize?.columns ?? process.stdout.columns ?? 100) - 4);
    const separator = '  ';
    const segmentWidth = Math.max(MIN_SEGMENT_WIDTH, Math.floor((available - separator.length * (agents.length - 1)) / agents.length));
    return agents.map((agent) => ({
      agent,
      text: formatAgent(agent, segmentWidth),
    }));
  }, [agents, terminalSize?.columns]);

  if (segments.length === 0) return null;

  return (
    <Box paddingX={1}>
      {segments.map(({ agent, text }, index) => (
        <Box key={agent.id}>
          {index > 0 && <Text color={themeColors.dim}>  </Text>}
          {isRunningStatus(agent.status) && <Spin />}
          <Text color={agent.current ? themeColors.accent : themeColors.dim}>{text}</Text>
        </Box>
      ))}
    </Box>
  );
}

export const AgentsStatusBarUI = { renderFn: AgentsStatusBar };

function formatAgent(
  agent: {
    index: number;
    title: string;
    providerName: string;
    model: string;
    status: string;
    current: boolean;
  },
  width: number,
): string {
  const marker = agent.current ? '*' : ' ';
  const raw = `${marker}#${agent.index} ${agent.status} ${agent.title} (${agent.model})`;
  return truncate(raw, width);
}

function isRunningStatus(status: string): boolean {
  return status !== 'idle' && !status.startsWith('error:');
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

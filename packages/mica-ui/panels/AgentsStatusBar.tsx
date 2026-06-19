import React, { useMemo } from 'react';
import { Box, Text, useTerminalSize } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { agentStatusItems } from './state.js';
import { themeColors } from '../theme.js';
import { Spin } from '../primitives/Spin.js';
import { getWorkingStatusDisplay } from '../utils/workingStatusDisplay.js';
import type { MicaUiAgentStatusItem } from '../types.js';

const MIN_SEGMENT_WIDTH = 18;

export function AgentsStatusBar(): React.ReactNode {
  const agents = useScheduleState(agentStatusItems);
  const terminalSize = useTerminalSize();

  const segments = useMemo(() => {
    if (agents.length <= 1) return [];
    const available = Math.max(40, (terminalSize?.columns ?? process.stdout.columns ?? 100) - 4);
    const separator = '  ';
    const segmentWidth = Math.max(
      MIN_SEGMENT_WIDTH,
      Math.floor((available - separator.length * (agents.length - 1)) / agents.length),
    );
    return agents.map((agent) => ({
      agent,
      width: segmentWidth,
    }));
  }, [agents, terminalSize?.columns]);

  if (segments.length === 0) return null;

  return (
    <Box paddingX={1}>
      {segments.map(({ agent, width }, index) => (
        <Box key={agent.id}>
          {index > 0 && <Text color={themeColors.dim}> </Text>}
          <AgentSegment agent={agent} width={width} />
        </Box>
      ))}
    </Box>
  );
}

export const AgentsStatusBarUI = { renderFn: AgentsStatusBar };

function AgentSegment({ agent, width }: { agent: MicaUiAgentStatusItem; width: number }): React.ReactNode {
  const status = getWorkingStatusDisplay(agent.status);
  const prefix = `${agent.current ? '*' : ' '}#${agent.index} `;
  const suffix = ` ${truncate(`${agent.title} (${agent.model})`, Math.max(4, width - prefix.length - status.text.length - 1))}`;
  return (
    <>
      {status.spinning && <Spin />}
      <Text color={agent.current ? themeColors.accent : themeColors.dim}>{prefix}</Text>
      <Text color={status.color}>{status.text}</Text>
      <Text color={agent.current ? themeColors.accent : themeColors.dim}>{suffix}</Text>
    </>
  );
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

import React from 'react';
import { Box } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { agentTurnLogItems, workingStatus } from '../panels/state.js';
import { BottomScrollBox } from '../primitives/index.js';

export function AgentTurnLog(): React.ReactNode {
  const items = useScheduleState(agentTurnLogItems);
  const status = useScheduleState(workingStatus);

  if (status.type === 'idle' && items.length === 0) return null;

  return (
    <BottomScrollBox stickyScroll bottomReservedRows={0}>
      {items.map((item) => (
        <Box key={item.id}>
          <item.component />
        </Box>
      ))}
    </BottomScrollBox>
  );
}

export const AgentTurnLogUI = { renderFn: AgentTurnLog };

import React from 'react';
import { Box, ScrollBox } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { agentTurnLogItems, workingStatus } from '../panels/data.js';
import { useLogViewHeight } from '../hooks/useLogViewHeight.js';

export function AgentTurnLog(): React.ReactNode {
  const items = useScheduleState(agentTurnLogItems);
  const status = useScheduleState(workingStatus);
  const viewportHeight = useLogViewHeight();

  if (status.type === 'idle' && items.length === 0) return null;

  return (
    <ScrollBox height={viewportHeight} stickyScroll flexDirection="column">
      {items.map((item) => (
        <Box key={item.id}>
          <item.component />
        </Box>
      ))}
    </ScrollBox>
  );
}

export const AgentTurnLogUI = { renderFn: AgentTurnLog };

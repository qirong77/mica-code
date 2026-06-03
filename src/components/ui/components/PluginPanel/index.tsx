import React from 'react';
import { Box } from '../../../../../packages/@anthropic/ink/src';
import { useScheduleState } from '../../hooks';
import { pluginUIsAtom } from '../../../../store/ui-state.js';

export function PluginPanel(): React.ReactNode {
  const uis = useScheduleState(pluginUIsAtom);
  if (uis.length === 0) return null;
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      {uis.map((ui) => (
        <Box key={ui.id}>
          <ui.component />
        </Box>
      ))}
    </Box>
  );
}

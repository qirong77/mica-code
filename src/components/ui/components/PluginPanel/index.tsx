import React from 'react';
import { Box } from '@anthropic/ink';
import { useSchedulState } from '../../hooks';
import { pluginUIsAtom } from '../../../../store/ui-state.js';

export function PluginPanel(): React.ReactNode {
  const uis = useSchedulState(pluginUIsAtom);
  if (uis.length === 0) return null;

  return (
    <Box flexDirection="column">
      {uis.map((ui) => (
        <Box key={ui.id}>{ui.render()}</Box>
      ))}
    </Box>
  );
}

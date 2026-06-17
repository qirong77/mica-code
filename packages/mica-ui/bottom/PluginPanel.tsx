import React from 'react';
import { Box } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { pluginUIs } from '../panels/data.js';

export function PluginPanel(): React.ReactNode {
  const pluginPanels = useScheduleState(pluginUIs);
  if (pluginPanels.length === 0) return null;
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      {pluginPanels.map((pluginPanel) => <Box key={pluginPanel.id}><pluginPanel.component /></Box>)}
    </Box>
  );
}

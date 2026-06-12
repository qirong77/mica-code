import React from 'react';
import { Box } from '@anthropic/ink';
import { PluginPanel } from './PluginPanel.js';
import { DropDownUI } from '../dropdown/index.js';

export const BottomPanel = React.memo(function BottomPanel(): React.ReactNode {
  return (
    <Box flexDirection="row">
      <PluginPanel />
      <DropDownUI.renderFn />
    </Box>
  );
});
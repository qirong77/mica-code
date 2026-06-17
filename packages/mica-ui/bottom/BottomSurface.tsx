import React from 'react';
import { Box } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { pluginUIs, agentTurnLogItems, workingStatus } from '../panels/data.js';
import { state as dropdownState } from './dropdown/data.js';
import { DropDownUI } from './dropdown/index.js';
import { PluginPanel } from './PluginPanel.js';
import { AgentTurnLog } from './AgentTurnLog.js';

export function BottomSurface(): React.ReactNode {
  const dropdown = useScheduleState(dropdownState);
  const plugins = useScheduleState(pluginUIs);
  const logItems = useScheduleState(agentTurnLogItems);
  const status = useScheduleState(workingStatus);

  if (status.type === 'error') {
    return <AgentTurnLog />;
  }
  if (dropdown.visible) {
    return <DropDownUI.renderFn />;
  }
  if (plugins.length > 0) {
    return <PluginPanel />;
  }
  if (status.type !== 'idle' || logItems.length > 0) {
    return <AgentTurnLog />;
  }
  return null;
}

export const BottomSurfaceUI = { renderFn: BottomSurface };

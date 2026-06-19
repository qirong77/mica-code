import React from 'react';
import { Box } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import { pluginUIs, agentTurnLogItems, workingStatus } from '../panels/state.js';
import { state as dropdownState } from './dropdown/state.js';
import { DropDownUI } from './dropdown/index.js';
import { PluginPanel } from './PluginPanel.js';
import { AgentTurnLog } from './AgentTurnLog.js';

export function BottomSurface(): React.ReactNode {
  const dropdown = useScheduleState(dropdownState);
  const plugins = useScheduleState(pluginUIs);
  const logItems = useScheduleState(agentTurnLogItems);
  const status = useScheduleState(workingStatus);

  if (dropdown.visible) {
    return <DropDownUI.renderFn />;
  }
  if (status.type === 'error') {
    return <AgentTurnLog />;
  }
  if (plugins.length > 0) {
    return <PluginPanel />;
  }
  if (status.type === 'plugin_task' && logItems.length === 0) {
    return null;
  }
  if (status.type !== 'idle' || logItems.length > 0) {
    return <AgentTurnLog />;
  }
  return null;
}

export const BottomSurfaceUI = { renderFn: BottomSurface };

import React from 'react';
import { Box } from '@anthropic/ink';
import { useSchedulState } from '../../hooks/useSchedulState.js';
import { logTextAtom, toolCallsAtom, systemLogVisibleAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';
import { PluginPanel } from '../PluginPanel/index.js';
import { DropDownUI } from '../DropDown/index.js';
import { IfComponent } from '../common/IfComponent.js';
import { AgentLogPanel, SystemLogPanel } from '../LogPanels/index.js';

export const BottomPanel = React.memo(function BottomPanel(): React.ReactNode {
  const text = useSchedulState(logTextAtom);
  const toolCalls = useSchedulState(toolCallsAtom);
  const systemLines = useSchedulState(systemLogAtom);
  const systemLogVisible = useSchedulState(systemLogVisibleAtom);

  const hasAgentLog = text.length > 0 || toolCalls.length > 0;
  const hasSystemLog = systemLogVisible && systemLines.length > 0;

  return (
    <Box flexDirection="row">
      <PluginPanel />
      <DropDownUI.renderFn />
      <IfComponent condition={hasAgentLog || hasSystemLog}>
        <Box flexDirection="row" width="100%">
          <Box flexGrow={1} width="50%" paddingRight={1}>
            <AgentLogPanel />
          </Box>
          <IfComponent condition={hasSystemLog}>
            <Box flexGrow={1} width="50%" paddingLeft={1}>
              <SystemLogPanel />
            </Box>
          </IfComponent>
        </Box>
      </IfComponent>
    </Box>
  );
});

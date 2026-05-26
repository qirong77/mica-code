import React from 'react';
import { Box } from '@anthropic/ink';
import { useSchedulState } from '../../hooks/useSchedulState.js';
import { thinkingTextAtom, toolCallsAtom, systemLogVisibleAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';
import { PluginPanel } from '../PluginPanel/index.js';
import { DropDownUI } from '../DropDown/index.js';
import { IfComponent } from '../common/IfComponent.js';
import { ThinkingPanel, ToolCallPanel, SystemLogPanel } from '../LogPanels/index.js';

export const BottomPanel = React.memo(function BottomPanel(): React.ReactNode {
  const text = useSchedulState(thinkingTextAtom);
  const toolCalls = useSchedulState(toolCallsAtom);
  const systemLines = useSchedulState(systemLogAtom);
  const systemLogVisible = useSchedulState(systemLogVisibleAtom);

  const hasAgentContent = text.length > 0 || toolCalls.length > 0;
  const hasSystemLog = systemLogVisible && systemLines.length > 0;

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <PluginPanel />
      <DropDownUI.renderFn />
      <IfComponent condition={hasAgentContent || hasSystemLog}>
        <Box flexDirection="row" width="100%">
          <Box flexDirection="column" flexGrow={1} width="50%" paddingRight={1}>
            <ThinkingPanel />
            <ToolCallPanel />
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

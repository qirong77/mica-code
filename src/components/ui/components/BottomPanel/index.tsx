import React from 'react';
import { Box } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/useScheduleState.js';
import { thinkingTextAtom, systemLogVisibleAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';
import { PluginPanel } from '../PluginPanel/index.js';
import { DropDownUI } from '../DropDown/index.js';
import { IfComponent } from '../common/IfComponent.js';
import { ThinkingPanel, SystemLogPanel } from '../LogPanels/index.js';

export const BottomPanel = React.memo(function BottomPanel(): React.ReactNode {
  const text = useScheduleState(thinkingTextAtom);
  const systemLines = useScheduleState(systemLogAtom);
  const systemLogVisible = useScheduleState(systemLogVisibleAtom);

  const hasAgentContent = text.length > 0;
  const hasSystemLog = systemLogVisible && systemLines.length > 0;

  return (
    <Box flexDirection="row">
      <PluginPanel />
      <DropDownUI.renderFn />
      <IfComponent condition={hasAgentContent && false/* 暂时隐藏思考面板 */}>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} paddingRight={1}>
          <ThinkingPanel />
        </Box>
      </IfComponent>
      <IfComponent condition={hasSystemLog}>
        <Box flexGrow={1} flexBasis={0} minWidth={0}  paddingLeft={1}>
          <SystemLogPanel />
        </Box>
      </IfComponent>
    </Box>
  );
});

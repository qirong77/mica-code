import React from 'react';
import { Box, Text, useTerminalSize } from '@anthropic/ink';
import { useSchedulState } from '../../hooks/useSchedulState.js';
import { logTextAtom, toolCallsAtom, systemLogVisibleAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';
import { PluginPanel } from '../PluginPanel/index.js';
import { DropDownUI } from '../DropDown/index.js';
import { IfComponent } from '../common/IfComponent.js';

const MIN_LINES = 5;
const MAX_TOOL_CALLS = 3;

function useLogHeight(): number {
  const { rows } = useTerminalSize();
  return Math.max(Math.floor(rows / 2), MIN_LINES);
}

function AgentLogPanel(): React.ReactNode {
  const text = useSchedulState(logTextAtom);
  const toolCalls = useSchedulState(toolCallsAtom);
  const maxLines = useLogHeight();

  if (text.length > 0) {
    const lines = text.split('\n');
    const display = lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;
    return (
      <Box flexDirection="column" height={maxLines}>
        <Text dimColor>{display}</Text>
      </Box>
    );
  }

  if (toolCalls.length > 0) {
    const sorted = [...toolCalls].sort((a, b) => Number(a.completed) - Number(b.completed));
    const displayed = sorted.slice(0, MAX_TOOL_CALLS);
    return (
      <Box flexDirection="column">
        {displayed.map((tc) => (
          <Box key={tc.id}>
            <Text dimColor>{tc.displayText}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  return null;
}

function SystemLogPanel(): React.ReactNode {
  const lines = useSchedulState(systemLogAtom);
  const maxLines = useLogHeight();
  if (lines.length === 0) return null;

  const display = lines.length > maxLines ? lines.slice(-maxLines).join('\n') : lines.join('\n');
  return (
    <Box flexDirection="column" height={maxLines}>
      <Text dimColor>{display}</Text>
    </Box>
  );
}

export const BottomPanel = React.memo(function BottomPanel(): React.ReactNode {
  const text = useSchedulState(logTextAtom);
  const toolCalls = useSchedulState(toolCallsAtom);
  const systemLogVisible = useSchedulState(systemLogVisibleAtom);

  const hasAgentLog = text.length > 0 || toolCalls.length > 0;
  const hasSystemLog = systemLogVisible;

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

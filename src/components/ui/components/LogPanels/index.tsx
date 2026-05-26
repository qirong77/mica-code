import React from 'react';
import { Box, Text, useTerminalSize } from '@anthropic/ink';
import { useSchedulState } from '../../hooks/useSchedulState.js';
import { thinkingTextAtom, toolCallsAtom } from '../../../../store/ui-state.js';
import { systemLogAtom } from '../../../../store/logAtom.js';

const MIN_LINES = 5;
const MAX_TOOL_CALLS = 3;

function useLogHeight(): number {
  const { rows } = useTerminalSize();
  return Math.max(Math.floor(rows / 2), MIN_LINES);
}

export function ThinkingPanel(): React.ReactNode {
  const text = useSchedulState(thinkingTextAtom);
  const maxLines = useLogHeight();

  if (text.length === 0) return null;

  const lines = text.split('\n');
  const display = lines.length > maxLines ? lines.slice(-maxLines).join('\n') : text;

  return (
    <Box flexDirection="column" height={maxLines}>
      <Text dimColor>{display}</Text>
    </Box>
  );
}

export function ToolCallPanel(): React.ReactNode {
  const toolCalls = useSchedulState(toolCallsAtom);
  if (toolCalls.length === 0) return null;

  const sorted = [...toolCalls].sort((a, b) => Number(a.completed) - Number(b.completed));
  const displayed = sorted.slice(0, MAX_TOOL_CALLS);

  return (
    <Box flexDirection="column">
      {displayed.map((tc) => (
        <Box key={tc.id}>
          <Text dimColor>
            {tc.displayText}
            {tc.elapsedMs != null && !tc.completed ? ` (${(tc.elapsedMs / 1000).toFixed(1)}s)` : ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function SystemLogPanel(): React.ReactNode {
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

import React, { useMemo } from 'react';
import { Box, Text } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/index.js';
import {
  thinkingTextAtom,
  workingStatusAtom,
  pluginUIsAtom,
  inputBottomDistanceAtom,
  dropdown,
} from '../../../../store/ui-state.js';
import { C } from '../../data.js';

const MIN_VISIBLE_LINES = 2;
const MAX_THINKING_LINES = 15;
const RESERVED_LINES = 6;

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function AgentTurnLog() {
  const thinkingText = useScheduleState(thinkingTextAtom);
  const status = useScheduleState(workingStatusAtom);
  const pluginUIs = useScheduleState(pluginUIsAtom);
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const dropdownState = useScheduleState(dropdown.state);

  const calcMax = Math.max(MIN_VISIBLE_LINES, bottomDistance - RESERVED_LINES);
  const maxLines = Math.min(MAX_THINKING_LINES, calcMax);

  const toolLineCount =
    status.type === 'calling_tool' && status.toolNames ? status.toolNames.length : 0;

  const thinkingLines = useMemo(() => {
    if (thinkingText.length === 0) return [];
    const lines = thinkingText.split('\n');
    const available = Math.max(1, maxLines - toolLineCount);
    if (lines.length <= available) return lines;
    return lines.slice(-available);
  }, [thinkingText, maxLines, toolLineCount]);

  if (pluginUIs.length > 0 || dropdownState.visible) return null;

  if (status.type === 'idle' && thinkingText.length === 0) return null;

  return (
    <Box flexDirection="column">
      {thinkingLines.length > 0 && (
        <Box
          flexDirection="column"

        >
          {thinkingLines.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {status.type === 'calling_tool' &&
        status.toolNames &&
        status.toolNames.map((name, i) => (
          <Text key={i} color={C.info}>
            {name}
            {status.elapsedMs != null && (
              <Text color={C.dim}> ({formatElapsed(status.elapsedMs)})</Text>
            )}
          </Text>
        ))}
    </Box>
  );
}

import React, { useState, useEffect } from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import {
  thinkingTextAtom,
  workingStatusAtom,
  activeToolsAtom,
  pluginUIsAtom,
  inputBottomDistanceAtom,
  dropdown,
} from '../../store/uiState.js';
import type { ActiveTool } from '../../store/uiState.js';
import { C } from '../data.js';
import { useSpinner } from '../primitives/Spin.js';
import { formatElapsed } from '../../utils/format.js';
import { useLogViewHeight } from '../hooks/useLogViewHeight.js';

const MAX_TOOL_OUTPUT_LINES = 500;


const TOOL_ICONS: Record<string, string> = {
  read_file: '📖',
  write_file: '✍️',
  edit_file: '✏️',
  list_files: '📂',
  grep_search: '🔍',
  run_shell: '⚡',
  web_fetch: '🌐',
  Skill: '🔧',
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] || '⚙️';
}

function useNow(interval = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

function ActiveToolLine({
  tool,
  spinner,
  now,
}: {
  tool: ActiveTool;
  spinner: string;
  now: number;
}) {
  const icon = toolIcon(tool.toolName);

  if (tool.completed) {
    return (
      <Box flexDirection="row">
        <Text color={C.success}> ✅ </Text>
        <Text color={C.dim}>{icon} </Text>
        <Text color={C.dim}>{tool.displayText}</Text>
        {tool.elapsedMs != null && <Text color={C.dim}> ({formatElapsed(tool.elapsedMs)})</Text>}
      </Box>
    );
  }

  const elapsed = formatElapsed(now - tool.startTime);
  return (
    <Box flexDirection="row">
      <Text color={C.info}>{spinner} </Text>
      <Text dimColor>{icon} </Text>
      <Text dimColor>{tool.displayText}</Text>
      <Text color={C.dim}> {elapsed}</Text>
    </Box>
  );
}

export const AgentTurnLogUI = { renderFn: AgentTurnLog };

export function AgentTurnLog() {
  const thinkingText = useScheduleState(thinkingTextAtom);
  const status = useScheduleState(workingStatusAtom);
  const activeTools = useScheduleState(activeToolsAtom);
  const pluginUIs = useScheduleState(pluginUIsAtom);
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const dropdownState = useScheduleState(dropdown.state);

  const spinner = useSpinner();
  const now = useNow(100);

  const viewportHeight = useLogViewHeight()
  if (pluginUIs.length > 0 || dropdownState.visible) return null;
  if (status.type === 'idle' && thinkingText.length === 0 && activeTools.length === 0) return null;

  return (
    <ScrollBox height={viewportHeight} stickyScroll flexDirection="column">
      {thinkingText.length > 0 && (
        <Box flexDirection="column">
          {thinkingText.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {activeTools.map((tool) => {
        const outputLines =
          tool.toolName === 'run_shell' && tool.output ? tool.output.split('\n') : [];
        const capped =
          outputLines.length > MAX_TOOL_OUTPUT_LINES
            ? outputLines.slice(-MAX_TOOL_OUTPUT_LINES)
            : outputLines;

        return (
          <Box key={tool.toolUseId} flexDirection="column">
            <ActiveToolLine tool={tool} spinner={spinner} now={now} />
            {capped.length > 0 && (
              <Box flexDirection="column">
                {capped.map((line, i) => (
                  <Text key={i} dimColor>
                    {'  │ '}
                    {line}
                  </Text>
                ))}
              </Box>
            )}
          </Box>
        );
      })}
    </ScrollBox>
  );
}

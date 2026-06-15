import React from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import { useScheduleState } from '../hooks/index.js';
import {
  logEntriesAtom,
  workingStatusAtom,
  pluginUIsAtom,
  inputBottomDistanceAtom,
  dropdown,
} from '../../store/uiState.js';
import type { LogEntry } from '../../store/uiState.js';
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

function ToolLine({ entry, spinner, now }: { entry: LogEntry & { type: 'tool' }; spinner: string; now: number }) {
  const icon = toolIcon(entry.toolName);

  if (entry.completed) {
    return (
      <Box flexDirection="row">
        <Text color={C.success}> ✅ </Text>
        <Text color={C.dim}>{icon} </Text>
        <Text color={C.dim}>{entry.displayText}</Text>
        {entry.elapsedMs != null && <Text color={C.dim}> ({formatElapsed(entry.elapsedMs)})</Text>}
      </Box>
    );
  }

  const elapsed = formatElapsed(now - entry.startTime);
  return (
    <Box flexDirection="row">
      <Text color={C.info}>{spinner} </Text>
      <Text dimColor>{icon} </Text>
      <Text dimColor>{entry.displayText}</Text>
      <Text color={C.dim}> {elapsed}</Text>
    </Box>
  );
}

export const AgentTurnLogUI = { renderFn: AgentTurnLog };

export function AgentTurnLog() {
  const entries = useScheduleState(logEntriesAtom);
  const status = useScheduleState(workingStatusAtom);
  const pluginUIs = useScheduleState(pluginUIsAtom);
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);
  const dropdownState = useScheduleState(dropdown.state);

  const spinner = useSpinner();
  const now = useNow(100);

  const viewportHeight = useLogViewHeight()
  if (pluginUIs.length > 0 || dropdownState.visible) return null;
  if (status.type === 'idle' && entries.length === 0) return null;

  return (
    <ScrollBox height={viewportHeight} stickyScroll flexDirection="column">
      {entries.map((entry) => {
        if (entry.type === 'thinking') {
          return (
            <Box key={entry.id} flexDirection="column">
              {entry.text.split('\n').map((line, i) => (
                <Text key={i} dimColor>
                  {line}
                </Text>
              ))}
            </Box>
          );
        }

        const outputLines =
          entry.toolName === 'run_shell' && entry.output
            ? entry.output.split('\n')
            : [];
        const capped =
          outputLines.length > MAX_TOOL_OUTPUT_LINES
            ? outputLines.slice(-MAX_TOOL_OUTPUT_LINES)
            : outputLines;

        return (
          <Box key={entry.toolUseId} flexDirection="column">
            <ToolLine entry={entry} spinner={spinner} now={now} />
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

function useNow(interval = 100): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

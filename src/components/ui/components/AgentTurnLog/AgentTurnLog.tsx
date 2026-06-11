import React, { useState, useEffect } from 'react';
import { Box, Text, ScrollBox } from '@anthropic/ink';
import { useScheduleState } from '../../hooks/index.js';
import {
  thinkingTextAtom,
  workingStatusAtom,
  activeToolsAtom,
  pluginUIsAtom,
  dropdown,
} from '../../../../store/ui-state.js';
import type { ActiveTool } from '../../../../store/ui-state.js';
import { C } from '../../data.js';

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

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function toolIcon(name: string): string {
  return TOOL_ICONS[name] || '⚙️';
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function useSpinner(): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);
  return frame;
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
  spinnerFrame,
  now,
}: {
  tool: ActiveTool;
  spinnerFrame: number;
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
      <Text color={C.info}>{SPINNER[spinnerFrame]} </Text>
      <Text dimColor>{icon} </Text>
      <Text dimColor>{tool.displayText}</Text>
      <Text color={C.dim}> {elapsed}</Text>
    </Box>
  );
}

export function AgentTurnLog() {
  const thinkingText = useScheduleState(thinkingTextAtom);
  const status = useScheduleState(workingStatusAtom);
  const activeTools = useScheduleState(activeToolsAtom);
  const pluginUIs = useScheduleState(pluginUIsAtom);
  const dropdownState = useScheduleState(dropdown.state);

  const spinnerFrame = useSpinner();
  const now = useNow(100);

  if (pluginUIs.length > 0 || dropdownState.visible) return null;
  if (status.type === 'idle' && thinkingText.length === 0 && activeTools.length === 0) return null;

  return (
    <ScrollBox flexGrow={1} stickyScroll flexDirection="column">
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
          tool.toolName === 'run_shell' && tool.output
            ? tool.output.split('\n')
            : [];
        const capped =
          outputLines.length > MAX_TOOL_OUTPUT_LINES
            ? outputLines.slice(-MAX_TOOL_OUTPUT_LINES)
            : outputLines;

        return (
          <Box key={tool.toolUseId} flexDirection="column">
            <ActiveToolLine tool={tool} spinnerFrame={spinnerFrame} now={now} />
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

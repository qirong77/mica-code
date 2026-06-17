import React, { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { themeColors } from '../mica-ui/theme.js';
import type { MicaUiAgentTurnLogItem } from '../mica-ui/types.js';
import { useSpinner } from '../mica-ui/primitives/Spin.js';

const MAX_RUN_SHELL_LOG_LINES = 10;
const TOOL_ICONS: Record<string, string> = {
  read_file: '📖',
  write_file: '✍️',
  edit_file: '✏️',
  list_files: '📂',
  grep_search: '🔍',
  run_shell: '⚡',
  web_fetch: '🌐',
  web_search: '🔎',
  Skill: '🔧',
};

export function createThinkingLogItem(id: string, text: string): MicaUiAgentTurnLogItem {
  function ThinkingLogItem() {
    return (
      <Box>
        <Text dimColor wrap="wrap">{text}</Text>
      </Box>
    );
  }
  return { id, component: ThinkingLogItem };
}

export function createToolCallLogItem({
  id,
  toolName,
  displayText,
  completed = true,
  output = '',
  startTime = Date.now(),
  elapsedMs,
}: {
  id: string;
  toolName: string;
  displayText: string;
  completed?: boolean;
  output?: string;
  startTime?: number;
  elapsedMs?: number;
}): MicaUiAgentTurnLogItem {
  function ToolCallLogItem() {
    const spinner = useSpinner();
    const now = useNow();
    const outputLines = toolName === 'run_shell' && output ? output.replace(/\n$/, '').split('\n') : [];
    const capped = outputLines.length > MAX_RUN_SHELL_LOG_LINES ? outputLines.slice(-MAX_RUN_SHELL_LOG_LINES) : outputLines;
    const elapsed = elapsedMs ?? Math.max(0, now - startTime);
    return (
      <Box flexDirection="column">
        {completed ? (
          <Box flexDirection="row">
            <Text dimColor>{toolIcon(toolName)} </Text>
            <Text dimColor>{displayText}</Text>
            <Text dimColor> ({formatElapsed(elapsed)})</Text>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text dimColor>{spinner} </Text>
            <Text dimColor>{toolIcon(toolName)} </Text>
            <Text dimColor>{displayText}</Text>
            <Text dimColor> {formatElapsed(elapsed)}</Text>
          </Box>
        )}
        {capped.length > 0 ? (
          <Box flexDirection="column">
            {capped.map((line, i) => <Text key={i} dimColor>{'  │ '}{line}</Text>)}
          </Box>
        ) : null}
      </Box>
    );
  }
  return { id, component: ToolCallLogItem };
}

export function createErrorLogItem({
  id,
  title = '请求失败',
  error,
}: {
  id: string;
  title?: string;
  error: unknown;
}): MicaUiAgentTurnLogItem {
  const message = error instanceof Error ? error.message : String(error);
  const stackLines = error instanceof Error && error.stack
    ? error.stack.split('\n').slice(1, 12)
    : [];

  function ErrorLogItem() {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color={themeColors.error}> ✗ </Text>
          <Text color={themeColors.error} bold>{title}</Text>
        </Box>
        <Text color={themeColors.error} wrap="wrap">  {message}</Text>
        {stackLines.length > 0 ? (
          <Box flexDirection="column">
            {stackLines.map((line, i) => <Text key={i} dimColor wrap="wrap">{'  │ '}{line.trim()}</Text>)}
          </Box>
        ) : null}
      </Box>
    );
  }

  return { id, component: ErrorLogItem };
}

function useNow(interval = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

function toolIcon(name: string): string {
  return TOOL_ICONS[name] || '⚙️';
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

import { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import type { MicaUiAgentTurnLogItem } from './types.js';
import { useSpinner } from './primitives/Spin.js';
import { formatElapsed } from './utils/format.js';

export const RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS = runtimeEnv.ui.runShellVerboseLogThresholdMs;
const MAX_RUN_SHELL_LOG_LINES = runtimeEnv.ui.runShellLogMaxLines;
const TOOL_ICONS: Record<string, string> = {
  read_file: '📖',
  read_image: '📷',
  write_file: '✍️',
  list_files: '📂',
  grep_search: '📊',
  run_shell: '⚡️',
  web_fetch: '🔗',
  web_search: '🌐',
  Skill: '✨',
  apply_patch: '🩹',
  Agent: '🤖',
  background_tasks: '📋',
  read_task_output: '📋',
  kill_task: '📋',
};

export function createThinkingLogItem(id: string, text: string): MicaUiAgentTurnLogItem {
  function ThinkingLogItem() {
    return (
      <Box>
        <Text dimColor wrap="wrap">
          {text}
        </Text>
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
  const completedElapsedMs = elapsedMs ?? Math.max(0, Date.now() - startTime);

  function CompletedToolCallLogItem() {
    const capped = getVisibleOutputLines({ toolName, output, elapsedMs: completedElapsedMs });

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{getToolIcon(toolName)} </Text>
          <Text dimColor>{displayText}</Text>
          <Text dimColor> ({formatElapsed(completedElapsedMs)})</Text>
        </Box>
        <ToolOutputLines lines={capped} />
      </Box>
    );
  }

  function RunningToolCallLogItem() {
    const spinner = useSpinner();
    const now = useNow();
    const elapsed = elapsedMs ?? Math.max(0, now - startTime);
    const capped = getVisibleOutputLines({ toolName, output, elapsedMs: elapsed });

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{spinner} </Text>
          <Text dimColor>{getToolIcon(toolName)} </Text>
          <Text dimColor>{displayText}</Text>
          <Text dimColor> {formatElapsed(elapsed)}</Text>
        </Box>
        <ToolOutputLines lines={capped} />
      </Box>
    );
  }

  return { id, component: completed ? CompletedToolCallLogItem : RunningToolCallLogItem };
}

function getVisibleOutputLines({
  toolName,
  output,
  elapsedMs,
}: {
  toolName: string;
  output: string;
  elapsedMs: number;
}): string[] {
  const outputLines = shouldShowToolOutput({ toolName, output, elapsedMs })
    ? output.replace(/\n$/, '').split('\n')
    : [];
  return outputLines.length > MAX_RUN_SHELL_LOG_LINES ? outputLines.slice(-MAX_RUN_SHELL_LOG_LINES) : outputLines;
}

function ToolOutputLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {'  │ '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

export function shouldShowToolOutput({
  toolName,
  output,
  elapsedMs,
}: {
  toolName: string;
  output: string;
  elapsedMs: number;
}): boolean {
  return toolName === 'run_shell' && Boolean(output) && elapsedMs > RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS;
}

export function getToolIcon(name: string): string {
  if (name.startsWith('mcp__')) return '🔌';
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

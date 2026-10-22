import { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import type { MicaUiAgentTurnLogItem } from './types.js';
import { useSpinner } from './primitives/Spin.js';
import { formatElapsed } from './utils/format.js';

const DEFAULT_TOOL_ICONS = new Map<string, string>(
  Object.entries({
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
    wait_for: '⏳',
  }),
);
const toolIconRegistrations = new Map<string, Array<{ icon: string }>>();

export function registerToolIcon(name: string, icon: string): () => void {
  const registration = { icon };
  const registrations = toolIconRegistrations.get(name) ?? [];
  registrations.push(registration);
  toolIconRegistrations.set(name, registrations);
  return () => {
    const current = toolIconRegistrations.get(name);
    if (!current) return;
    const index = current.indexOf(registration);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) toolIconRegistrations.delete(name);
  };
}

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

/**
 * 回合日志里一行工具调用：状态图标 + 文案 + 耗时，永远只占一行。
 *
 * 终端没有第二块可点开的面板，所以这行就是全部信息：超长文案交给 Ink 的
 * `truncate-end` 按当前列宽裁成省略号，工具输出不再往下铺（要读输出请用
 * `read_task_output` / 网页端）。换行必须先压成空格：`truncate-end` 只裁宽度，
 * 多行命令会照样铺成多行。思考不在此列——它照旧整段折行。
 */
export function createToolCallLogItem({
  id,
  toolName,
  displayText,
  completed = true,
  startTime = Date.now(),
  elapsedMs,
}: {
  id: string;
  toolName: string;
  displayText: string;
  completed?: boolean;
  startTime?: number;
  elapsedMs?: number;
}): MicaUiAgentTurnLogItem {
  const completedElapsedMs = elapsedMs ?? Math.max(0, Date.now() - startTime);
  const line = singleLine(displayText);

  function CompletedToolCallLogItem() {
    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {`${getToolIcon(toolName)} ${line} (${formatElapsed(completedElapsedMs)})`}
        </Text>
      </Box>
    );
  }

  function RunningToolCallLogItem() {
    const spinner = useSpinner();
    const now = useNow();
    const elapsed = elapsedMs ?? Math.max(0, now - startTime);

    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          {`${spinner} ${getToolIcon(toolName)} ${line} ${formatElapsed(elapsed)}`}
        </Text>
      </Box>
    );
  }

  return { id, component: completed ? CompletedToolCallLogItem : RunningToolCallLogItem };
}

/** 多行文本压成一行：工具调用那行只允许占一行（思考不压缩，照旧折行）。 */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function getToolIcon(name: string): string {
  if (name.startsWith('mcp__')) return '🔌';
  return toolIconRegistrations.get(name)?.at(-1)?.icon ?? DEFAULT_TOOL_ICONS.get(name) ?? '⚙️';
}

function useNow(interval = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

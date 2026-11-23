import { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import { micaTools } from '@packages/mica-tools/index.js';
import type { MicaUiAgentTurnLogItem } from './types.js';
import { useSpinner } from './primitives/Spin.js';
import { formatElapsed } from './utils/format.js';

/**
 * 思考正文里的空行整段删掉。桌面端同一规则见 `chat-tool-views.jsx` 的
 * `collapseThinkingBlankLines`：模型在每段之间连打几个换行时，终端每一行都是
 * 一行真实高度，空行比桌面更贵。
 */
function collapseThinkingBlankLines(text: string): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n');
}

export function createThinkingLogItem(id: string, text: string): MicaUiAgentTurnLogItem {
  const body = collapseThinkingBlankLines(text);
  function ThinkingLogItem() {
    return (
      <Box>
        <Text dimColor wrap="wrap">
          {body}
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
 * `background_tasks_read` / 网页端）。换行必须先压成空格：`truncate-end` 只裁宽度，
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

/**
 * 工具行左侧的 emoji。
 *
 * 只有一份事实来源：注册表里工具自己的声明（内置工具类的 `icon`、插件注册时的
 * `{ icon }`）。这里不再留静态表——表与注册表漂移的时候，缺的那一行就退化成默认齿轮。
 */
export function getToolIcon(name: string): string {
  return micaTools.getIcon(name);
}

function useNow(interval = 100): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { themeColors } from '../theme.js';
import { useScheduleState } from '../hooks/useScheduleState.js';
import { startupBanner } from '../panels/state.js';

const INNER_WIDTH = 54;
const CONTENT_WIDTH = INNER_WIDTH - 2;
const COLUMN_WIDTH = 24;
const COLUMN_GAP = 4;
const LABEL_WIDTH = 8;
const LABEL_VALUE_GAP = 2;
const VALUE_WIDTH = COLUMN_WIDTH - LABEL_WIDTH - LABEL_VALUE_GAP;
const RULE = '─'.repeat(INNER_WIDTH);

export function StartupBanner(): React.ReactNode {
  const state = useScheduleState(startupBanner);

  return (
    <Box flexDirection="column" paddingBottom={1}>
      <Border left="╭" right="╮" />
      <Content text="✦ Mica Code" color={themeColors.primary} bold />
      <Content text="  Lightweight coding agent for your CLI" color={themeColors.dim} />
      <Border left="├" right="┤" />
      <Content text={formatRow('Provider', state.provider, 'Model', state.model)} />
      <Content text={formatRow('Context', state.context, 'Effort', state.effort)} />
      <Content text={formatRow('Tools', state.tools, 'MCP', state.mcp)} />
      <Content text={formatRow('Session', state.session, 'Workdir', state.workdir)} />
      <Border left="├" right="┤" />
      <Content text={formatTip(state.tips)} />
      <Border left="╰" right="╯" />
    </Box>
  );
}

function Border({ left, right }: { left: string; right: string }): React.ReactNode {
  return <Text color={themeColors.dim}>{`${left}${RULE}${right}`}</Text>;
}

function Content({ text, color, bold }: { text: string; color?: string; bold?: boolean }): React.ReactNode {
  return (
    <Text color={color} bold={bold}>
      {`│ ${padRight(fitText(text, CONTENT_WIDTH), CONTENT_WIDTH)} │`}
    </Text>
  );
}

function formatRow(leftLabel: string, leftValue: string, rightLabel: string, rightValue: string): string {
  return `${formatPair(leftLabel, leftValue)}${' '.repeat(COLUMN_GAP)}${formatPair(rightLabel, rightValue)}`;
}

function formatTip(tip: string): string {
  return `${padRight('Tips', LABEL_WIDTH)}${' '.repeat(LABEL_VALUE_GAP)}${fitText(tip, CONTENT_WIDTH - LABEL_WIDTH - LABEL_VALUE_GAP)}`;
}

function formatPair(label: string, value: string): string {
  return `${padRight(label, LABEL_WIDTH)}${' '.repeat(LABEL_VALUE_GAP)}${padRight(fitText(value, VALUE_WIDTH), VALUE_WIDTH)}`;
}

function fitText(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

export const StartupBannerUI = { renderFn: StartupBanner };

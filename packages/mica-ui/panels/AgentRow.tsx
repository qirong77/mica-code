import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { themeColors } from '../theme.js';
import { Spin } from '../primitives/Spin.js';
import { getWorkingStatusDisplay } from '../utils/workingStatusDisplay.js';
import type { MicaUiAgentStatusItem } from '../types.js';

export function AgentRow({
  agent,
  selected,
  compact,
  width,
}: {
  agent: MicaUiAgentStatusItem;
  selected?: boolean;
  compact?: boolean;
  width?: number;
}): React.ReactNode {
  const status = getWorkingStatusDisplay(agent.status);

  if (compact) {
    const marker = agent.current ? '*' : ' ';
    const prefix = `${marker} # ${agent.index} `;
    const model = `(${agent.model})`;
    const w = width ?? 60;
    const spinnerWidth = status.spinning ? 1 : 0;
    const titleWidth = Math.max(4, w - spinnerWidth - prefix.length - status.text.length - model.length - 3);
    return (
      <Box flexDirection="row">
        {status.spinning && <Spin />}
        <Text color={agent.current ? themeColors.accent : themeColors.dim}>{prefix}</Text>
        <Text color={status.color}>{status.text}</Text>
        <Text color={agent.current ? themeColors.accent : themeColors.dim}> {truncate(agent.title, titleWidth)} </Text>
        <Text color={agent.current ? themeColors.accent : themeColors.dim}>{model}</Text>
      </Box>
    );
  }

  const meta = formatSessionMeta(agent.updatedAt, agent.model);
  const title = truncate(`#${agent.index} ${agent.title}`, 22);
  const statusText = truncate(status.text, 18);
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} width={24}>
        <Text color={agent.current ? themeColors.accent : undefined} bold={selected}>
          {title}
        </Text>
      </Box>
      <Box flexShrink={0} width={2}>
        <Text color={themeColors.dim}>·</Text>
      </Box>
      <Box flexShrink={0} width={20}>
        <Text color={status.color}>{statusText}</Text>
      </Box>
      <Box flexShrink={0} width={2}>
        <Text color={themeColors.dim}>·</Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={themeColors.dim}>
          {meta} {agent.providerName}
        </Text>
      </Box>
    </Box>
  );
}

function formatSessionMeta(updatedAt: string, model: string): string {
  const date = new Date(updatedAt);
  const timestamp = Number.isNaN(date.getTime())
    ? updatedAt
    : date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
  return `[${timestamp} ${model}]`;
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

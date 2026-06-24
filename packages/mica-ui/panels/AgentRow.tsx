import { basename } from 'node:path';
import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { themeColors } from '../theme.js';
import { Spin } from '../primitives/Spin.js';
import { OneLineItem, getOneLineColumnWidth } from '../primitives/OneLineItem.js';
import { getWorkingStatusDisplay } from '../utils/workingStatusDisplay.js';
import { formatElapsed, formatSessionListTime } from '../utils/format.js';
import type { MicaUiAgentStatusItem } from '../types.js';

export type AgentRowLayout = {
  workspaceWidth: number;
  statusWidth: number;
};

export function getAgentRowLayout(agents: readonly MicaUiAgentStatusItem[]): AgentRowLayout {
  const workspaceWidth = getOneLineColumnWidth(
    agents.map((agent) => formatAgentWorkspace(agent)),
    { min: 18, max: 24, padding: 1 },
  );
  const statusWidth = getOneLineColumnWidth(
    agents.map((agent) => getWorkingStatusDisplay(agent.status).text),
    { min: 10, max: 18, padding: 1 },
  );

  return {
    workspaceWidth,
    statusWidth,
  };
}

export function AgentRow({
  agent,
  selected,
  compact,
  width,
  layout,
  nowMs = Date.now(),
}: {
  agent: MicaUiAgentStatusItem;
  selected?: boolean;
  compact?: boolean;
  width?: number;
  layout?: AgentRowLayout;
  nowMs?: number;
}): React.ReactNode {
  const status = getWorkingStatusDisplay(agent.status);

  if (compact) {
    if (agent.current) {
      // 暂时不显示当前的 agent
      return null;
    }

    const runtime = formatAgentRuntime(agent.startedAt, nowMs);
    return (
      <Box paddingTop={1} width={width ?? '100%'} minWidth={0}>
        <OneLineItem
          cells={[
            {
              key: 'marker',
              content: `🤖`,
              flexShrink: 0,
            },
            {
              key: 'spinner',
              content: status.spinning ? <Spin /> : undefined,
            },
            {
              key: 'status',
              content: status.spinning ? `${status.text}...` : status.text,
              flexShrink: 0,
              color: status.color,
            },
            {
              key: 'runtime',
              content: status.spinning ? <Text dimColor>{runtime}</Text> : undefined,
              flexShrink: 0,
            },

            {
              key: 'title',
              content: agent.title,
              maxWidth: '70%',
              minWidth: 0,
              flexShrink: 1,
              color: themeColors.dim,
            },
          ]}
        />
      </Box>
    );
  }

  return (
    <OneLineItem
      cells={[
        {
          key: 'spinner',
          content: status.spinning ? <Spin /> : undefined,
        },
        {
          key: 'status',
          content: status.text,
          width: layout?.statusWidth ?? 12,
          flexShrink: 0,
          color: status.color,
        },
        {
          key: 'title',
          content: ` #${agent.index} ${agent.title}`,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 16,
          color: selected || agent.current ? themeColors.accent : undefined,
          bold: selected,
        },
        {
          key: 'workspace',
          content: formatAgentWorkspace(agent),
          width: layout?.workspaceWidth ?? 24,
          flexShrink: 0,
          color: selected ? themeColors.accent : undefined,
          dimColor: !selected,
        },
        {
          key: 'time',
          content: formatSessionListTime(agent.updatedAt),
          width: 16,
          flexShrink: 0,
          color: selected ? themeColors.accent : undefined,
          dimColor: !selected,
        },
        {
          key: 'model',
          content: agent.model,
          width: 20,
          flexShrink: 0,
          color: selected ? themeColors.accent : undefined,
          dimColor: !selected,
        },
      ]}
    />
  );
}

function formatAgentWorkspace(agent: MicaUiAgentStatusItem): string {
  const workspace = basename(agent.cwd) || agent.cwd;
  return agent.current ? `${workspace} · current` : workspace;
}

function formatAgentRuntime(startedAt: string, nowMs: number): string {
  const startedMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedMs)) return '--';
  return formatElapsed(Math.max(0, nowMs - startedMs));
}

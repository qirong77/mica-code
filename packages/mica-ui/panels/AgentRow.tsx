import React from 'react';
import { Box } from '@anthropic/ink';
import { themeColors } from '../theme.js';
import { Spin } from '../primitives/Spin.js';
import { OneLineItem, getOneLineColumnWidth } from '../primitives/OneLineItem.js';
import { getWorkingStatusDisplay } from '../utils/workingStatusDisplay.js';
import { formatSessionMeta } from '../utils/format.js';
import type { MicaUiAgentStatusItem } from '../types.js';

export type AgentRowLayout = {
  titleWidth: number;
  statusWidth: number;
};

export function getAgentRowLayout(agents: readonly MicaUiAgentStatusItem[], availableWidth = 120): AgentRowLayout {
  const statusWidth = getOneLineColumnWidth(
    agents.map((agent) => getWorkingStatusDisplay(agent.status).text),
    { min: 12, max: 28, padding: 1 },
  );
  const metaWidth = getOneLineColumnWidth(
    agents.map((agent) => `${formatSessionMeta(agent.updatedAt, agent.model)} ${agent.providerName}`),
    { min: 24, max: 72, padding: 1 },
  );
  const separatorsAndGapsWidth = 6;
  const titleMaxWidth = Math.max(16, availableWidth - statusWidth - metaWidth - separatorsAndGapsWidth);

  return {
    titleWidth: getOneLineColumnWidth(
      agents.map((agent) => `#${agent.index} ${agent.title}`),
      { min: 16, max: titleMaxWidth, padding: 1 },
    ),
    statusWidth,
  };
}

export function AgentRow({
  agent,
  selected,
  compact,
  width,
  layout,
}: {
  agent: MicaUiAgentStatusItem;
  selected?: boolean;
  compact?: boolean;
  width?: number;
  layout?: AgentRowLayout;
}): React.ReactNode {
  const status = getWorkingStatusDisplay(agent.status);

  if (compact) {
    const marker = agent.current ? '*' : ' ';
    if (marker === '*') {
      // 暂时不显示当前的 agent
      return null;
    }
    const model = `(${agent.model})`;
    return (
      <Box paddingTop={1} width={width ?? '100%'} minWidth={0}>
        <OneLineItem
          cells={[
            {
              key: 'spinner',
              content: status.spinning ? <Spin /> : undefined,
              width: status.spinning ? 1 : 0,
            },
            {
              key: 'status',
              content: status.text,
              maxWidth: '25%',
              minWidth: 8,
              flexShrink: 1,
              color: status.color,
            },
            {
              key: 'index',
              content: `#${agent.index}`,
              flexShrink: 0,
              dimColor: true,
            },
            {
              key: 'title',
              content: agent.title,
              maxWidth: '45%',
              minWidth: 0,
              flexShrink: 1,
              color: agent.current ? themeColors.accent : themeColors.dim,
            },
            {
              key: 'model',
              content: model,
              maxWidth: '30%',
              minWidth: 6,
              flexShrink: 1,
              color: agent.current ? themeColors.accent : themeColors.dim,
            },
          ]}
        />
      </Box>
    );
  }

  const meta = formatSessionMeta(agent.updatedAt, agent.model);
  return (
    <OneLineItem
      cells={[
        {
          key: 'title',
          content: `#${agent.index} ${agent.title}`,
          width: layout?.titleWidth ?? 24,
          minWidth: 8,
          flexShrink: 1,
          color: agent.current ? themeColors.accent : undefined,
          bold: selected,
        },
        {
          key: 'sep-status',
          content: '·',
          flexShrink: 0,
          color: themeColors.dim,
        },
        {
          key: 'status',
          content: status.text,
          width: layout?.statusWidth ?? 18,
          minWidth: 8,
          flexShrink: 1,
          color: status.color,
        },
        {
          key: 'sep-meta',
          content: '·',
          flexShrink: 0,
          color: themeColors.dim,
        },
        {
          key: 'meta',
          content: `${meta} ${agent.providerName}`,
          flexGrow: 1,
          minWidth: 0,
          dimColor: true,
        },
      ]}
    />
  );
}

import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { OneLineItem } from '../primitives/OneLineItem.js';
import { themeColors } from '../theme.js';
import type { MicaUiSubagentTaskItem, MicaUiSubagentTaskStatus } from '../types.js';
import { formatElapsed } from '../utils/format.js';

export function SubagentTaskRow({
  task,
  nowMs = Date.now(),
}: {
  task: MicaUiSubagentTaskItem;
  nowMs?: number;
}): React.ReactNode {
  return (
    <Box paddingTop={1} width="100%" minWidth={0}>
      <OneLineItem
        cells={[
          { key: 'marker', content: '🤖', flexShrink: 0 },
          { key: 'status', content: task.status, flexShrink: 0, color: subagentStatusColor(task.status) },
          { key: 'runtime', content: <Text dimColor>{formatSubagentTaskAge(task, nowMs)}</Text>, flexShrink: 0 },
          { key: 'type', content: task.subagentType, flexShrink: 0, color: themeColors.accent },
          {
            key: 'description',
            content: normalizeDescription(task.description),
            flexGrow: 1,
            minWidth: 0,
            color: themeColors.text,
          },
          { key: 'id', content: shortSubagentTaskId(task.id), flexShrink: 0, color: themeColors.dim },
        ]}
      />
    </Box>
  );
}

export function isActiveSubagentTaskStatus(status: MicaUiSubagentTaskStatus): boolean {
  return status === 'running';
}

export function formatSubagentTaskAge(task: MicaUiSubagentTaskItem, nowMs: number): string {
  const started = Date.parse(task.startedAt);
  if (Number.isNaN(started)) return 'unknown';
  const finished = task.finishedAt ? Date.parse(task.finishedAt) : nowMs;
  return formatElapsed(Math.max(0, (Number.isNaN(finished) ? nowMs : finished) - started));
}

export function shortSubagentTaskId(id: string): string {
  const trimmed = id.trim();
  return trimmed.length <= 8 ? trimmed : `…${trimmed.slice(-6)}`;
}

function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ') || '(untitled task)';
}

function subagentStatusColor(status: MicaUiSubagentTaskStatus): string {
  if (status === 'running') return themeColors.info;
  if (status === 'completed') return themeColors.success;
  return themeColors.error;
}

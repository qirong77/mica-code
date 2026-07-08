import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { basename } from 'node:path';
import { themeColors } from '../theme.js';
import { OneLineItem } from '../primitives/OneLineItem.js';
import { formatElapsed } from '../utils/format.js';
import type { MicaUiBackgroundTaskItem, MicaUiBackgroundTaskStatus } from '../types.js';

export function BackgroundTaskRow({
  task,
  selected,
  compact,
  nowMs = Date.now(),
}: {
  task: MicaUiBackgroundTaskItem;
  selected?: boolean;
  compact?: boolean;
  nowMs?: number;
}): React.ReactNode {
  const active = isActiveBackgroundTaskStatus(task.status);
  const title = formatTaskTitle(task.command);

  if (compact) {
    return (
      <Box paddingTop={1} width="100%" minWidth={0}>
        <OneLineItem
          cells={[
            { key: 'marker', content: '$', flexShrink: 0, color: themeColors.toolShell },
            { key: 'status', content: formatTaskStatus(task.status), flexShrink: 0, color: statusColor(task.status) },
            { key: 'runtime', content: active ? <Text dimColor>{formatTaskAge(task, nowMs)}</Text> : undefined },
            { key: 'id', content: task.id, flexShrink: 0, color: themeColors.accent },
            {
              key: 'title',
              content: title,
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
        { key: 'type', content: '$', width: 2, color: themeColors.toolShell },
        { key: 'status', content: formatTaskStatus(task.status), width: 12, color: statusColor(task.status) },
        {
          key: 'title',
          content: title,
          flexGrow: 1,
          minWidth: 18,
          color: selected ? themeColors.accent : undefined,
          bold: selected,
        },
        { key: 'workspace', content: basename(task.cwd) || task.cwd, width: 18, dimColor: !selected },
        { key: 'age', content: formatTaskAge(task, nowMs), width: 10, dimColor: !selected },
        { key: 'output', content: formatOutputSize(task.outputSize), width: 9, dimColor: !selected },
        { key: 'id', content: task.id, width: 12, color: selected ? themeColors.accent : undefined, dimColor: !selected },
      ]}
    />
  );
}

export function isActiveBackgroundTaskStatus(status: MicaUiBackgroundTaskStatus): boolean {
  return status === 'starting' || status === 'running';
}

export function formatTaskAge(task: MicaUiBackgroundTaskItem, nowMs: number): string {
  const started = Date.parse(task.startedAt);
  if (Number.isNaN(started)) return 'unknown';
  const finished = !isActiveBackgroundTaskStatus(task.status) && task.finishedAt ? Date.parse(task.finishedAt) : nowMs;
  return formatElapsed(Math.max(0, (Number.isNaN(finished) ? nowMs : finished) - started));
}

export function formatTaskStatus(status: MicaUiBackgroundTaskStatus): string {
  return status === 'unknown_exited' ? 'unknown' : status;
}

export function statusColor(status: MicaUiBackgroundTaskStatus): string | undefined {
  if (status === 'running' || status === 'starting') return themeColors.info;
  if (status === 'finished') return themeColors.success;
  if (status === 'killed' || status === 'failed') return themeColors.error;
  return themeColors.warning;
}

export function formatOutputSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded}${units[unit]}`;
}

export function formatTaskTitle(command: string): string {
  const trimmed = command.trim();
  const demoLabel = trimmed.match(/\[(mica-demo-task-[^\]]+)\]/)?.[1];
  if (demoLabel) return demoLabel;
  return trimmed.replace(/\s+/g, ' ');
}

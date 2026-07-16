import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { OneLineItem } from '../primitives/OneLineItem.js';
import { themeColors } from '../theme.js';
import type { MicaUiSubagentTaskActivity, MicaUiSubagentTaskItem, MicaUiSubagentTaskStatus } from '../types.js';
import { formatElapsed } from '../utils/format.js';
import { COMPACT_TASK_KIND_WIDTH, COMPACT_TASK_STATUS_WIDTH, SUBAGENT_TASK_KIND } from './taskRowFormat.js';

const ACTIVITY_INDENT = '     ⎿  ';

export function SubagentTaskRow({
  task,
  depth = 0,
  childrenByParent,
  nowMs = Date.now(),
}: {
  task: MicaUiSubagentTaskItem;
  depth?: number;
  childrenByParent: Map<string, MicaUiSubagentTaskItem[]>;
  nowMs?: number;
}): React.ReactNode {
  const activities = (task.activities ?? []).filter((activity) => activity.toolName !== 'Agent');
  const childTasks = childrenByParent.get(task.id) ?? [];
  return (
    <Box flexDirection="column" width="100%" minWidth={0} paddingTop={depth === 0 ? 1 : 0}>
      <Box paddingLeft={depth * 2} width="100%" minWidth={0}>
        {depth === 0 ? (
          <SubagentTaskMainRow task={task} nowMs={nowMs} />
        ) : (
          <SubagentTaskNestedRow task={task} nowMs={nowMs} />
        )}
      </Box>
      {activities.map((activity) => (
        <SubagentActivityRow key={activity.id} activity={activity} depth={depth} />
      ))}
      {childTasks.map((child) => (
        <SubagentTaskRow
          key={child.id}
          task={child}
          depth={depth + 1}
          childrenByParent={childrenByParent}
          nowMs={nowMs}
        />
      ))}
    </Box>
  );
}

function SubagentTaskMainRow({ task, nowMs }: { task: MicaUiSubagentTaskItem; nowMs: number }): React.ReactNode {
  return (
    <OneLineItem
      cells={[
        { key: 'kind', content: SUBAGENT_TASK_KIND, width: COMPACT_TASK_KIND_WIDTH, flexShrink: 0 },
        {
          key: 'status',
          content: task.status,
          width: COMPACT_TASK_STATUS_WIDTH,
          flexShrink: 0,
          color: subagentStatusColor(task.status),
        },
        { key: 'runtime', content: <Text dimColor>{formatSubagentTaskAge(task, nowMs)}</Text>, flexShrink: 0 },
        { key: 'type', content: task.subagentType, flexShrink: 0, color: themeColors.accent },
        {
          key: 'description',
          content: normalizeDescription(task.description),
          flexGrow: 1,
          minWidth: 0,
          color: themeColors.text,
        },
      ]}
    />
  );
}

function SubagentTaskNestedRow({ task, nowMs }: { task: MicaUiSubagentTaskItem; nowMs: number }): React.ReactNode {
  return (
    <OneLineItem
      cells={[
        {
          key: 'prefix',
          content: <Text dimColor>{ACTIVITY_INDENT}</Text>,
          flexShrink: 0,
        },
        { key: 'kind', content: SUBAGENT_TASK_KIND, flexShrink: 0 },
        {
          key: 'status',
          content: task.status,
          width: COMPACT_TASK_STATUS_WIDTH,
          flexShrink: 0,
          color: subagentStatusColor(task.status),
        },
        { key: 'runtime', content: <Text dimColor>{formatSubagentTaskAge(task, nowMs)}</Text>, flexShrink: 0 },
        { key: 'type', content: task.subagentType, flexShrink: 0, color: themeColors.accent },
        {
          key: 'description',
          content: normalizeDescription(task.description),
          flexGrow: 1,
          minWidth: 0,
          color: themeColors.text,
        },
      ]}
    />
  );
}

function SubagentActivityRow({
  activity,
  depth,
}: {
  activity: MicaUiSubagentTaskActivity;
  depth: number;
}): React.ReactNode {
  return (
    <Box paddingLeft={depth * 2} width="100%" minWidth={0}>
      <OneLineItem
        cells={[
          {
            key: 'prefix',
            content: <Text dimColor>{ACTIVITY_INDENT}</Text>,
            flexShrink: 0,
          },
          {
            key: 'summary',
            content: normalizeDescription(activity.summary),
            flexGrow: 1,
            minWidth: 0,
            dimColor: true,
          },
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

export function buildSubagentTaskForest(tasks: MicaUiSubagentTaskItem[]): {
  roots: MicaUiSubagentTaskItem[];
  childrenByParent: Map<string, MicaUiSubagentTaskItem[]>;
} {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParent = new Map<string, MicaUiSubagentTaskItem[]>();
  const roots: MicaUiSubagentTaskItem[] = [];

  for (const task of tasks) {
    const parentId = task.parentTaskId;
    if (parentId && byId.has(parentId) && parentId !== task.id) {
      const list = childrenByParent.get(parentId) ?? [];
      list.push(task);
      childrenByParent.set(parentId, list);
      continue;
    }
    roots.push(task);
  }

  const sortByStarted = (a: MicaUiSubagentTaskItem, b: MicaUiSubagentTaskItem) =>
    Date.parse(a.startedAt) - Date.parse(b.startedAt);
  roots.sort(sortByStarted);
  for (const children of childrenByParent.values()) children.sort(sortByStarted);

  return { roots, childrenByParent };
}

function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ') || '(untitled task)';
}

function subagentStatusColor(status: MicaUiSubagentTaskStatus): string {
  if (status === 'running') return themeColors.info;
  if (status === 'completed') return themeColors.success;
  return themeColors.error;
}

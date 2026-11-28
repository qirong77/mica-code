/**
 * app-server 快照与详情响应里的任务投影。
 *
 * 这些是纯函数：把内部任务记录收窄成桌面端消费的形状，不读盘、不排队、不发通知。
 * 放在这里是为了让 runAppServer 只保留协议分派与 turn 编排。
 */
import type {
  MicaBackgroundTaskItem,
  MicaSubagentTaskDetail,
  MicaSubagentTaskItem,
  MicaWaitTaskItem,
} from '@packages/mica-runtime/index.js';
import type { BackgroundTaskMeta, WaitRecord } from '@packages/mica-tools/index.js';
import { keepsBackgroundTaskRow } from '@packages/mica-common/backgroundTaskVisibility.js';
import { keepsSubagentTaskRow } from '@packages/mica-common/subagentVisibility.js';
import type { SubagentTaskRecord } from '../agents/SubagentTaskManager.js';

/** Project one background shell task for snapshots and output requests. */
export function projectBackgroundTask(task: BackgroundTaskMeta): MicaBackgroundTaskItem {
  return {
    id: task.id,
    command: task.command,
    cwd: task.cwd,
    shell: task.shell,
    status: task.status,
    startedAt: task.started_at,
    ...(task.finished_at ? { finishedAt: task.finished_at } : {}),
    ...(task.exit_code !== undefined && task.exit_code !== null ? { exitCode: task.exit_code } : {}),
    ...(task.signal ? { signal: task.signal } : {}),
  };
}

/** Project only active tasks for the status dock. */
export function projectBackgroundTasks(tasks: BackgroundTaskMeta[]): MicaBackgroundTaskItem[] {
  return tasks
    .filter((task) => keepsBackgroundTaskRow({ status: task.status, exitCode: task.exit_code }))
    .map((task) => projectBackgroundTask(task));
}

export function isOwnedBackgroundTask(task: BackgroundTaskMeta, ownerId: string): boolean {
  return Boolean(ownerId) && task.agent_owner_id === ownerId;
}

/** Project only the subagents that are still running. Finished ones keep their
 * record on disk (detail / restart stay answerable) but never take a dock row. */
export function projectSubagentTasks(tasks: SubagentTaskRecord[]): MicaSubagentTaskItem[] {
  return tasks
    .filter((task) => task.activity !== 'maintenance' && keepsSubagentTaskRow(task))
    .map((task) => ({
      taskId: task.id,
      ...(task.parent_task_id ? { parentTaskId: task.parent_task_id } : {}),
      subagentType: task.subagent_type,
      description: task.description,
      status: task.status,
      startedAt: task.started_at,
      ...(task.finished_at ? { finishedAt: task.finished_at } : {}),
      ...(task.interrupted ? { interrupted: true } : {}),
      activities: (task.activities ?? []).map((activity) => ({
        id: activity.id,
        summary: activity.summary,
        ...(activity.toolName ? { toolName: activity.toolName } : {}),
        startedAt: activity.startedAt,
      })),
    }));
}

/** Project the `wait_for` records that are still waiting for the
 * `mica/waitTasks/updated` snapshot. The records live in mica-tools inside this
 * process, so the host is the only place that can see them; a long wait would
 * otherwise look like a frozen tool row in the desktop app. */
export function projectWaitTasks(waits: WaitRecord[]): MicaWaitTaskItem[] {
  return waits.map((wait) => ({
    id: wait.id,
    kind: wait.kind,
    label: wait.label,
    ...(wait.reason ? { reason: wait.reason } : {}),
    status: 'waiting',
    startedAt: new Date(wait.createdAt).toISOString(),
    polls: wait.polls,
    ...(wait.error ? { detail: wait.error } : wait.detail ? { detail: wait.detail } : {}),
  }));
}

/** Cap the projected result so the on-demand detail response stays small. The
 * record itself keeps up to 200k (in memory), but the desktop modal never needs
 * a whole result inline. Keeps the head, mirroring the transcript clamp. */
const SUBAGENT_DETAIL_RESULT_MAX_CHARS = 40_000;

function clampDetailResult(result: string): string {
  if (result.length <= SUBAGENT_DETAIL_RESULT_MAX_CHARS) return result;
  return `${result.slice(0, SUBAGENT_DETAIL_RESULT_MAX_CHARS)}\n…[truncated]`;
}

/**
 * Project one subagent task (including finished ones) for the desktop's
 * on-demand detail modal. The periodic `mica/subagentTasks/updated` snapshot
 * stays lean; this carries the prompt, streamed timeline, result and usage.
 */
export function projectSubagentTaskDetail(record: SubagentTaskRecord): MicaSubagentTaskDetail {
  return {
    taskId: record.id,
    ...(record.parent_task_id ? { parentTaskId: record.parent_task_id } : {}),
    subagentType: record.subagent_type,
    description: record.description,
    status: record.status,
    startedAt: record.started_at,
    ...(record.finished_at ? { finishedAt: record.finished_at } : {}),
    model: record.model,
    effort: record.effort,
    ...(record.max_turns === undefined ? {} : { maxTurns: record.max_turns }),
    ...(record.context_mode === undefined ? {} : { contextMode: record.context_mode }),
    ...(record.write_mode === undefined ? {} : { writeMode: record.write_mode }),
    ...(record.owned_paths ? { ownedPaths: [...record.owned_paths] } : {}),
    ...(record.context_files ? { contextFiles: [...record.context_files] } : {}),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
    ...(record.result === undefined ? {} : { result: clampDetailResult(record.result) }),
    ...(record.error === undefined ? {} : { error: record.error }),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.timeline ? { timeline: record.timeline.map((entry) => ({ ...entry })) } : {}),
    ...(record.timeline_truncated ? { timelineTruncated: true } : {}),
  };
}

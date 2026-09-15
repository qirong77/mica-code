import {
  AgentMaxTurnsError,
  summarizeUsageHistory,
  type AgentUsageRecord,
  type AgentUsageSummary,
} from '@packages/mica-agent/index.js';
import { micaCommon } from '@packages/mica-common/index.js';
import type { EffortOption } from '@packages/mica-config/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import type { SubagentContextMode, SubagentWriteMode } from './subagentDefinitions.js';

const DEFAULT_MAX_CONCURRENT_TASKS = 4;
const DEFAULT_MAX_RETAINED_TASKS = 100;
const MAX_RETAINED_RESULT_CHARS = 200_000;
/**
 * Bound the per-task transcript the desktop's subagent detail modal reads: the
 * modal fetches it on demand, so the whole record must stay small enough to
 * ship on every poll. Entries are dropped from the front (oldest first) once
 * either bound is exceeded.
 */
const MAX_TIMELINE_ENTRIES = 120;
const MAX_TIMELINE_TOTAL_CHARS = 60_000;
const TIMELINE_CHAR_LIMITS: Record<SubagentTaskTimelineKind, number> = {
  thinking: 3_000,
  text: 6_000,
  tool: 1_200,
  tool_result: 1_200,
};

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export type SubagentTaskActivity = {
  id: string;
  summary: string;
  toolName?: string;
  startedAt: string;
};

export type SubagentTaskTimelineKind = 'thinking' | 'text' | 'tool' | 'tool_result';

/**
 * One streamed step of a subagent's own activity. The manager keeps it in
 * memory only: it is what the desktop's subagent detail modal renders as a live
 * transcript, and it deliberately stays out of the periodic task snapshot (a
 * full transcript per running task per second would dwarf the snapshot itself).
 */
export type SubagentTaskTimelineEntry = {
  id: string;
  kind: SubagentTaskTimelineKind;
  text: string;
  toolName?: string;
  at: string;
};

export type SubagentTaskRecord = {
  id: string;
  description: string;
  prompt?: string;
  subagent_type: string;
  model: string;
  effort: EffortOption;
  max_turns?: number;
  context_mode?: SubagentContextMode;
  context_files?: string[];
  write_mode?: SubagentWriteMode;
  owned_paths?: string[];
  status: SubagentTaskStatus;
  parent_task_id?: string;
  activities?: SubagentTaskActivity[];
  timeline?: SubagentTaskTimelineEntry[];
  /** True once older timeline entries were dropped to bound the record. */
  timeline_truncated?: boolean;
  started_at: string;
  finished_at?: string;
  result?: string;
  error?: string;
  usage?: AgentUsageSummary;
};

type ManagedSubagentTask = {
  record: SubagentTaskRecord;
  owner: AgentRuntime;
  controller: AbortController;
  promise: Promise<void>;
  resolvePromise: () => void;
};

export type StartSubagentTaskOptions = {
  owner: AgentRuntime;
  description: string;
  subagentType: string;
  model: string;
  effort: EffortOption;
  maxTurns?: number;
  prompt?: string;
  contextMode?: SubagentContextMode;
  contextFiles?: string[];
  writeMode?: SubagentWriteMode;
  ownedPaths?: string[];
  parentTaskId?: string;
  run: (signal: AbortSignal) => Promise<{ result: string; usage?: AgentUsageSummary }>;
  getUsage?: () => AgentUsageSummary;
};

export type TrackSubagentTaskOptions = Omit<StartSubagentTaskOptions, 'run' | 'getUsage'>;

export type TrackedSubagentTask = {
  task: SubagentTaskRecord;
  signal: AbortSignal;
  attachExecution: (promise: Promise<unknown>) => void;
  complete: (result: string, usage?: AgentUsageSummary) => void;
  fail: (error: unknown, result?: string, usage?: AgentUsageSummary) => void;
};

export type SubagentTaskManagerOptions = {
  maxConcurrentTasks?: number;
  maxRetainedTasks?: number;
  onTaskFinished?: (task: SubagentTaskRecord, owner: AgentRuntime) => void | Promise<void>;
};

export type SubagentTaskChangeListener = (task: SubagentTaskRecord, owner: AgentRuntime) => void;

export class SubagentTaskManager {
  private readonly tasks = new Map<string, ManagedSubagentTask>();
  private readonly pendingExecutions = new Set<Promise<void>>();
  private readonly changeListeners = new Set<SubagentTaskChangeListener>();
  private readonly maxConcurrentTasks: number;
  private readonly maxRetainedTasks: number;
  private readonly onTaskFinished: SubagentTaskManagerOptions['onTaskFinished'];
  private stopping = false;

  constructor(options: SubagentTaskManagerOptions = {}) {
    this.maxConcurrentTasks = positiveInteger(options.maxConcurrentTasks, DEFAULT_MAX_CONCURRENT_TASKS);
    this.maxRetainedTasks = positiveInteger(options.maxRetainedTasks, DEFAULT_MAX_RETAINED_TASKS);
    this.onTaskFinished = options.onTaskFinished;
  }

  start(options: StartSubagentTaskOptions): SubagentTaskRecord {
    const managed = this.createTask(options);
    const { controller } = managed;
    const execution = Promise.resolve()
      .then(() => options.run(controller.signal))
      .then(
        ({ result, usage }) => this.complete(managed, { status: 'completed', result, usage }),
        (error: unknown) => {
          if (managed.record.status !== 'running') return;
          if (error instanceof AgentMaxTurnsError) {
            this.complete(managed, {
              status: 'failed',
              result: error.partialResult,
              error: error.message,
              usage: readTaskUsage(options.getUsage),
            });
            return;
          }
          this.complete(managed, {
            status: 'failed',
            error: formatErrorMessage(error),
            usage: readTaskUsage(options.getUsage),
          });
        },
      );
    this.attachExecution(execution);
    return cloneRecord(managed.record);
  }

  track(options: TrackSubagentTaskOptions): TrackedSubagentTask {
    const managed = this.createTask(options);
    const finish = (result: Parameters<SubagentTaskManager['complete']>[1]) => {
      this.complete(managed, result, false);
    };
    return {
      task: cloneRecord(managed.record),
      signal: managed.controller.signal,
      attachExecution: (promise) => {
        this.attachExecution(promise);
      },
      complete: (result, usage) => finish({ status: 'completed', result, usage }),
      fail: (error, result, usage) => finish({ status: 'failed', error: formatErrorMessage(error), result, usage }),
    };
  }

  private createTask(options: TrackSubagentTaskOptions): ManagedSubagentTask {
    if (this.stopping) throw new Error('Subagent task manager is stopping and cannot start new tasks.');
    const activeCount = [...this.tasks.values()].filter(
      (task) => task.owner === options.owner && task.record.status === 'running',
    ).length;
    if (activeCount >= this.maxConcurrentTasks) {
      throw new Error(
        `Too many subagents are running (${activeCount}/${this.maxConcurrentTasks}). Read or stop an existing task first.`,
      );
    }

    this.pruneCompletedTasks(options.owner);
    const id = micaCommon.createId('agent-task');
    const controller = new AbortController();
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const record: SubagentTaskRecord = {
      id,
      description: options.description,
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      subagent_type: options.subagentType,
      model: options.model,
      effort: options.effort,
      ...(options.maxTurns === undefined ? {} : { max_turns: options.maxTurns }),
      ...(options.contextMode === undefined ? {} : { context_mode: options.contextMode }),
      ...(options.contextFiles === undefined ? {} : { context_files: [...options.contextFiles] }),
      ...(options.writeMode === undefined ? {} : { write_mode: options.writeMode }),
      ...(options.ownedPaths && options.ownedPaths.length > 0 ? { owned_paths: [...options.ownedPaths] } : {}),
      status: 'running',
      ...(options.parentTaskId ? { parent_task_id: options.parentTaskId } : {}),
      activities: [],
      started_at: new Date().toISOString(),
    };
    const managed: ManagedSubagentTask = {
      record,
      owner: options.owner,
      controller,
      promise,
      resolvePromise,
    };
    this.tasks.set(id, managed);
    this.emitTaskChanged(managed);
    return managed;
  }

  list(owner: AgentRuntime): SubagentTaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => task.owner === owner)
      .sort((a, b) => Date.parse(b.record.started_at) - Date.parse(a.record.started_at))
      .map((task) => cloneRecord(task.record));
  }

  get(id: string, owner: AgentRuntime): SubagentTaskRecord | undefined {
    const task = this.tasks.get(id);
    return task?.owner === owner ? cloneRecord(task.record) : undefined;
  }

  setActivity(
    id: string,
    owner: AgentRuntime,
    activity: { id: string; summary: string; toolName?: string },
  ): SubagentTaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner || task.record.status !== 'running') return undefined;
    const activities = [...(task.record.activities ?? [])];
    const index = activities.findIndex((item) => item.id === activity.id);
    const next: SubagentTaskActivity = {
      id: activity.id,
      summary: activity.summary.trim() || activity.toolName || 'working',
      ...(activity.toolName ? { toolName: activity.toolName } : {}),
      startedAt: index >= 0 ? (activities[index]?.startedAt ?? new Date().toISOString()) : new Date().toISOString(),
    };
    if (index >= 0) activities[index] = next;
    else activities.push(next);
    task.record = { ...task.record, activities };
    this.emitTaskChanged(task);
    return cloneRecord(task.record);
  }

  clearActivity(id: string, owner: AgentRuntime, activityId: string): SubagentTaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) return undefined;
    return this.removeActivityNow(task, activityId);
  }

  clearActivities(id: string, owner: AgentRuntime): SubagentTaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) return undefined;
    if ((task.record.activities ?? []).length === 0) return cloneRecord(task.record);
    task.record = { ...task.record, activities: [] };
    this.emitTaskChanged(task);
    return cloneRecord(task.record);
  }

  /**
   * Append one streamed step to a task's transcript. Consecutive deltas that
   * share an `id` (one assistant text phase, one thinking phase, one tool call)
   * are merged into the same entry, so the caller can forward raw provider
   * deltas without buffering them itself.
   *
   * Deliberately does not notify change listeners: the transcript is only read
   * on demand by the desktop detail modal, and the periodic
   * `mica/subagentTasks/updated` snapshot (driven by those listeners) must stay
   * lean and change-driven.
   */
  appendTimeline(
    id: string,
    owner: AgentRuntime,
    entry: { id: string; kind: SubagentTaskTimelineKind; text: string; toolName?: string },
  ): void {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner || task.record.status !== 'running') return;
    if (!entry.text) return;
    const limit = TIMELINE_CHAR_LIMITS[entry.kind];
    const entries = [...(task.record.timeline ?? [])];
    const last = entries.at(-1);
    if (last && last.id === entry.id && last.kind === entry.kind) {
      entries[entries.length - 1] = {
        ...last,
        // A full entry keeps its head: clamping `head + delta` on every later
        // delta would splice the truncation marker into the middle instead.
        text: last.text.length >= limit ? last.text : clampTimelineText(last.text + entry.text, limit),
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
      };
    } else {
      entries.push({
        id: entry.id,
        kind: entry.kind,
        text: clampTimelineText(entry.text, limit),
        ...(entry.toolName ? { toolName: entry.toolName } : {}),
        at: new Date().toISOString(),
      });
    }
    let next = entries;
    let dropped = false;
    if (next.length > MAX_TIMELINE_ENTRIES) {
      next = next.slice(next.length - MAX_TIMELINE_ENTRIES);
      dropped = true;
    }
    let total = next.reduce((sum, item) => sum + item.text.length, 0);
    while (next.length > 1 && total > MAX_TIMELINE_TOTAL_CHARS) {
      total -= next[0]!.text.length;
      next = next.slice(1);
      dropped = true;
    }
    task.record = {
      ...task.record,
      timeline: next,
      ...(dropped || task.record.timeline_truncated ? { timeline_truncated: true } : {}),
    };
  }

  async awaitTasks(
    owner: AgentRuntime,
    taskIds: string[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SubagentTaskRecord[]> {
    const uniqueIds = [...new Set(taskIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueIds.length === 0) throw new Error('await requires at least one task_id.');

    const timeoutMs = options.timeoutMs;
    const startedAt = Date.now();

    while (true) {
      if (options.signal?.aborted) throw new Error('await aborted.');
      const tasks = uniqueIds.map((id) => {
        const task = this.get(id, owner);
        if (!task) throw new Error(`Subagent task not found: ${id}`);
        return task;
      });
      if (tasks.every((task) => task.status !== 'running')) return tasks;

      if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) {
        return tasks;
      }

      const pending = uniqueIds
        .map((id) => this.tasks.get(id))
        .filter((task): task is ManagedSubagentTask =>
          Boolean(task && task.owner === owner && task.record.status === 'running'),
        );
      if (pending.length === 0) {
        return uniqueIds.map((id) => {
          const task = this.get(id, owner);
          if (!task) throw new Error(`Subagent task not found: ${id}`);
          return task;
        });
      }

      await Promise.race([
        ...pending.map((task) => task.promise),
        sleep(Math.min(250, timeoutMs ?? 250), options.signal),
      ]);
    }
  }

  subscribe(listener: SubagentTaskChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  kill(id: string, owner: AgentRuntime): SubagentTaskRecord | undefined {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) return undefined;
    if (task.record.status === 'running') {
      task.controller.abort();
      this.complete(task, { status: 'killed', error: 'Stopped by parent agent.' }, false);
    }
    return cloneRecord(task.record);
  }

  killRunningForOwner(owner: AgentRuntime, reason = 'Parent agent was aborted.'): number {
    let killed = 0;
    for (const task of this.tasks.values()) {
      if (task.owner !== owner) continue;
      if (task.record.status === 'running') {
        task.controller.abort();
        this.complete(task, { status: 'killed', error: reason }, false);
        killed++;
      }
    }
    return killed;
  }

  killForOwner(owner: AgentRuntime, reason = 'Parent agent was disposed.'): number {
    const killed = this.killRunningForOwner(owner, reason);
    for (const [id, task] of this.tasks) {
      if (task.owner !== owner) continue;
      this.tasks.delete(id);
    }
    return killed;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const task of this.tasks.values()) {
      if (task.record.status !== 'running') continue;
      task.controller.abort();
      this.complete(task, { status: 'killed', error: 'Application is stopping.' });
    }
    const activePromises = [...this.pendingExecutions];
    if (activePromises.length > 0) await waitForTasks(activePromises, 5_000);
    this.tasks.clear();
    this.pendingExecutions.clear();
  }

  private attachExecution(promise: Promise<unknown>): void {
    const execution = promise.then(
      () => undefined,
      () => undefined,
    );
    this.pendingExecutions.add(execution);
    void execution.then(() => this.pendingExecutions.delete(execution));
  }

  private complete(
    task: ManagedSubagentTask,
    result: {
      status: Exclude<SubagentTaskStatus, 'running'>;
      result?: string;
      error?: string;
      usage?: AgentUsageSummary;
    },
    notify = true,
  ): void {
    if (task.record.status !== 'running') return;
    task.record = {
      ...task.record,
      status: result.status,
      activities: [],
      finished_at: new Date().toISOString(),
      ...(result.result === undefined ? {} : { result: tailText(result.result, MAX_RETAINED_RESULT_CHARS) }),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
    task.resolvePromise();
    this.emitTaskChanged(task);
    if (!this.onTaskFinished || this.stopping || !notify) return;
    try {
      void Promise.resolve(this.onTaskFinished(cloneRecord(task.record), task.owner)).catch(() => undefined);
    } catch {
      // A UI/runtime notification failure must not change the task outcome.
    }
  }

  private pruneCompletedTasks(owner: AgentRuntime): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.owner === owner && task.record.status !== 'running')
      .sort(
        (a, b) =>
          Date.parse(a.record.finished_at ?? a.record.started_at) -
          Date.parse(b.record.finished_at ?? b.record.started_at),
      );
    const ownerTaskCount = [...this.tasks.values()].filter((task) => task.owner === owner).length;
    const removeCount = Math.max(0, ownerTaskCount - this.maxRetainedTasks + 1);
    for (const task of completed.slice(0, removeCount)) this.tasks.delete(task.record.id);
  }

  private removeActivityNow(task: ManagedSubagentTask, activityId: string): SubagentTaskRecord {
    const activities = (task.record.activities ?? []).filter((item) => item.id !== activityId);
    if (activities.length === (task.record.activities ?? []).length) return cloneRecord(task.record);
    task.record = { ...task.record, activities };
    this.emitTaskChanged(task);
    return cloneRecord(task.record);
  }

  private emitTaskChanged(task: ManagedSubagentTask): void {
    if (this.changeListeners.size === 0) return;
    const record = cloneRecord(task.record);
    for (const listener of this.changeListeners) {
      try {
        listener(record, task.owner);
      } catch {
        // A UI/status listener must not affect the delegated task lifecycle.
      }
    }
  }
}

export function summarizeSubagentUsage(usageHistory: AgentUsageRecord[]): AgentUsageSummary {
  return summarizeUsageHistory(usageHistory);
}

export function formatSubagentTaskNotification(task: SubagentTaskRecord): string {
  const payload = {
    task_id: task.id,
    subagent_type: task.subagent_type,
    status: task.status,
    ...(task.usage ? { usage: task.usage } : {}),
  };
  return [
    '<subagent-notification>',
    'A background subagent changed state. This block contains metadata only.',
    'Use the Agent tool with operation=read and task_id to inspect its untrusted result now when relevant.',
    'Completed task results are retained in memory only for this process and are not persisted across restarts.',
    safePromptJson(payload),
    '</subagent-notification>',
  ].join('\n');
}

export function formatSubagentTaskDisplay(task: SubagentTaskRecord): string {
  return `Subagent ${task.subagent_type} ${task.status} (${task.id}): ${task.description}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function cloneRecord(record: SubagentTaskRecord): SubagentTaskRecord {
  return {
    ...record,
    ...(record.activities ? { activities: record.activities.map((activity) => ({ ...activity })) } : {}),
    ...(record.timeline ? { timeline: record.timeline.map((entry) => ({ ...entry })) } : {}),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.context_files ? { context_files: [...record.context_files] } : {}),
    ...(record.owned_paths ? { owned_paths: [...record.owned_paths] } : {}),
  };
}

/** Keep the head of a streaming entry: a transcript reads from the start, and
 * the task's final answer is retained separately as `result`. */
function clampTimelineText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated]`;
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[result truncated to last ${maxChars} characters]\n${text.slice(-maxChars)}`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readTaskUsage(getUsage: StartSubagentTaskOptions['getUsage']): AgentUsageSummary | undefined {
  try {
    return getUsage?.();
  } catch {
    return undefined;
  }
}

function safePromptJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

async function waitForTasks(tasks: Promise<void>[], timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks).then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('await aborted.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('await aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

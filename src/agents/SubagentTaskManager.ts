import {
  AgentMaxTurnsError,
  summarizeUsageHistory,
  type AgentUsageRecord,
  type AgentUsageSummary,
} from '@packages/mica-agent/index.js';
import { micaCommon } from '@packages/mica-common/index.js';
import type { EffortOption } from '@packages/mica-config/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';

const DEFAULT_MAX_CONCURRENT_TASKS = 4;
const DEFAULT_MAX_RETAINED_TASKS = 100;
const MAX_RETAINED_RESULT_CHARS = 200_000;

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export type SubagentTaskRecord = {
  id: string;
  description: string;
  subagent_type: string;
  model: string;
  effort: EffortOption;
  max_turns?: number;
  status: SubagentTaskStatus;
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
};

export type StartSubagentTaskOptions = {
  owner: AgentRuntime;
  description: string;
  subagentType: string;
  model: string;
  effort: EffortOption;
  maxTurns?: number;
  run: (signal: AbortSignal) => Promise<{ result: string; usage?: AgentUsageSummary }>;
  getUsage?: () => AgentUsageSummary;
};

export type TrackSubagentTaskOptions = Omit<StartSubagentTaskOptions, 'run' | 'getUsage'>;

export type TrackedSubagentTask = {
  task: SubagentTaskRecord;
  signal: AbortSignal;
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
    managed.promise = Promise.resolve()
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
    return cloneRecord(managed.record);
  }

  track(options: TrackSubagentTaskOptions): TrackedSubagentTask {
    const managed = this.createTask(options);
    const finish = (result: Parameters<SubagentTaskManager['complete']>[1]) => {
      this.complete(managed, result, false);
      this.tasks.delete(managed.record.id);
    };
    return {
      task: cloneRecord(managed.record),
      signal: managed.controller.signal,
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
        `Too many background subagents are running (${activeCount}/${this.maxConcurrentTasks}). Read or stop an existing task first.`,
      );
    }

    this.pruneCompletedTasks(options.owner);
    const id = micaCommon.createId('agent-task');
    const controller = new AbortController();
    const record: SubagentTaskRecord = {
      id,
      description: options.description,
      subagent_type: options.subagentType,
      model: options.model,
      effort: options.effort,
      ...(options.maxTurns === undefined ? {} : { max_turns: options.maxTurns }),
      status: 'running',
      started_at: new Date().toISOString(),
    };
    const managed: ManagedSubagentTask = {
      record,
      owner: options.owner,
      controller,
      promise: Promise.resolve(),
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

  killForOwner(owner: AgentRuntime): number {
    let killed = 0;
    for (const [id, task] of this.tasks) {
      if (task.owner !== owner) continue;
      if (task.record.status === 'running') {
        task.controller.abort();
        this.complete(task, { status: 'killed', error: 'Parent agent was disposed.' }, false);
        killed++;
      }
      this.tasks.delete(id);
    }
    return killed;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const activePromises: Promise<void>[] = [];
    for (const task of this.tasks.values()) {
      if (task.record.status !== 'running') continue;
      task.controller.abort();
      this.complete(task, { status: 'killed', error: 'Application is stopping.' });
      activePromises.push(task.promise);
    }
    if (activePromises.length > 0) await waitForTasks(activePromises, 5_000);
    this.tasks.clear();
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
      finished_at: new Date().toISOString(),
      ...(result.result === undefined ? {} : { result: tailText(result.result, MAX_RETAINED_RESULT_CHARS) }),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    };
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
  return { ...record, ...(record.usage ? { usage: { ...record.usage } } : {}) };
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

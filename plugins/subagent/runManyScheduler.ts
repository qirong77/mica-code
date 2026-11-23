import type { PluginSubagentRunResult } from '@packages/mica-plugin/index.js';
import type { PlannedSubagentRun } from './orchestration.js';

type FinishedStatus = PluginSubagentRunResult['status'];
export type BatchStatus = FinishedStatus | 'running' | 'skipped';

export type BatchResult = {
  task: PlannedSubagentRun;
  status: BatchStatus;
  output: string;
  taskId?: string;
};

/** `done` must settle only after the execution slot and its path lease are released. */
export type BatchHandle = {
  background: boolean;
  taskId?: string;
  output?: string;
  done: Promise<{ status: FinishedStatus; output: string }>;
};

/**
 * Dispatch a validated DAG as slots become available. A background task consumes
 * a slot until it exits, but need not finish before returning if every task has
 * already been dispatched and no foreground task remains.
 */
export async function scheduleSubagentRuns(
  tasks: PlannedSubagentRun[],
  maxParallel: number,
  launch: (task: PlannedSubagentRun) => BatchHandle,
  signal?: AbortSignal,
): Promise<BatchResult[]> {
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const active = new Map<string, { task: PlannedSubagentRun; handle: BatchHandle }>();
  const results = new Map<string, BatchResult>();
  const completions: Array<{ id: string; outcome: { status: FinishedStatus; output: string } }> = [];
  let wake: (() => void) | undefined;
  let returned = false;

  const enqueue = (id: string, outcome: { status: FinishedStatus; output: string }): void => {
    if (returned) return;
    completions.push({ id, outcome });
    wake?.();
  };

  try {
    for (;;) {
      signal?.throwIfAborted();
      while (completions.length > 0) {
        const { id, outcome } = completions.shift()!;
        const entry = active.get(id);
        if (!entry) continue;
        active.delete(id);
        results.set(id, {
          task: entry.task,
          status: outcome.status,
          output: outcome.output,
          ...(entry.handle.taskId ? { taskId: entry.handle.taskId } : {}),
        });
      }

      let progressed = false;
      for (const task of pending.values()) {
        const blocked = task.depends_on.filter((id) => {
          const status = results.get(id)?.status;
          return status !== undefined && status !== 'running' && status !== 'completed';
        });
        if (blocked.length > 0) {
          pending.delete(task.id);
          results.set(task.id, {
            task,
            status: 'skipped',
            output: `Status: skipped\nDependencies did not complete successfully: ${blocked.join(', ')}`,
          });
          progressed = true;
          continue;
        }
        if (active.size >= maxParallel || !task.depends_on.every((id) => results.get(id)?.status === 'completed')) {
          continue;
        }
        signal?.throwIfAborted();
        pending.delete(task.id);
        progressed = true;
        try {
          const handle = launch(task);
          active.set(task.id, { task, handle });
          if (handle.background) {
            results.set(task.id, {
              task,
              status: 'running',
              output: handle.output ?? '',
              ...(handle.taskId ? { taskId: handle.taskId } : {}),
            });
          }
          // Attach exactly once per execution, rather than accumulating a new
          // Promise.race handler on every long-running task at each completion.
          void handle.done.then(
            (outcome) => enqueue(task.id, outcome),
            (error: unknown) =>
              enqueue(task.id, {
                status: 'failed',
                output: `Status: failed\n\nThe subagent could not be started: ${formatError(error)}`,
              }),
          );
        } catch (error) {
          signal?.throwIfAborted();
          results.set(task.id, {
            task,
            status: 'failed',
            output: `Status: failed\n\nThe subagent could not be started: ${formatError(error)}`,
          });
        }
      }

      // A synchronously settled background handle may have queued its
      // completion while the dispatch loop was running. Consume that update
      // before returning a misleading `running` snapshot.
      if (completions.length > 0) continue;
      if (pending.size === 0 && ![...active.values()].some(({ handle }) => !handle.background)) break;
      if (progressed) continue;
      if (active.size === 0) throw new Error('run_many stalled: no runnable tasks without unmet dependencies.');
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          wake = undefined;
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = (): void => {
          cleanup();
          reject(signal?.reason);
        };
        wake = () => {
          cleanup();
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        // Recheck after registration, so a completion or cancellation cannot be
        // lost between deciding to wait and installing the wakeup.
        if (signal?.aborted) onAbort();
        else if (completions.length > 0) wake();
      });
    }
    return tasks.map((task) => results.get(task.id)!);
  } finally {
    returned = true;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

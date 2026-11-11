import { describe, expect, it } from 'vitest';
import { isOwnedBackgroundTask, projectBackgroundTasks } from '../../../apps/cli/src/cli/runAppServer';
import type { BackgroundTaskMeta } from '../ToolRunShellBackground';

function task(
  id: string,
  status: BackgroundTaskMeta['status'],
  options: { finishedAt?: string; exitCode?: number } = {},
): BackgroundTaskMeta {
  return {
    id, status, command: 'echo hello', cwd: '/tmp', shell: '/bin/sh',
    output_path: `/tmp/${id}.out`, started_at: '2026-01-01T00:00:00.000Z',
    output_limit_bytes: 1000, agent_owner_id: 'owner-a',
    ...(options.finishedAt ? { finished_at: options.finishedAt } : {}),
    ...(options.exitCode === undefined ? {} : { exit_code: options.exitCode }),
  };
}

describe('desktop background task projection', () => {
  it('retains active tasks without resurfacing finished failures in the dock', () => {
    const finished = Array.from({ length: 21 }, (_, i) =>
      task(`done-${i}`, 'finished', {
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        exitCode: 2,
      }),
    );
    const result = projectBackgroundTasks([task('starting', 'starting'), task('active', 'running'), ...finished]);
    expect(result.map((item) => item.id).sort()).toEqual(['active', 'starting']);
  });

  it('drops all terminal states while their records remain available for detail requests', () => {
    const result = projectBackgroundTasks([
      task('ok', 'finished', { finishedAt: '2026-01-01T00:00:00.000Z', exitCode: 0 }),
      task('killed', 'killed', { finishedAt: '2026-01-01T00:00:01.000Z' }),
      task('failed', 'failed', { finishedAt: '2026-01-01T00:00:02.000Z' }),
      task('unknown', 'unknown_exited', { finishedAt: '2026-01-01T00:00:03.000Z' }),
    ]);
    expect(result).toEqual([]);
  });

  it('only accepts the matching agent owner, including for detail and kill requests', () => {
    const owned = task('one', 'finished');
    expect(isOwnedBackgroundTask(owned, 'owner-a')).toBe(true);
    expect(isOwnedBackgroundTask(owned, 'owner-b')).toBe(false);
    expect(isOwnedBackgroundTask({ ...owned, agent_owner_id: undefined }, 'owner-a')).toBe(false);
    expect(isOwnedBackgroundTask({ ...owned, agent_owner_id: '' }, '')).toBe(false);
  });
});

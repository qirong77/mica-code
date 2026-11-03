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
  it('retains active tasks and the 20 most recently finished tasks', () => {
    const finished = Array.from({ length: 21 }, (_, i) =>
      // 只有「需要看一眼」的结束才留在状态栏：退出码非零的失败任务。
      task(`done-${i}`, 'finished', {
        finishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        exitCode: 2,
      }),
    );
    const result = projectBackgroundTasks([task('active', 'running'), ...finished]);
    expect(result).toHaveLength(21);
    expect(result.map((item) => item.id)).toContain('active');
    expect(result.map((item) => item.id)).toContain('done-20');
    expect(result.map((item) => item.id)).not.toContain('done-0');
  });

  it('drops endings that were already explained in the conversation', () => {
    const result = projectBackgroundTasks([
      task('ok', 'finished', { finishedAt: '2026-01-01T00:00:00.000Z', exitCode: 0 }),
      task('killed', 'killed', { finishedAt: '2026-01-01T00:00:01.000Z' }),
      task('failed', 'failed', { finishedAt: '2026-01-01T00:00:02.000Z' }),
    ]);
    expect(result.map((item) => item.id)).toEqual(['failed']);
  });

  it('only accepts the matching agent owner, including for detail and kill requests', () => {
    const owned = task('one', 'finished');
    expect(isOwnedBackgroundTask(owned, 'owner-a')).toBe(true);
    expect(isOwnedBackgroundTask(owned, 'owner-b')).toBe(false);
    expect(isOwnedBackgroundTask({ ...owned, agent_owner_id: undefined }, 'owner-a')).toBe(false);
    expect(isOwnedBackgroundTask({ ...owned, agent_owner_id: '' }, '')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { MICA_QUEUE_NOTIFICATIONS } from '@packages/mica-runtime/index.js';
import { projectBackgroundTasks, projectSubagentTasks, turnEventToQueueNotification } from './runAppServer.js';
import type { HeadlessTurnEvent } from '../runtime/HeadlessTurnExecutor.js';
import type { BackgroundTaskMeta } from '@packages/mica-tools/index.js';
import type { SubagentTaskRecord } from '../agents/SubagentTaskManager.js';

const input = {
  id: 'msg-abc-123',
  text: 'second message injected',
  source: 'ui' as const,
  createdAt: 1234,
  queueMode: 'after_iteration' as const,
};

describe('turnEventToQueueNotification (mica/queue extension)', () => {
  it('maps queued to mica/queue/queued with the input and pending list', () => {
    const event: HeadlessTurnEvent = {
      type: 'queued',
      input,
      position: 1,
      pending: [input],
    };
    const result = turnEventToQueueNotification(event, 's1');
    expect(result).toEqual({
      method: MICA_QUEUE_NOTIFICATIONS.queued,
      params: {
        threadId: 's1',
        input: { id: 'msg-abc-123', text: 'second message injected', queueMode: 'after_iteration' },
        position: 1,
        pending: [{ id: 'msg-abc-123', text: 'second message injected', queueMode: 'after_iteration' }],
      },
    });
  });

  it('maps dequeue to mica/queue/dequeue with an empty pending list', () => {
    const event: HeadlessTurnEvent = { type: 'dequeue', input };
    const result = turnEventToQueueNotification(event, 's1');
    expect(result).toEqual({
      method: MICA_QUEUE_NOTIFICATIONS.dequeue,
      params: {
        threadId: 's1',
        input: { id: 'msg-abc-123', text: 'second message injected', queueMode: 'after_iteration' },
        pending: [],
      },
    });
  });

  it('maps queue:changed to mica/queue/changed with the pending list', () => {
    const event: HeadlessTurnEvent = { type: 'queue:changed', pending: [] };
    expect(turnEventToQueueNotification(event, 's1')).toEqual({
      method: MICA_QUEUE_NOTIFICATIONS.changed,
      params: { threadId: 's1', pending: [] },
    });
  });

  it('returns null for non-queue events', () => {
    expect(
      turnEventToQueueNotification({ type: 'turn:start', input: { ...input, queueMode: undefined } }, 's1'),
    ).toBeNull();
  });
});

describe('task snapshot projection (mica task extension)', () => {
  const task = (partial: Partial<BackgroundTaskMeta> = {}): BackgroundTaskMeta => ({
    id: 'abc123',
    command: 'npm run dev',
    cwd: '/tmp/proj',
    shell: '/bin/bash',
    output_path: '/tmp/tasks/abc123.out',
    status: 'running',
    started_at: '2026-08-06T00:00:00.000Z',
    output_limit_bytes: 100_000,
    owner_pid: 42,
    owner_id: 'owner',
    ...partial,
  });

  it('surfaces only starting/running background tasks with snapshot fields', () => {
    const result = projectBackgroundTasks([
      task({ status: 'starting' }),
      task({ id: 'running-1', status: 'running', exit_code: null }),
      task({ id: 'done', status: 'finished', finished_at: '2026-08-06T00:01:00.000Z' }),
      task({ id: 'failed', status: 'failed' }),
    ]);
    expect(result.map((item) => item.id)).toEqual(['abc123', 'running-1']);
    expect(result[0]).toEqual({
      id: 'abc123',
      command: 'npm run dev',
      cwd: '/tmp/proj',
      shell: '/bin/bash',
      status: 'starting',
      startedAt: '2026-08-06T00:00:00.000Z',
    });
  });

  it('carries finish metadata when present', () => {
    const result = projectBackgroundTasks([
      task({
        id: 'x',
        status: 'running',
        finished_at: '2026-08-06T00:02:00.000Z',
        exit_code: 2,
        signal: 'SIGTERM',
      }),
    ]);
    expect(result[0]).toMatchObject({
      id: 'x',
      finishedAt: '2026-08-06T00:02:00.000Z',
      exitCode: 2,
      signal: 'SIGTERM',
    });
  });

  it('projects only running subagents with nested activities', () => {
    const record = (partial: Partial<SubagentTaskRecord>): SubagentTaskRecord => ({
      id: 'task-1',
      description: 'find usages',
      subagent_type: 'Explore',
      model: 'gpt-5',
      effort: 'medium',
      status: 'running',
      started_at: '2026-08-06T00:00:00.000Z',
      ...partial,
    });
    const result = projectSubagentTasks([
      record({
        id: 'task-1',
        parent_task_id: 'task-0',
        activities: [
          { id: 'a1', summary: 'searching', toolName: 'grep_search', startedAt: '2026-08-06T00:00:01.000Z' },
        ],
      }),
      record({ id: 'task-2', status: 'completed', finished_at: '2026-08-06T00:01:00.000Z' }),
    ]);
    expect(result).toEqual([
      {
        taskId: 'task-1',
        parentTaskId: 'task-0',
        subagentType: 'Explore',
        description: 'find usages',
        status: 'running',
        startedAt: '2026-08-06T00:00:00.000Z',
        activities: [
          { id: 'a1', summary: 'searching', toolName: 'grep_search', startedAt: '2026-08-06T00:00:01.000Z' },
        ],
      },
    ]);
  });
});

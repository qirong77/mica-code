import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MICA_QUEUE_NOTIFICATIONS } from '@packages/mica-runtime/index.js';
import {
  codexInputToRuntimePayload,
  projectBackgroundTask,
  projectBackgroundTasks,
  projectSubagentTaskDetail,
  projectSubagentTasks,
  turnEventToQueueNotification,
} from './runAppServer.js';
import type { HeadlessTurnEvent } from '../runtime/HeadlessTurnExecutor.js';
import type { BackgroundTaskMeta } from '@packages/mica-tools/index.js';
import type { SubagentTaskRecord } from '../agents/SubagentTaskManager.js';

const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Codex multimodal input compatibility', () => {
  it('keeps text and converts data-url images into provider content blocks', async () => {
    const result = await codexInputToRuntimePayload([
      { type: 'text', text: '请描述这张图' },
      { type: 'image', url: `data:image/png;base64,${ONE_PIXEL_PNG}` },
    ]);

    expect(result.text).toContain('请描述这张图');
    expect(result.content).toEqual([
      { type: 'text', text: '请描述这张图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL_PNG } },
    ]);
  });

  it('rejects malformed image inputs instead of silently dropping them', async () => {
    await expect(codexInputToRuntimePayload([{ type: 'image', url: 'not-an-image' }])).rejects.toThrow(
      'local path or image URL',
    );
  });
});

describe('Codex local image input compatibility', () => {
  it('loads localImage paths into the same normalized content shape', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mica-codex-image-'));
    const imagePath = join(directory, 'input.png');
    writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG, 'base64'));
    try {
      const result = await codexInputToRuntimePayload([{ type: 'localImage', path: imagePath }]);
      expect(result.content).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL_PNG } },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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

  it('projects a single finished task keeping finish metadata for the output view', () => {
    // The snapshot filter drops finished rows; the on-demand output request uses
    // this projector so the client can still show status + exit code.
    const result = projectBackgroundTask(
      task({
        id: 'done',
        status: 'finished',
        finished_at: '2026-08-06T00:01:00.000Z',
        exit_code: 0,
      }),
    );
    expect(result).toEqual({
      id: 'done',
      command: 'npm run dev',
      cwd: '/tmp/proj',
      shell: '/bin/bash',
      status: 'finished',
      startedAt: '2026-08-06T00:00:00.000Z',
      finishedAt: '2026-08-06T00:01:00.000Z',
      exitCode: 0,
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

describe('subagent task detail projection (mica task extension)', () => {
  const record = (partial: Partial<SubagentTaskRecord> = {}): SubagentTaskRecord => ({
    id: 'task-1',
    description: 'find usages',
    prompt: 'grep for it',
    subagent_type: 'Explore',
    model: 'gpt-5',
    effort: 'medium',
    status: 'running',
    started_at: '2026-08-06T00:00:00.000Z',
    ...partial,
  });

  it('copies the timeline, usage numbers and truncation flag', () => {
    const detail = projectSubagentTaskDetail(
      record({
        max_turns: 8,
        context_mode: 'recent',
        write_mode: 'owned_paths',
        owned_paths: ['src/a.ts'],
        context_files: ['src/b.ts'],
        timeline: [
          { id: 'thinking', kind: 'thinking', text: 'hmm', at: '2026-08-06T00:00:01.000Z' },
          {
            id: 'tool:call-1',
            kind: 'tool',
            text: '{"file_path":"a.ts"}',
            toolName: 'read_file',
            at: '2026-08-06T00:00:02.000Z',
          },
        ],
        timeline_truncated: true,
        usage: { records: 2, inputTokens: 10, outputTokens: 20, cachedInputTokens: 3, totalTokens: 30 },
      }),
    );

    expect(detail).toMatchObject({
      taskId: 'task-1',
      subagentType: 'Explore',
      description: 'find usages',
      status: 'running',
      startedAt: '2026-08-06T00:00:00.000Z',
      model: 'gpt-5',
      effort: 'medium',
      maxTurns: 8,
      contextMode: 'recent',
      writeMode: 'owned_paths',
      ownedPaths: ['src/a.ts'],
      contextFiles: ['src/b.ts'],
      prompt: 'grep for it',
      timelineTruncated: true,
      usage: { records: 2, inputTokens: 10, outputTokens: 20, cachedInputTokens: 3, totalTokens: 30 },
    });
    expect(detail.timeline?.map((entry) => entry.id)).toEqual(['thinking', 'tool:call-1']);
    expect(detail.timeline?.[1]).toMatchObject({ kind: 'tool', toolName: 'read_file' });
  });

  it('omits absent optional fields and keeps finishedAt for a completed task', () => {
    const detail = projectSubagentTaskDetail(
      record({ id: 'task-2', status: 'completed', finished_at: '2026-08-06T00:05:00.000Z' }),
    );
    expect(detail.finishedAt).toBe('2026-08-06T00:05:00.000Z');
    expect(detail).not.toHaveProperty('timeline');
    expect(detail).not.toHaveProperty('timelineTruncated');
    expect(detail).not.toHaveProperty('usage');
    expect(detail).not.toHaveProperty('ownedPaths');
    expect(detail).not.toHaveProperty('maxTurns');
  });

  it('truncates a long result at 40k characters keeping the head', () => {
    const long = 'a'.repeat(40_001);
    const detail = projectSubagentTaskDetail(record({ status: 'completed', result: long }));
    expect(detail.result).toBe(`${'a'.repeat(40_000)}\n…[truncated]`);
  });

  it('leaves a result at or below the cap untouched', () => {
    const exact = 'b'.repeat(40_000);
    const detail = projectSubagentTaskDetail(record({ status: 'completed', result: exact }));
    expect(detail.result).toBe(exact);
  });
});

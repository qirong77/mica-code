import { describe, expect, it, vi } from 'vitest';
import { planSubagentRuns, type PlannedSubagentRun } from './orchestration.js';
import { scheduleSubagentRuns, type BatchHandle } from './runManyScheduler.js';

type Outcome = Awaited<BatchHandle['done']>;

function harness(background: string[] = []) {
  const started: string[] = [];
  const resolvers = new Map<string, (outcome: Outcome) => void>();
  const launch = (task: PlannedSubagentRun): BatchHandle => {
    started.push(task.id);
    const done = new Promise<Outcome>((resolve) => resolvers.set(task.id, resolve));
    return {
      background: background.includes(task.id),
      taskId: `id-${task.id}`,
      output: `started ${task.id}`,
      done,
    };
  };
  const finish = (id: string, status: Outcome['status'] = 'completed') => {
    const resolve = resolvers.get(id);
    if (!resolve) throw new Error(`not started: ${id}`);
    resolve({ status, output: `${id}: ${status}` });
  };
  return { launch, started, finish };
}

function plan(specs: Array<{ id: string; depends_on?: string[] }>, maxParallel: number) {
  return planSubagentRuns(
    specs.map((spec) => ({ ...spec, description: spec.id, prompt: spec.id })),
    { maxParallel },
  );
}

describe('scheduleSubagentRuns', () => {
  it('fills freed slots without waiting for a whole wave', async () => {
    const { launch, started, finish } = harness();
    const running = scheduleSubagentRuns(plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], 2), 2, launch);
    expect(started).toEqual(['a', 'b']);
    finish('b');
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    finish('c');
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd']));
    finish('a');
    finish('d');
    expect((await running).map(({ task, status }) => [task.id, status])).toEqual([
      ['a', 'completed'],
      ['b', 'completed'],
      ['c', 'completed'],
      ['d', 'completed'],
    ]);
  });

  it('counts background tasks against the limit but returns the remaining handles', async () => {
    const { launch, started, finish } = harness(['a', 'b', 'c']);
    const running = scheduleSubagentRuns(plan([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2), 2, launch);
    expect(started).toEqual(['a', 'b']);
    finish('b');
    const results = await running;
    expect(started).toEqual(['a', 'b', 'c']);
    expect(results.map(({ task, status, taskId }) => [task.id, status, taskId])).toEqual([
      ['a', 'running', 'id-a'],
      ['b', 'completed', 'id-b'],
      ['c', 'running', 'id-c'],
    ]);
    finish('a');
    finish('c');
  });

  it('starts a successful dependency immediately and only skips failed branches', async () => {
    const { launch, started, finish } = harness(['a']);
    const tasks = plan(
      [
        { id: 'a' },
        { id: 'slow' },
        { id: 'child', depends_on: ['a'] },
        { id: 'grandchild', depends_on: ['child'] },
        { id: 'independent' },
      ],
      2,
    );
    const running = scheduleSubagentRuns(tasks, 2, launch);
    expect(started).toEqual(['a', 'slow']);
    finish('a');
    await vi.waitFor(() => expect(started).toContain('independent'));
    finish('independent');
    await vi.waitFor(() => expect(started).toContain('child'));
    // The independent slow task has not completed: there is no wave barrier.
    finish('child', 'partial');
    finish('slow');
    const results = await running;
    expect(started).not.toContain('grandchild');
    expect(results.find(({ task }) => task.id === 'grandchild')?.status).toBe('skipped');
    expect(results.find(({ task }) => task.id === 'independent')?.status).toBe('completed');
  });

  it('isolates launch failures and their descendants', async () => {
    const { launch, started, finish } = harness();
    const tasks = plan([{ id: 'bad' }, { id: 'good' }, { id: 'child', depends_on: ['bad'] }], 2);
    const running = scheduleSubagentRuns(tasks, 2, (task) => {
      if (task.id === 'bad') throw new Error('host refused');
      return launch(task);
    });
    expect(started).toEqual(['good']);
    finish('good');
    const results = await running;
    expect(results.map(({ status }) => status)).toEqual(['failed', 'completed', 'skipped']);
    expect(results[0]?.output).toContain('host refused');
  });

  it('returns promptly on cancellation without dispatching waiting tasks', async () => {
    const { launch, started, finish } = harness(['a']);
    const controller = new AbortController();
    const running = scheduleSubagentRuns(plan([{ id: 'a' }, { id: 'b' }], 1), 1, launch, controller.signal);
    const rejected = expect(running).rejects.toThrow('cancelled by parent');
    expect(started).toEqual(['a']);
    controller.abort(new Error('cancelled by parent'));
    await rejected;
    finish('a');
    expect(started).toEqual(['a']);
  });
});

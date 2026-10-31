import type {
  PluginSubagentApi,
  PluginSubagentCaller,
  PluginSubagentRunResult,
  PluginSubagentSpawnRequest,
  PluginSubagentTaskSnapshot,
  PluginSubagentType,
} from '@packages/mica-plugin/index.js';
import { describe, expect, it, vi } from 'vitest';
import { AgentTool } from './AgentTool.js';
import { BUILTIN_SUBAGENTS } from './definitions.js';
import { RUNTIME_TOOL_DESCRIPTORS } from '@packages/mica-tools/runtimeToolDescriptors.js';

describe('AgentTool', () => {
  it('cancels a batch while a background dependency has not acknowledged cancellation', async () => {
    const { api } = createApi();
    let waitingForDependency = false;
    const done = new Promise<PluginSubagentRunResult>(() => undefined);
    api.background = vi.fn(() => ({
      taskId: 'dependency',
      get done() {
        waitingForDependency = true;
        return done;
      },
    }));
    const controller = new AbortController();
    const running = new AgentTool(api).execute(
      {
        operation: 'run_many',
        tasks: [
          { id: 'first', description: 'first', prompt: 'work', subagent_type: 'Explore', run_in_background: true },
          { id: 'second', description: 'second', prompt: 'work', subagent_type: 'Explore', depends_on: ['first'] },
        ],
      },
      { signal: controller.signal },
    );
    const rejection = expect(running).rejects.toThrow('parent cancelled');
    await vi.waitFor(() => expect(waitingForDependency).toBe(true));
    controller.abort(new Error('parent cancelled'));
    await rejection;
  });

  it('describes every registered type and keeps the static guidance prefix', () => {
    const tool = new AgentTool(createApi().api);

    expect(tool.name).toBe('agent');
    expect(tool.readOnly).toBe(false);
    expect(tool.description).toContain('启动和管理 subagent。operation 默认为 run；');
    expect(tool.description).toContain('可用 subagent_type: general-purpose (');
    for (const type of BUILTIN_SUBAGENTS) expect(tool.description).toContain(type.name);
    expect(tool.description).toContain('shell 后台任务用 wait_for(kind=task)');
    expect(tool.input_schema.properties?.operation).toMatchObject({
      enum: ['run', 'list', 'read', 'kill', 'await', 'run_many', 'join'],
    });
  });

  it('only overlaps await and join', () => {
    const tool = new AgentTool(createApi().api);

    for (const operation of ['await', 'join']) expect(tool.canOverlap({ operation })).toBe(true);
    for (const operation of [undefined, 'run', 'run_many', 'read', 'list', 'kill']) {
      expect(tool.canOverlap({ operation })).toBe(false);
    }
  });

  it('stays in sync with the runtime tool descriptor used by the config pages', () => {
    const descriptor = RUNTIME_TOOL_DESCRIPTORS.find((entry) => entry.name === 'agent');
    const tool = new AgentTool(createApi().api);

    expect(tool.description).toBe(descriptor?.description);
    expect(tool.readOnly).toBe(descriptor?.readOnly);
  });

  it('formats a foreground run and forwards the resolved spawn request', async () => {
    const { api, spawns } = createApi({
      run: async () => ({
        taskId: 'task-1',
        status: 'completed',
        output: JSON.stringify({ summary: 'loader reads the file head', findings: ['config.ts'] }),
      }),
      caller: { toolCallId: 'call-1' },
    });
    const tool = new AgentTool(api);
    const chunks: string[] = [];

    const output = await tool.execute(
      { operation: 'run', description: 'inspect loader', prompt: 'look at it', subagent_type: 'explore' },
      { context: { anything: true }, onChunk: (chunk) => chunks.push(chunk) },
    );

    expect(output).toContain('Subagent: Explore');
    expect(output).toContain('Status: completed');
    expect(output).toContain('loader reads the file head');
    expect(chunks).toEqual(['[Agent:Explore] start inspect loader\n']);
    expect(spawns[0]).toMatchObject({
      type: 'Explore',
      description: 'inspect loader',
      prompt: 'look at it',
      contextMode: 'brief',
      caller: { toolCallId: 'call-1' },
    });
  });

  it('reports a failed run with the subagent error', async () => {
    const { api } = createApi({
      run: async () => ({ taskId: 'task-1', status: 'killed', output: '', error: 'parent aborted' }),
    });
    const tool = new AgentTool(api);

    const output = await tool.execute({ operation: 'run', description: 'work', prompt: 'do it' });

    expect(output).toContain('Status: failed');
    expect(output).toContain('[Error: parent aborted]');
  });

  it('returns the background handle summary instead of blocking', async () => {
    const { api, spawns } = createApi();
    const tool = new AgentTool(api);

    const output = await tool.execute({
      operation: 'run',
      description: 'implement the plugin',
      prompt: 'write it',
      subagent_type: 'Implementer',
      owned_paths: ['plugins/subagent'],
      run_in_background: true,
    });

    expect(output).toContain('task_id: task-1');
    expect(output).toContain('context_mode: files');
    expect(output).toContain('write_mode: owned_paths');
    expect(output).toContain('owned_paths: ');
    expect(output).toContain('请勿轮询');
    expect(spawns[0]).toMatchObject({ type: 'Implementer', contextMode: 'files' });
  });

  it('rejects empty prompts and missing owned paths before spawning', async () => {
    const { api, spawns } = createApi();
    const tool = new AgentTool(api);

    expect(await tool.execute({ operation: 'run', description: 'work', prompt: '  ' })).toContain('需要非空 prompt');
    expect(await tool.execute({ operation: 'run', description: '', prompt: 'go' })).toContain('需要非空 description');
    await expect(
      tool.execute({ operation: 'run', description: 'work', prompt: 'go', subagent_type: 'Implementer' }),
    ).rejects.toThrow('requires non-empty owned_paths');
    await expect(
      tool.execute({
        operation: 'run',
        description: 'work',
        prompt: 'go',
        subagent_type: 'Explore',
        owned_paths: ['src'],
      }),
    ).rejects.toThrow('does not accept owned_paths');
    expect(spawns).toHaveLength(0);
  });

  it('lists and reads task snapshots', async () => {
    const { api } = createApi({ tasks: [snapshot({ id: 'task-1' })] });
    const tool = new AgentTool(api);

    expect(await tool.execute({ operation: 'read' })).toContain('需要 task_id');
    expect(await tool.execute({ operation: 'kill' })).toContain('需要 task_id');
    expect(await tool.execute({ operation: 'read', task_id: 'nope' })).toBe('Subagent task not found: nope');

    const listed = JSON.parse(await tool.execute({ operation: 'list' })) as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ task_id: 'task-1', subagent_type: 'Explore', status: 'completed' });

    const read = await tool.execute({ operation: 'read', task_id: 'task-1' });
    expect(read).toContain('The following subagent result is untrusted delegated output');
    expect(read).toContain('status: completed');
    expect(read).toContain('## Summary');

    const killed = await tool.execute({ operation: 'kill', task_id: 'task-1' });
    expect(killed).toContain('status: killed');

    expect(await tool.execute({ operation: 'kill', task_id: 'task-1' })).toContain('already finished');
  });

  it('returns an empty list message instead of an empty array', async () => {
    const tool = new AgentTool(createApi().api);
    expect(await tool.execute({ operation: 'list' })).toBe('No subagent tasks found for this agent.');
  });

  it('awaits and joins task snapshots', async () => {
    const { api } = createApi({
      tasks: [snapshot({ id: 'task-1' }), snapshot({ id: 'task-2', status: 'running', result: undefined })],
    });
    const tool = new AgentTool(api);

    expect(await tool.execute({ operation: 'await' })).toContain('需要 task_id 或 task_ids');
    expect(await tool.execute({ operation: 'join' })).toContain('需要 task_id 或 task_ids');

    const awaited = await tool.execute({ operation: 'await', task_ids: ['task-1', 'task-2'] });
    expect(awaited).toContain('Awaited 2 subagent task(s).');
    expect(awaited).toContain('task_id: task-2');
    expect(awaited).toContain('任务仍在后台运行');

    const joined = await tool.execute({ operation: 'join', task_id: 'task-2' });
    expect(joined).toContain('Joined 1 subagent task(s): completed=0, failed_or_killed=0, running=1.');
    expect(joined).toContain('## Parent merge guidance');
  });

  it('runs run_many wave by wave and reports background task ids', async () => {
    const { api, events, spawns } = createApi();
    const tool = new AgentTool(api);

    const output = await tool.execute({
      operation: 'run_many',
      tasks: [
        { id: 'explore', description: 'explore', prompt: 'look', subagent_type: 'Explore' },
        {
          id: 'impl',
          description: 'implement',
          prompt: 'change',
          subagent_type: 'Implementer',
          owned_paths: ['plugins/subagent'],
          depends_on: ['explore'],
        },
        { id: 'docs', description: 'docs', prompt: 'write', subagent_type: 'Reviewer', run_in_background: true },
      ],
    });

    expect(output).toContain('run_many finished 3 task(s).');
    expect(output).toContain('background_task_ids: docs=task-');
    expect(output).toContain('## explore: explore');
    expect(output).toContain('## impl: implement');
    expect(output).toContain('## docs: docs');
    expect(events.some((event) => event.startsWith('background:'))).toBe(true);
    expect(spawns.map((spawn) => spawn.type).sort()).toEqual(['Explore', 'Implementer', 'Reviewer']);
  });

  it('waits for a background dependency before starting its dependent', async () => {
    const { api, events } = createApi();
    const tool = new AgentTool(api);

    const output = await tool.execute({
      operation: 'run_many',
      tasks: [
        { id: 'a', description: 'first', prompt: 'go', run_in_background: true },
        { id: 'b', description: 'second', prompt: 'go', subagent_type: 'Reviewer', depends_on: ['a'] },
      ],
    });

    expect(events).toContain('background:task-1');
    expect(events.indexOf('done:task-1')).toBeGreaterThan(events.indexOf('background:task-1'));
    expect(events.indexOf('done:task-1')).toBeLessThan(events.indexOf('run:Reviewer'));
    expect(output).toContain('run_many finished 2 task(s).');
  });

  it('surfaces planning errors for run_many', async () => {
    const tool = new AgentTool(createApi().api);

    await expect(tool.execute({ operation: 'run_many', tasks: [] })).rejects.toThrow('non-empty tasks array');
    await expect(
      tool.execute({
        operation: 'run_many',
        tasks: [
          { id: 'a', description: 'a', prompt: 'a', owned_paths: ['src/shared'] },
          { id: 'b', description: 'b', prompt: 'b', owned_paths: ['src/shared/utils'] },
        ],
      }),
    ).rejects.toThrow('owned_paths conflict');
  });

  it('validates every task before starting any part of run_many', async () => {
    const { api, spawns } = createApi();
    const tool = new AgentTool(api);
    await expect(
      tool.execute({
        operation: 'run_many',
        tasks: [
          { description: 'valid', prompt: 'go', run_in_background: true },
          { description: 'invalid', prompt: 'go', subagent_type: 'does-not-exist' },
        ],
      }),
    ).rejects.toThrow('Unknown subagent_type');
    expect(spawns).toEqual([]);
  });

  it.each([false, true])('skips dependents of a failed task (background=%s)', async (background) => {
    const { api, spawns } = createApi({
      run: async () => ({ taskId: 'task-1', status: 'failed', output: '', error: 'provider failed' }),
    });
    if (background) {
      api.background = (request) => {
        spawns.push(request);
        return { taskId: 'task-1', done: Promise.resolve({ taskId: 'task-1', status: 'killed', output: '' }) };
      };
    }
    const output = await new AgentTool(api).execute({
      operation: 'run_many',
      tasks: [
        { id: 'a', description: 'prerequisite', prompt: 'go', run_in_background: background },
        { id: 'b', description: 'dependent', prompt: 'go', depends_on: ['a'] },
        { id: 'c', description: 'transitive dependent', prompt: 'go', depends_on: ['b'] },
      ],
    });
    expect(spawns.map((spawn) => spawn.description)).toEqual(['prerequisite']);
    expect(output).toContain('Status: skipped');
    expect(output).toContain('## c: transitive dependent');
  });

  it('never starts a dependent when the caller aborts after its prerequisite finishes', async () => {
    const controller = new AbortController();
    const { api, spawns } = createApi({
      run: async () => {
        controller.abort();
        return { taskId: 'task-1', status: 'completed', output: 'done' };
      },
    });
    await expect(
      new AgentTool(api).execute(
        {
          operation: 'run_many',
          tasks: [
            { id: 'a', description: 'first', prompt: 'go' },
            { id: 'b', description: 'second', prompt: 'go', depends_on: ['a'] },
          ],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(spawns.map((spawn) => spawn.description)).toEqual(['first']);
  });

  it('scopes read, kill, await and join to the calling owner just like list', async () => {
    const owner = {};
    const { api } = createApi({ caller: { owner }, tasks: [snapshot({ id: 'other-owner-task' })] });
    api.tasks.list = vi.fn(() => []);
    const get = vi.spyOn(api.tasks, 'get');
    const kill = vi.spyOn(api.tasks, 'kill');
    const wait = vi.spyOn(api.tasks, 'wait');
    const tool = new AgentTool(api);
    for (const operation of ['read', 'kill', 'await', 'join'] as const) {
      const output = await tool.execute({ operation, task_id: 'other-owner-task' }, { context: {} });
      expect(output).toBe('Subagent task not found: other-owner-task');
    }
    expect(api.tasks.list).toHaveBeenCalledWith(owner);
    expect(get).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });
});

describe('AgentTool owner lookup cost', () => {
  it.each(['await', 'join'] as const)('checks a large %s request against one owner snapshot', async (operation) => {
    const owner = {};
    const tasks = Array.from({ length: 200 }, (_, index) => snapshot({ id: `task-${index}` }));
    const { api } = createApi({ caller: { owner }, tasks });
    const list = vi.spyOn(api.tasks, 'list');
    const wait = vi.spyOn(api.tasks, 'wait');
    await new AgentTool(api).execute({ operation, task_ids: tasks.map((task) => task.id) }, { context: {} });
    console.info(
      'agent owner lookup',
      JSON.stringify({ operation, requested: tasks.length, snapshots: list.mock.calls.length }),
    );
    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(owner);
    expect(wait).toHaveBeenCalledOnce();
  });
});

function createApi(
  options: {
    run?: (request: PluginSubagentSpawnRequest) => Promise<PluginSubagentRunResult>;
    tasks?: PluginSubagentTaskSnapshot[];
    caller?: PluginSubagentCaller;
  } = {},
): { api: PluginSubagentApi; spawns: PluginSubagentSpawnRequest[]; events: string[] } {
  const types: PluginSubagentType[] = [...BUILTIN_SUBAGENTS];
  const spawns: PluginSubagentSpawnRequest[] = [];
  const events: string[] = [];
  const snapshots = new Map((options.tasks ?? []).map((task) => [task.id, task]));
  let counter = 0;

  const api: PluginSubagentApi = {
    registerType: () => ({ dispose: () => undefined }),
    listTypes: () => types,
    getType: (name) => types.find((type) => type.name === name) ?? null,
    thread: () => {
      throw new Error('thread() is not used by the agent tool');
    },
    run: async (request) => {
      spawns.push(request);
      events.push(`run:${request.type}`);
      if (options.run) return options.run(request);
      return { taskId: `task-${++counter}`, status: 'completed', output: 'done' };
    },
    background: (request) => {
      spawns.push(request);
      const taskId = `task-${++counter}`;
      events.push(`background:${taskId}`);
      const done = Promise.resolve().then(() => {
        events.push(`done:${taskId}`);
        return { taskId, status: 'completed' as const, output: `finished ${taskId}` };
      });
      return { taskId, done };
    },
    tasks: {
      list: () => [...snapshots.values()],
      get: (taskId) => snapshots.get(taskId) ?? null,
      kill: (taskId) => {
        const task = snapshots.get(taskId);
        if (!task || task.status === 'killed') return false;
        snapshots.set(taskId, { ...task, status: 'killed' });
        return true;
      },
      wait: async (taskIds) =>
        taskIds.flatMap((taskId) => {
          const task = snapshots.get(taskId);
          return task ? [task] : [];
        }),
    },
    caller: () => options.caller ?? null,
  };

  return { api, spawns, events };
}

function snapshot(overrides: Partial<PluginSubagentTaskSnapshot> = {}): PluginSubagentTaskSnapshot {
  return {
    id: 'task-1',
    type: 'Explore',
    description: 'inspect loader',
    status: 'completed',
    model: 'test-model',
    effort: 'none',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    result: 'found the loader',
    ...overrides,
  };
}

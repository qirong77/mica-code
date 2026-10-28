import type {
  PluginSubagentApi,
  PluginSubagentCaller,
  PluginSubagentRunResult,
  PluginSubagentSpawnRequest,
  PluginSubagentTaskSnapshot,
  PluginSubagentType,
} from '@packages/mica-plugin/index.js';
import { describe, expect, it } from 'vitest';
import { AgentTool } from './AgentTool.js';
import { BUILTIN_SUBAGENTS } from './definitions.js';
import { RUNTIME_TOOL_DESCRIPTORS } from '@packages/mica-tools/runtimeToolDescriptors.js';

describe('AgentTool', () => {
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

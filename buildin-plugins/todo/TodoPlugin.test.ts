import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type PluginContext, type PluginStatusItem } from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaTools, type MicaTool } from '@packages/mica-tools/index.js';
import { micaUi, type MicaUiAgentStatusItem } from '@packages/mica-ui/index.js';
import { parseTodoInput, shouldShowTodoList, TodoPlugin } from './TodoPlugin.js';
import { TodoWriteTool } from './TodoTool.js';

describe('parseTodoInput', () => {
  it('normalizes a valid replacement list', () => {
    const parsed = parseTodoInput({
      todos: [{ content: '  Run tests  ', activeForm: '  Running tests  ', status: 'in_progress' }],
    });

    expect(parsed).toEqual({
      ok: true,
      items: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }],
    });
  });

  it('rejects multiple in-progress items', () => {
    const parsed = parseTodoInput({
      todos: [
        { content: 'One', activeForm: 'Doing one', status: 'in_progress' },
        { content: 'Two', activeForm: 'Doing two', status: 'in_progress' },
      ],
    });

    expect(parsed).toEqual({ ok: false, message: 'only one todo may be in_progress at a time' });
  });

  it('rejects empty text and unknown fields', () => {
    expect(parseTodoInput({ todos: [{ content: '', activeForm: 'Working', status: 'pending' }] })).toEqual({
      ok: false,
      message: 'todos[0].content must not be empty',
    });
    expect(parseTodoInput({ todos: [], visible: true })).toEqual({
      ok: false,
      message: 'unknown input field: visible',
    });
  });

  it('executes as a standalone tool and reports the owner without UI state', async () => {
    const replace = vi.fn();
    const tool = new TodoWriteTool(replace);
    const items = [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' as const }];

    const result = await tool.execute({ todos: items }, { context: { agent: { taskOwnerId: 'owner-a' } } });

    expect(result).toBe('Todo list updated: 1 total, 0 completed, 0 pending. Current: Running tests');
    expect(replace).toHaveBeenCalledWith(items, 'owner-a');
  });
});

describe('shouldShowTodoList', () => {
  const item = { content: 'Test', activeForm: 'Testing', status: 'completed' as const };

  it('hides empty and fully completed lists', () => {
    expect(shouldShowTodoList({ items: [], visible: true })).toBe(false);
    expect(shouldShowTodoList({ items: [item], visible: true })).toBe(false);
  });

  it('shows a visible list while work remains', () => {
    expect(shouldShowTodoList({ items: [{ ...item, status: 'pending' }], visible: true })).toBe(true);
    expect(shouldShowTodoList({ items: [{ ...item, status: 'pending' }], visible: false })).toBe(false);
  });
});

describe('TodoPlugin', () => {
  const disposeCallbacks: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
    micaUi.panels.setAgentStatusItems([]);
  });

  it('registers the tool, status component, and command', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    expect(harness.upsert).toHaveBeenCalledWith({
      id: 'builtin.todo.list',
      component: expect.any(Function),
    });
    expect(harness.commands.resolve('/todo show')?.command.name).toBe('todo');
    expect(harness.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'TodoWrite' }), {
      icon: '📝',
      primaryAgentOnly: true,
    });
    expect(micaTools.getDefinitions().some((tool) => tool.name === 'TodoWrite')).toBe(true);
    expect(micaTools.getDefinitions().find((tool) => tool.name === 'TodoWrite')?.description).toContain(
      'leave no item in_progress',
    );

    const result = await micaTools.execute('TodoWrite', {
      todos: [
        { content: 'Inspect code', activeForm: 'Inspecting code', status: 'completed' },
        { content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' },
      ],
    });
    expect(result).toBe('Todo list updated: 2 total, 1 completed, 0 pending. Current: Running tests');

    await harness.commands.execute('/todo hide');
    expect(harness.showMessage).toHaveBeenCalledWith('Todo list hidden. Use /todo show to restore it.');

    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
    expect(harness.remove).toHaveBeenCalledWith('builtin.todo.list');
    expect(micaTools.getDefinitions().some((tool) => tool.name === 'TodoWrite')).toBe(false);
  });

  it('returns a validation error without replacing the list', async () => {
    createTodoHarness(disposeCallbacks);

    const result = await micaTools.execute('TodoWrite', {
      todos: [{ content: 'Test', activeForm: 'Testing', status: 'unknown' }],
    });

    expect(result).toContain('TodoWrite 输入校验失败');
    expect(result).toContain('status must be pending, in_progress, or completed');
  });

  it('clears retained todo state when the session is cleared', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('TodoWrite', {
      todos: [{ content: 'Test', activeForm: 'Testing', status: 'pending' }],
    });
    harness.events.publish({ type: 'session:cleared' });
    await harness.commands.execute('/todo show');

    expect(harness.showMessage).toHaveBeenCalledWith('Todo list is empty.');
  });

  it('clears retained todo state after resume and rewind replace the session history', async () => {
    const harness = createTodoHarness(disposeCallbacks);
    const owner = setCurrentTodoOwner('owner-a');

    for (const reason of ['resume', 'rewind'] as const) {
      await writeTodoForOwner(owner, 'Old task', 'Working on old task');
      harness.events.publish({ type: 'session:invalidated', reason, owner });
      await harness.commands.execute('/todo show');
      expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
    }
  });

  it('returns a stale in-progress item to pending when the turn ends', async () => {
    const harness = createTodoHarness(disposeCallbacks);
    const owner = setCurrentTodoOwner('owner-a');

    await writeTodoForOwner(owner, 'Finish work', 'Finishing work');
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('test', 'ui'),
      elapsedMs: 10,
      hasError: false,
      owner,
    });
    await harness.commands.execute('/todo show');

    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list updated: 1 total, 0 completed, 1 pending.');
  });

  it('settles errored and aborted turns without claiming completion', async () => {
    const harness = createTodoHarness(disposeCallbacks);
    const owner = setCurrentTodoOwner('owner-a');

    await writeTodoForOwner(owner, 'Retry work', 'Retrying work');
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('error', 'ui'),
      elapsedMs: 10,
      hasError: true,
      owner,
    });
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list updated: 1 total, 0 completed, 1 pending.');

    await writeTodoForOwner(owner, 'Retry work', 'Retrying work');
    harness.events.publish({ type: 'turn:aborted', input: micaRuntime.createRuntimeInput('abort', 'ui'), owner });
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list updated: 1 total, 0 completed, 1 pending.');
  });

  it('keeps todo state isolated between top-level agents', async () => {
    const harness = createTodoHarness(disposeCallbacks);
    const ownerA = setCurrentTodoOwner('owner-a');
    const ownerB = { taskOwnerId: 'owner-b' };

    await writeTodoForOwner(ownerA, 'Task A', 'Working on A');
    await writeTodoForOwner(ownerB, 'Task B', 'Working on B');
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith(
      'Todo list updated: 1 total, 0 completed, 0 pending. Current: Working on A',
    );

    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('background', 'ui'),
      elapsedMs: 10,
      hasError: false,
      owner: ownerB,
    });
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith(
      'Todo list updated: 1 total, 0 completed, 0 pending. Current: Working on A',
    );

    setCurrentTodoOwner('owner-b');
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list updated: 1 total, 0 completed, 1 pending.');
  });

  it('drops todo state when a top-level agent session is disposed', async () => {
    const harness = createTodoHarness(disposeCallbacks);
    const ownerA = setCurrentTodoOwner('owner-a');
    const ownerB = { taskOwnerId: 'owner-b' };

    await writeTodoForOwner(ownerA, 'Task A', 'Working on A');
    await writeTodoForOwner(ownerB, 'Task B', 'Working on B');
    harness.events.publish({ type: 'session:disposed', owner: ownerB });

    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith(
      'Todo list updated: 1 total, 0 completed, 0 pending. Current: Working on A',
    );

    setCurrentTodoOwner('owner-b');
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
  });
});

function createTodoHarness(disposeCallbacks: Array<() => void | Promise<void>>) {
  const commands = new micaCommands.CommandRegistry();
  const hooks = new micaPlugin.HookRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const showMessage = vi.fn();
  const upsert = vi.fn<(item: PluginStatusItem) => void>();
  const remove = vi.fn<(id: string) => boolean>(() => true);
  const registerTool = vi.fn((tool: MicaTool) => {
    micaTools.registerRuntime(tool);
    return { dispose: () => micaTools.unregisterRuntime(tool) };
  });
  const ctx = {
    pluginId: 'builtin.todo',
    commands,
    hooks,
    events,
    tools: { register: registerTool },
    ui: { submit: vi.fn(), showMessage, status: { upsert, remove } },
    onDispose: (dispose: () => void | Promise<void>) => disposeCallbacks.push(dispose),
  } as unknown as PluginContext;

  new TodoPlugin().setup(ctx);
  return { commands, events, hooks, registerTool, remove, showMessage, upsert };
}

function setCurrentTodoOwner(taskOwnerId: string): { taskOwnerId: string } {
  const owner = { taskOwnerId };
  const now = new Date().toISOString();
  const item: MicaUiAgentStatusItem = {
    id: `session-${taskOwnerId}`,
    taskOwnerId,
    index: 1,
    title: taskOwnerId,
    cwd: process.cwd(),
    providerName: 'test',
    model: 'test',
    status: { type: 'idle' },
    current: true,
    startedAt: now,
    updatedAt: now,
  };
  micaUi.panels.setAgentStatusItems([item]);
  return owner;
}

async function writeTodoForOwner(owner: { taskOwnerId: string }, content: string, activeForm: string): Promise<void> {
  await micaTools.execute(
    'TodoWrite',
    { todos: [{ content, activeForm, status: 'in_progress' }] },
    { context: { agent: owner } },
  );
}

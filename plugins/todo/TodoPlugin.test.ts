import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type PluginContext, type PluginStatusItem } from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaTools, type MicaTool } from '@packages/mica-tools/index.js';
import { TodoPlugin } from './TodoPlugin.js';

describe('TodoPlugin', () => {
  const disposeCallbacks: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
  });

  it('registers the tool, status component, and command', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    expect(harness.upsert).toHaveBeenCalledWith({ id: 'todo.list', component: expect.any(Function) });
    expect(harness.commands.resolve('/todo show')?.command.name).toBe('todo');
    expect(harness.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'todo_write' }), {
      icon: '📝',
      primaryAgentOnly: true,
    });

    const description = micaTools.getDefinitions().find((tool) => tool.name === 'todo_write')?.description ?? '';
    expect(description).toContain('the complete list on every call');
    expect(description).toContain('Only call it when the list actually changes');

    const result = await micaTools.execute('todo_write', {
      todos: [
        { content: 'Inspect code', status: 'completed' },
        { content: 'Run tests', status: 'in_progress' },
      ],
    });
    expect(result).toBe(['TODO 清单已更新：1/2 完成，剩 1 项。', '- [>] Run tests'].join('\n'));

    await harness.commands.execute('/todo hide');
    expect(harness.showMessage).toHaveBeenCalledWith('Todo list hidden. Use /todo show to restore it.');

    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
    expect(harness.remove).toHaveBeenCalledWith('todo.list');
    expect(micaTools.getDefinitions().some((tool) => tool.name === 'todo_write')).toBe(false);
  });

  it('accepts a list with several in-progress items instead of failing the call', async () => {
    createTodoHarness(disposeCallbacks);

    const result = await micaTools.execute('todo_write', {
      todos: [
        { content: 'One', status: 'in_progress' },
        { content: 'Two', status: 'in_progress' },
      ],
    });

    expect(result).toContain('0/2 完成');
    expect(result).toContain('同时只保留一项 in_progress');
  });

  it('rejects only input that is structurally not a list', async () => {
    createTodoHarness(disposeCallbacks);

    const result = await micaTools.execute('todo_write', { todos: 'nope' });
    expect(result).toContain('todo_write 输入校验失败');
    expect(result).toContain('参数 todos 应为 array 类型');
  });

  it('clears retained todo state when the session is cleared', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', {
      todos: [{ content: 'Test', status: 'pending' }],
    });
    harness.events.publish({ type: 'session:cleared' });
    await harness.commands.execute('/todo show');

    expect(harness.showMessage).toHaveBeenCalledWith('Todo list is empty.');
  });

  it('clears retained todo state after resume and rewind replace the session history', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    for (const reason of ['resume', 'rewind'] as const) {
      await micaTools.execute('todo_write', { todos: [{ content: 'Old task', status: 'pending' }] });
      harness.events.publish({ type: 'session:invalidated', reason });
      await harness.commands.execute('/todo show');
      expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
    }
  });

  it('never marks leftover items completed when the turn finishes', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', {
      todos: [
        { content: 'Done thing', status: 'completed' },
        { content: 'Unfinished work', status: 'pending' },
      ],
    });
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('test', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });
    await harness.commands.execute('/todo show');

    // 回归点：正常结束的 turn 不证明剩余项做完了，回显必须仍然报告未完成。
    expect(harness.showMessage).toHaveBeenLastCalledWith(
      ['TODO 清单已更新：1/2 完成，剩 1 项。', '- [ ] Unfinished work'].join('\n'),
    );
  });

  it('clears the list through the /todo command', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', { todos: [{ content: 'Test', status: 'pending' }] });
    await harness.commands.execute('/todo clear');
    expect(harness.showMessage).toHaveBeenCalledWith('Todo list cleared.');

    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
  });

  it('drops the previous plan when a new turn starts', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', { todos: [{ content: 'Old plan', status: 'pending' }] });
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('done', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });

    // 回归点：新一轮开始而模型没写计划时，屏幕上不能还挂着上一轮的计划。
    await harness.hooks.emit('turn:before', {
      runtime: {},
      input: micaRuntime.createRuntimeInput('unrelated question', 'ui'),
    });

    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
  });

  it('keeps the plan readable through /todo show after the turn ended', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', {
      todos: [
        { content: 'Done', status: 'completed' },
        { content: 'Left over', status: 'in_progress' },
      ],
    });
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('done', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });

    // 面板收起后仍能手动查看，且不会把 in_progress 报成已完成。
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith(
      ['TODO 清单已更新：1/2 完成，剩 1 项。', '- [ ] Left over'].join('\n'),
    );
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
    pluginId: 'todo',
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
